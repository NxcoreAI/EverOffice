import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'

export type VisionOcrLevel = 'accurate' | 'fast'

export interface VisionOcrLine {
  text: string
  confidence: number
  box: [number, number, number, number]
}

export interface VisionOcrResult {
  width: number
  height: number
  elapsedMs: number
  lines: VisionOcrLine[]
  compressedPath?: string
  compressedBytes?: number
}

export interface VisionFrontmostInfo {
  bundleId: string | null
  appName: string | null
  pid: number | null
  windowTitle: string | null
}

interface DaemonEnvelope {
  id?: unknown
  ok?: unknown
  result?: unknown
  error?: unknown
}

interface PendingEntry {
  resolve: (value: DaemonEnvelope) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type SpawnDaemon = (executable: string, args: string[]) => ChildProcess

const REQUEST_TIMEOUT_MS = 60_000
const CRASH_LOOP_COOLDOWN_MS = 1_000

export function resolveVisionOcrExecutable(): string | null {
  const configured = process.env.NXCORE_VISION_OCR_PATH?.trim()
  if (configured) return configured
  if (process.platform !== 'darwin') return null
  const executableName = 'vision-ocr'
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'vision-ocr', 'darwin-universal', executableName)] : []),
    join(app.getAppPath(), 'build', 'vision-ocr', 'darwin-universal', executableName),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export class VisionOcrClient {
  private daemon: ChildProcess | null = null
  private buffer = ''
  private readonly pending = new Map<string, PendingEntry>()
  private starting: Promise<ChildProcess> | null = null
  private disposed = false
  private lastSpawnAt = 0
  private lastExitAt: number | null = null

  constructor(
    private readonly executable: string | null = resolveVisionOcrExecutable(),
    private readonly spawnDaemon: SpawnDaemon = (target, args) => spawn(target, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  ) {}

  get available(): boolean {
    return this.executable !== null
  }

  async ping(): Promise<string | null> {
    const envelope = await this.request('ping')
    const result = envelope.result as { version?: unknown } | undefined
    return typeof result?.version === 'string' ? result.version : null
  }

  async ocr(imagePath: string, options?: { level?: VisionOcrLevel; compressOut?: string }): Promise<VisionOcrResult> {
    const envelope = await this.request('ocr', {
      image: imagePath,
      level: options?.level === 'fast' ? 'fast' : 'accurate',
      ...(options?.compressOut !== undefined ? { compressOut: options.compressOut } : {}),
    })
    return envelope.result as VisionOcrResult
  }

  async frontmost(): Promise<VisionFrontmostInfo> {
    const envelope = await this.request('frontmost')
    return envelope.result as VisionFrontmostInfo
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.rejectAllPending(new Error('vision-ocr client disposed'))
    const daemon = this.daemon
    this.daemon = null
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        daemon.kill('SIGKILL')
      }, 3_000)
      daemon.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      daemon.kill('SIGTERM')
    })
  }

  private async request(op: string, payload: Record<string, unknown> = {}): Promise<DaemonEnvelope> {
    const daemon = await this.ensureDaemon()
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error('vision-ocr daemon exited before request')
    }
    const stdin = daemon.stdin
    if (!stdin) throw new Error('vision-ocr daemon stdin unavailable')
    const id = randomUUID()
    return new Promise<DaemonEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`vision-ocr ${op} timed out after ${String(REQUEST_TIMEOUT_MS)}ms`))
      }, REQUEST_TIMEOUT_MS)
      // 先登记再写：写后瞬间退出的竞态由 exit 事件的 rejectAllPending 兜底
      this.pending.set(id, { resolve, reject, timer })
      const wrote = stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
      if (!wrote) stdin.once('drain', () => undefined)
    })
  }

  private async ensureDaemon(): Promise<ChildProcess> {
    if (this.disposed) throw new Error('vision-ocr client disposed')
    if (this.daemon && this.daemon.exitCode === null && this.daemon.signalCode === null) return this.daemon
    if (this.starting) return this.starting
    if (!this.executable) throw new Error('vision-ocr executable not found')
    if (this.lastExitAt !== null && Date.now() - this.lastExitAt < CRASH_LOOP_COOLDOWN_MS && this.lastSpawnAt > this.lastExitAt - 5_000) {
      await new Promise((resolve) => setTimeout(resolve, CRASH_LOOP_COOLDOWN_MS))
    }
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      let daemon: ChildProcess
      try {
        this.lastSpawnAt = Date.now()
        daemon = this.spawnDaemon(this.executable as string, ['--daemon'])
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.daemon = daemon
      this.buffer = ''
      daemon.stdout?.setEncoding('utf8')
      daemon.stdout?.on('data', (chunk: string) => this.handleStdout(chunk))
      daemon.once('exit', (code, signal) => {
        this.lastExitAt = Date.now()
        if (this.daemon === daemon) this.daemon = null
        this.rejectAllPending(new Error(`vision-ocr daemon exited (code=${String(code)} signal=${String(signal ?? 'none')})`))
      })
      daemon.once('error', (error) => {
        this.rejectAllPending(error instanceof Error ? error : new Error(String(error)))
      })
      daemon.stdin?.once('error', () => undefined)
      daemon.stderr?.setEncoding('utf8')
      daemon.stderr?.on('data', () => undefined)
      resolve(daemon)
    })
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) this.handleResponseLine(line)
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private handleResponseLine(line: string): void {
    let envelope: DaemonEnvelope
    try {
      envelope = JSON.parse(line) as DaemonEnvelope
    } catch {
      return
    }
    if (typeof envelope.id !== 'string') return
    const entry = this.pending.get(envelope.id)
    if (!entry) return
    this.pending.delete(envelope.id)
    clearTimeout(entry.timer)
    if (envelope.ok === true) entry.resolve(envelope)
    else entry.reject(new Error(typeof envelope.error === 'string' ? envelope.error : 'vision-ocr request failed'))
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}
