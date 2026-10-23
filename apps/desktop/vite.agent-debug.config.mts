// Agent 调试台专用 Vite 配置（独立 dev 页面，不参与 Electron/生产打包）。
//
// - root = apps/desktop，入口 debug/agent-debug.html；
// - 自定义插件 agent-debug-gateway 在 Vite 内部中间件之前挂载：
//   · GET /@agent-debug/sources           → 列出 runtime manifest 对应的网关来源（不含 token）
//   · GET /@agent-debug/gateway/:id/*     → 同源代理到 Gateway，Node 侧注入 Bearer token
//   manifest 每次请求按 mtime 重读：Desktop 重启后端口/token 变化会自动生效。
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { IncomingMessage, ServerResponse } from 'node:http'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

interface GatewayManifest {
  pid: number
  baseUrl: string
  token: string
  startedAt: string
  version: string
}

interface ManifestCandidate {
  path: string
  label: string
}

interface SourceRecord {
  id: string
  label: string
  baseUrl: string
  version: string
  /** 只在 Node 进程里使用，绝不回传给浏览器。 */
  token: string
  path: string
}

interface ManifestCacheEntry {
  mtimeMs: number
  manifest: GatewayManifest | null
  warning: string | null
}

const manifestCache = new Map<string, ManifestCacheEntry>()

function everroomDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'EverRoom')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'EverRoom')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'EverRoom')
}

function nxcoreDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'NxCore')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'NxCore')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'NxCore')
}

/**
 * manifest 发现顺序：
 * 1. EVERROOM_AGENT_DEBUG_MANIFEST（POSIX 用 `:`、Windows 用 `;` 分隔）；
 * 2. NXCORE_DATA_DIR（缺省为 EverRoom 平台默认数据目录）下的主网关与补全网关；
 * 3. NxCore 独立网关默认数据目录（独立 `pnpm dev` 场景）；
 * 4. 仓库 .data/runtime/gateway.json。
 * 无效/缺失的候选直接跳过。
 */
function resolveManifestCandidates(): ManifestCandidate[] {
  const candidates: ManifestCandidate[] = []
  const explicit = (process.env.EVERROOM_AGENT_DEBUG_MANIFEST ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of explicit) {
    const absolute = resolve(entry)
    candidates.push({ path: absolute, label: `Manifest · ${basename(dirname(absolute))}` })
  }

  const baseDataDir = process.env.NXCORE_DATA_DIR?.trim() || everroomDataDir()
  candidates.push({ path: join(baseDataDir, 'runtime', 'gateway.json'), label: 'EverRoom 主网关' })
  candidates.push({
    path: join(baseDataDir, 'cursor-completion-service', 'runtime', 'gateway.json'),
    label: '补全服务网关',
  })

  const nxcoreDir = nxcoreDataDir()
  if (resolve(nxcoreDir) !== resolve(baseDataDir)) {
    candidates.push({ path: join(nxcoreDir, 'runtime', 'gateway.json'), label: 'NxCore 独立网关' })
  }

  candidates.push({ path: join(repoRoot, '.data', 'runtime', 'gateway.json'), label: '仓库本地网关' })

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = resolve(candidate.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseManifest(raw: string): GatewayManifest | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const manifest = value as Partial<GatewayManifest>
  if (typeof manifest.pid !== 'number' || !Number.isInteger(manifest.pid)) return null
  if (typeof manifest.baseUrl !== 'string' || !/^https?:\/\//.test(manifest.baseUrl)) return null
  if (typeof manifest.token !== 'string' || manifest.token.length === 0) return null
  if (typeof manifest.startedAt !== 'string') return null
  if (typeof manifest.version !== 'string') return null
  return {
    pid: manifest.pid,
    baseUrl: manifest.baseUrl.replace(/\/+$/, ''),
    token: manifest.token,
    startedAt: manifest.startedAt,
    version: manifest.version,
  }
}

/** 每次请求按 mtime 判断是否要重读 manifest（Runtime 重启会换端口/token）。 */
async function readManifest(candidatePath: string): Promise<ManifestCacheEntry> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(candidatePath)).mtimeMs
  } catch {
    manifestCache.delete(candidatePath)
    return { mtimeMs: 0, manifest: null, warning: null }
  }
  const cached = manifestCache.get(candidatePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached

  let entry: ManifestCacheEntry
  try {
    const raw = await readFile(candidatePath, 'utf8')
    const manifest = parseManifest(raw)
    entry = {
      mtimeMs,
      manifest,
      warning: manifest ? null : `${candidatePath} 不是有效的 Gateway runtime manifest（缺少 pid/baseUrl/token/startedAt/version）`,
    }
  } catch (error) {
    entry = {
      mtimeMs,
      manifest: null,
      warning: `${candidatePath} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  manifestCache.set(candidatePath, entry)
  return entry
}

async function collectSources(candidates: ManifestCandidate[]): Promise<{ sources: SourceRecord[]; warnings: string[] }> {
  const sources: SourceRecord[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    const entry = await readManifest(candidate.path)
    if (entry.warning) warnings.push(entry.warning)
    if (!entry.manifest) continue
    sources.push({
      id: createHash('sha1').update(resolve(candidate.path)).digest('hex').slice(0, 12),
      label: candidate.label,
      baseUrl: entry.manifest.baseUrl,
      version: entry.manifest.version,
      token: entry.manifest.token,
      path: candidate.path,
    })
  }
  return { sources, warnings }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  response.end(JSON.stringify(body))
}

function isGet(request: IncomingMessage): boolean {
  return request.method === 'GET'
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: 'method_not_allowed', message: '调试代理只支持 GET' }, { allow: 'GET' })
}

async function handleAgentDebugRequest(
  request: IncomingMessage,
  response: ServerResponse,
  candidates: ManifestCandidate[],
): Promise<void> {
  const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = parsedUrl.pathname

  if (pathname === '/@agent-debug/sources') {
    if (!isGet(request)) {
      methodNotAllowed(response)
      return
    }
    const { sources, warnings } = await collectSources(candidates)
    const payload = sources.map(({ id, label, baseUrl, version }) => ({ id, label, baseUrl, version }))
    // HTTP header 只允许 latin1：先 encodeURIComponent，页面侧 decode 后展示。
    const warningHeader = warnings.length > 0
      ? encodeURIComponent(warnings.join('；').slice(0, 800))
      : null
    sendJson(response, 200, payload, warningHeader ? { 'x-agent-debug-warning': warningHeader } : {})
    return
  }

  const proxyMatch = /^\/@agent-debug\/gateway\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!proxyMatch) {
    sendJson(response, 404, { error: 'not_found', message: `未知调试页接口：${pathname}` })
    return
  }
  if (!isGet(request)) {
    methodNotAllowed(response)
    return
  }

  const sourceId = decodeURIComponent(proxyMatch[1] ?? '')
  const restPath = proxyMatch[2] ?? '/'
  const { sources } = await collectSources(candidates)
  if (sources.length === 0) {
    sendJson(response, 503, {
      error: 'no_manifest',
      message: '未发现 Gateway runtime manifest：请先启动 EverRoom，或设置 EVERROOM_AGENT_DEBUG_MANIFEST 指向 runtime/gateway.json',
    })
    return
  }
  const source = sources.find((entry) => entry.id === sourceId)
  if (!source) {
    sendJson(response, 404, {
      error: 'unknown_source',
      message: `未知网关来源：${sourceId}（已发现 ${sources.length} 个来源，可重新加载 sources）`,
    })
    return
  }

  const targetUrl = `${source.baseUrl}${restPath}${parsedUrl.search}`
  let upstream: globalThis.Response
  try {
    upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${source.token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    sendJson(response, 502, {
      error: 'gateway_unreachable',
      message: `无法连接 Gateway ${source.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  const body = Buffer.from(await upstream.arrayBuffer())
  if (response.headersSent) return
  response.statusCode = upstream.status
  response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/** Vite 插件：必须在 Vite 内部中间件之前挂载（configureServer 里直接 use）。 */
function agentDebugGatewayPlugin(): Plugin {
  return {
    name: 'agent-debug-gateway',
    configureServer(server) {
      const candidates = resolveManifestCandidates()
      server.middlewares.use((request, response, next) => {
        if (!(request.url ?? '').startsWith('/@agent-debug/')) {
          next()
          return
        }
        void handleAgentDebugRequest(request, response, candidates).catch((error: unknown) => {
          sendJson(response, 500, {
            error: 'agent_debug_proxy_error',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      })
    },
  }
}

export default defineConfig({
  root: here,
  // 独立依赖缓存，避免和 electron-vite / 其它 mock 页面共用缓存互相覆盖。
  cacheDir: resolve(here, 'node_modules/.vite-agent-debug'),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.AGENT_DEBUG_PORT ?? 5199),
    strictPort: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve(here, 'src/renderer/src') },
  },
  plugins: [react(), agentDebugGatewayPlugin()],
  build: {
    // 与 Electron 的 out/renderer 隔离，方便单独 `vite build` 验证调试页。
    outDir: resolve(here, 'out/agent-debug'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(here, 'debug/agent-debug.html'),
    },
  },
})
