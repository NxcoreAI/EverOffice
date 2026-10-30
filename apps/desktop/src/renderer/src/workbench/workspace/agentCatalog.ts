/**
 * 工作空间「智能体」页的数据层：真实桥数据归一 + 本机偏好持久化。
 *
 * 真实来源：
 * - `window.nxcore.agent.getStatus()`：主 Agent / 内置 Agent 状态（全局，不按空间）
 * - `window.nxcore.agent.discoverLocalAgents()`：本机 CLI Agent（全局，不按空间）
 * - `window.nxcore.mcp.listServers()`：MCP 服务配置（全局）
 *
 * 没有后端归属的两块数据（「本空间启用的智能体」与「经验便签」）按 workspace.id
 * 存在 localStorage：只在本机生效、不上传、不跟随账号，UI 上必须如实说明。
 *
 * 归一函数一律接受 `unknown`：真实桥、浏览器 mock（形状可能不同）与桥缺失都可能
 * 传进来，任何异常形状都要降级成空列表而不是让页面崩掉。
 */

import type { LocalAgentStatus } from '@nxcore/agent-contract'

import type { BadgeTone } from '../ui/primitives'

/* ───────────────── 通用取值工具 ───────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 桥返回值既可能是数组，也可能是 `{agents: [...]}`（浏览器 mock 就是后者）。 */
function asArrayPayload(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  const nested = record?.[key]
  return Array.isArray(nested) ? nested : []
}

/* ───────────────── 本机 Agent ───────────────── */

/** 本机 Agent 展示用状态（比 contract 多一个「当前没检测到」）。 */
export type DiscoveredAgentStatus = LocalAgentStatus | 'unknown'

export interface DiscoveredAgent {
  id: string
  displayName: string
  provider: string
  status: DiscoveredAgentStatus
  callable: boolean
  version: string | null
  skillCount: number
  error: string | null
}

const LOCAL_AGENT_STATUSES: readonly LocalAgentStatus[] = [
  'discovered',
  'verified',
  'history_available',
  'unavailable',
]

export const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  custom: '自定义',
}

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return '未知渠道'
  return PROVIDER_LABELS[provider] ?? provider
}

export const LOCAL_AGENT_STATUS_META: Record<DiscoveredAgentStatus, { label: string; tone: BadgeTone }> = {
  verified: { label: '可用', tone: 'success' },
  history_available: { label: '可用 · 有历史', tone: 'success' },
  discovered: { label: '已发现', tone: 'accent' },
  unavailable: { label: '不可用', tone: 'danger' },
  unknown: { label: '未检测到', tone: 'neutral' },
}

/** 把 `agent.discoverLocalAgents()` 的任意形状归一成稳定列表。 */
export function normalizeDiscoveredAgents(raw: unknown): DiscoveredAgent[] {
  const seen = new Set<string>()
  const agents: DiscoveredAgent[] = []
  for (const item of asArrayPayload(raw, 'agents')) {
    const record = asRecord(item)
    const id = asString(record?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const rawStatus = asString(record?.status)
    const installed = asBoolean(record?.installed)
    let status: DiscoveredAgentStatus = 'discovered'
    if (rawStatus && (LOCAL_AGENT_STATUSES as readonly string[]).includes(rawStatus)) {
      status = rawStatus as LocalAgentStatus
    } else if (installed === true) {
      status = 'verified'
    } else if (installed === false) {
      status = 'unavailable'
    }
    const callable = asBoolean(record?.callable)
      ?? (status === 'verified' || status === 'history_available')
    const card = asRecord(record?.card)
    const skills = card?.skills
    const version = asString(record?.version) ?? asString(record?.executablePath)
    agents.push({
      id,
      displayName: asString(record?.displayName) ?? asString(record?.name) ?? id,
      provider: asString(record?.provider) ?? 'custom',
      status,
      callable,
      version,
      skillCount: Array.isArray(skills) ? skills.length : 0,
      error: asString(record?.error),
    })
  }
  return agents
}

/* ───────────────── 主 Agent 状态 ───────────────── */

export interface MainAgentView {
  id: string
  name: string
  state: 'idle' | 'running' | 'error'
  activeRunCount: number
}

export interface MainAgentStatusView {
  /** 桥没有返回真实快照（如浏览器 mock 兜底对象）时为 false，页面只能显示「状态不可用」。 */
  available: boolean
  total: number
  running: number
  idle: number
  error: number
  agents: MainAgentView[]
  generatedAt: string | null
}

const EMPTY_MAIN_AGENT_STATUS: MainAgentStatusView = {
  available: false,
  total: 0,
  running: 0,
  idle: 0,
  error: 0,
  agents: [],
  generatedAt: null,
}

/** 把 `agent.getStatus()` 的任意形状归一成看板可渲染的状态。 */
export function normalizeMainAgentStatus(raw: unknown): MainAgentStatusView {
  const record = asRecord(raw)
  if (!record) return EMPTY_MAIN_AGENT_STATUS
  const summary = asRecord(record.summary)
  const agentRows = Array.isArray(record.agents) ? record.agents : []
  const total = asNumber(summary?.total)
  if (total === null && agentRows.length === 0) return EMPTY_MAIN_AGENT_STATUS

  const agents: MainAgentView[] = []
  for (const item of agentRows) {
    const agent = asRecord(item)
    const id = asString(agent?.agentId) ?? asString(agent?.id)
    if (!id) continue
    const state = asString(agent?.state)
    agents.push({
      id,
      name: asString(agent?.name) ?? id,
      state: state === 'running' || state === 'error' ? state : 'idle',
      activeRunCount: asNumber(agent?.activeRunCount) ?? 0,
    })
  }

  return {
    available: true,
    total: total ?? agents.length,
    running: asNumber(summary?.running) ?? agents.filter((agent) => agent.state === 'running').length,
    idle: asNumber(summary?.idle) ?? agents.filter((agent) => agent.state === 'idle').length,
    error: asNumber(summary?.error) ?? agents.filter((agent) => agent.state === 'error').length,
    agents,
    generatedAt: asString(record.generatedAt),
  }
}

/* ───────────────── MCP 服务 ───────────────── */

export interface McpServerView {
  name: string
  command: string | null
  url: string | null
  lifecycle: string | null
  disabled: boolean
}

export interface McpServersView {
  servers: McpServerView[]
  configPath: string | null
}

/** 把 `mcp.listServers()` 的 `{configPath, servers: Record<name, def>}` 归一成列表。 */
export function normalizeMcpServers(raw: unknown): McpServersView {
  const record = asRecord(raw)
  if (!record) return { servers: [], configPath: null }
  const source = record.servers
  const rows: Array<[string | null, unknown]> = Array.isArray(source)
    ? source.map((item) => [asString(asRecord(item)?.name), item])
    : source && typeof source === 'object'
      ? Object.entries(source as Record<string, unknown>)
      : []

  const servers: McpServerView[] = []
  for (const [key, item] of rows) {
    const def = asRecord(item)
    const name = key ?? asString(def?.name)
    if (!name) continue
    const args = Array.isArray(def?.args)
      ? def.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    const command = asString(def?.command)
    servers.push({
      name,
      command: command ? [command, ...args].join(' ') : null,
      url: asString(def?.url),
      lifecycle: asString(def?.lifecycle),
      disabled: def?.disabled === true,
    })
  }
  return { servers, configPath: asString(record.configPath) }
}

/* ───────────────── 本机偏好：本空间启用的智能体 ───────────────── */

/** localStorage 键前缀（按空间隔离；同空间的多个标签页共享）。 */
export const ENABLED_AGENTS_STORAGE_PREFIX = 'everroom:workspace:agents:'
/** 经验便签的 localStorage 键前缀。 */
export const AGENT_NOTES_STORAGE_PREFIX = 'everroom:workspace:agent-notes:'

export function enabledAgentsStorageKey(workspaceId: string): string {
  return `${ENABLED_AGENTS_STORAGE_PREFIX}${workspaceId}`
}

export function agentNotesStorageKey(workspaceId: string): string {
  return `${AGENT_NOTES_STORAGE_PREFIX}${workspaceId}`
}

export interface EnabledAgent {
  id: string
  displayName: string
  provider: string
  /** 本机偏好里的启停；关闭后仍保留在列表里，方便重新打开。 */
  enabled: boolean
  addedAt: string
}

function normalizeEnabledAgents(raw: unknown): EnabledAgent[] {
  if (!Array.isArray(raw)) return []
  const result: EnabledAgent[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const record = asRecord(item)
    const id = asString(record?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      displayName: asString(record?.displayName) ?? id,
      provider: asString(record?.provider) ?? 'custom',
      enabled: record?.enabled !== false,
      addedAt: asString(record?.addedAt) ?? new Date().toISOString(),
    })
  }
  return result
}

/** 读取本空间启用的智能体；localStorage 不可用/内容损坏时返回空列表。 */
export function readEnabledAgents(workspaceId: string): EnabledAgent[] {
  try {
    const raw = localStorage.getItem(enabledAgentsStorageKey(workspaceId))
    if (!raw) return []
    return normalizeEnabledAgents(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 写入本空间启用的智能体；返回是否成功（隐私模式/localStorage 被禁时 false）。 */
export function writeEnabledAgents(workspaceId: string, agents: readonly EnabledAgent[]): boolean {
  try {
    localStorage.setItem(enabledAgentsStorageKey(workspaceId), JSON.stringify(agents))
    return true
  } catch {
    return false
  }
}

/** 追加发现到的智能体（已存在则刷新名称/渠道，不改变启停）。 */
export function mergeEnabledAgents(
  existing: readonly EnabledAgent[],
  incoming: ReadonlyArray<Pick<DiscoveredAgent, 'id' | 'displayName' | 'provider'>>,
): EnabledAgent[] {
  const next = [...existing]
  for (const agent of incoming) {
    const index = next.findIndex((item) => item.id === agent.id)
    if (index >= 0) {
      next[index] = { ...next[index], displayName: agent.displayName, provider: agent.provider }
      continue
    }
    next.push({
      id: agent.id,
      displayName: agent.displayName,
      provider: agent.provider,
      enabled: true,
      addedAt: new Date().toISOString(),
    })
  }
  return next
}

/* ───────────────── 本机偏好：经验便签 ───────────────── */

export interface AgentNote {
  id: string
  text: string
  createdAt: string
}

export const MAX_NOTE_LENGTH = 500

/** 读取本空间的经验便签；损坏内容降级为空列表。 */
export function readAgentNotes(workspaceId: string): AgentNote[] {
  try {
    const raw = localStorage.getItem(agentNotesStorageKey(workspaceId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const notes: AgentNote[] = []
    for (const item of parsed) {
      const record = asRecord(item)
      const text = asString(record?.text)
      if (!text) continue
      notes.push({
        id: asString(record?.id) ?? createLocalId(),
        text,
        createdAt: asString(record?.createdAt) ?? new Date().toISOString(),
      })
    }
    return notes
  } catch {
    return []
  }
}

export function writeAgentNotes(workspaceId: string, notes: readonly AgentNote[]): boolean {
  try {
    localStorage.setItem(agentNotesStorageKey(workspaceId), JSON.stringify(notes))
    return true
  } catch {
    return false
  }
}

/** 本地唯一 id（便签用；不依赖 crypto.randomUUID，旧渲染环境也能跑）。 */
export function createLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ───────────────── 三步引导：导入结果归一 ───────────────── */

export interface ImportOutcomeView {
  filename: string
  ok: boolean
  skipped: boolean
  error: string | null
}

/**
 * 把 `files.pickAndImport()` 的返回值归一成逐文件结果。
 * 真实返回 `FileImportOutcome[]`；浏览器 mock/桥异常可能返回对象，一律降级为空。
 */
export function normalizeImportOutcomes(raw: unknown): ImportOutcomeView[] {
  if (!Array.isArray(raw)) return []
  const outcomes: ImportOutcomeView[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const filename = asString(record.filename) ?? asString(record.originalName) ?? '未命名文件'
    const error = asString(record.error)
    const skippedReason = asString(record.skippedReason)
    const hasFileId = typeof record.fileId === 'string' && record.fileId.length > 0
    const ok = !error && (hasFileId || Boolean(skippedReason))
    outcomes.push({
      filename,
      ok,
      skipped: Boolean(skippedReason) || record.deduped === true,
      error,
    })
  }
  return outcomes
}

export interface ImportSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
}

export function summarizeImportOutcomes(outcomes: readonly ImportOutcomeView[]): ImportSummary {
  return outcomes.reduce<ImportSummary>(
    (summary, outcome) => ({
      total: summary.total + 1,
      succeeded: summary.succeeded + (outcome.ok ? 1 : 0),
      failed: summary.failed + (outcome.ok ? 0 : 1),
      skipped: summary.skipped + (outcome.skipped ? 1 : 0),
    }),
    { total: 0, succeeded: 0, failed: 0, skipped: 0 },
  )
}

/* ───────────────── 错误文案 ───────────────── */

/** 桥抛出的错误转成可读文案（Electron 的 invoke 错误带 Error.message）。 */
export function bridgeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
