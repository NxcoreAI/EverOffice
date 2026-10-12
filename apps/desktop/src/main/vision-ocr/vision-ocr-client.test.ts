import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VisionOcrClient, resolveVisionOcrExecutable } from './vision-ocr-client'
import type { ChildProcess } from 'node:child_process'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mocked-app-path' },
}))

class FakeDaemonProcess extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & {
    write: (data: string) => boolean
    once: (event: string, listener: (...args: unknown[]) => void) => EventEmitter
  }
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  exitCode: number | null = null
  signalCode: string | null = null
  readonly writtenRequests: string[] = []
  private killed = false

  constructor() {
    super()
    this.stdin.write = (data: string) => {
      this.writtenRequests.push(data)
      return true
    }
    this.stdin.once = this.stdin.once.bind(this.stdin)
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
  }

  respond(envelope: Record<string, unknown>): void {
    this.stdout.emit('data', `${JSON.stringify(envelope)}\n`)
  }

  respondRaw(chunk: string): void {
    this.stdout.emit('data', chunk)
  }

  simulateExit(code: number | null, signal: string | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  kill(signal?: string): boolean {
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === undefined) {
      this.killed = true
      queueMicrotask(() => this.simulateExit(null, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'))
    }
    return this.killed
  }

  get killedOnce(): boolean {
    return this.killed
  }
}

function createClient(): { client: VisionOcrClient; fakes: FakeDaemonProcess[]; current: () => FakeDaemonProcess } {
  const fakes: FakeDaemonProcess[] = []
  const client = new VisionOcrClient('/mocked/vision-ocr', () => {
    const fake = new FakeDaemonProcess()
    fakes.push(fake)
    return fake as unknown as ChildProcess
  })
  return { client, fakes, current: () => fakes[fakes.length - 1]! }
}

interface WrittenRequest {
  id: string
  op: string
}

function lastRequest(fake: FakeDaemonProcess): WrittenRequest {
  const line = fake.writtenRequests.at(-1)
  if (!line) throw new Error('no request written')
  return JSON.parse(line) as WrittenRequest
}

function requestByOp(fake: FakeDaemonProcess, op: string): WrittenRequest {
  const match = fake.writtenRequests
    .map((line) => JSON.parse(line) as WrittenRequest)
    .find((request) => request.op === op)
  if (!match) throw new Error(`no request written for op ${op}`)
  return match
}

async function untilWritten(getFake: () => FakeDaemonProcess | undefined, count = 1): Promise<void> {
  await vi.waitFor(() => {
    const fake = getFake()
    if (!fake || fake.writtenRequests.length < count) {
      throw new Error(`waiting for ${String(count)} request(s)`)
    }
  }, { timeout: 3_000, interval: 10 })
}

describe('resolveVisionOcrExecutable', () => {
  const originalOverride = process.env.NXCORE_VISION_OCR_PATH
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.NXCORE_VISION_OCR_PATH
    else process.env.NXCORE_VISION_OCR_PATH = originalOverride
  })

  it('环境变量覆盖优先', () => {
    process.env.NXCORE_VISION_OCR_PATH = '/custom/vision-ocr'
    expect(resolveVisionOcrExecutable()).toBe('/custom/vision-ocr')
  })

  it('无覆盖且候选路径不存在时返回 null', () => {
    delete process.env.NXCORE_VISION_OCR_PATH
    expect(resolveVisionOcrExecutable()).toBeNull()
  })
})

describe('VisionOcrClient', () => {
  let client: VisionOcrClient
  let fakes: FakeDaemonProcess[]
  let current: () => FakeDaemonProcess

  beforeEach(() => {
    ;({ client, fakes, current } = createClient())
  })

  afterEach(async () => {
    await client.dispose()
  })

  it('ping 按 id 匹配并解析版本', async () => {
    const pending = client.ping()
    const fake = current()
    await untilWritten(() => fake)
    const request = lastRequest(fake)
    expect(request.op).toBe('ping')
    fake.respond({ id: request.id, ok: true, result: { pong: true, version: '1.0.0' } })
    await expect(pending).resolves.toBe('1.0.0')
  })

  it('并发请求按各自 id 正确分流', async () => {
    const pingPromise = client.ping()
    const frontmostPromise = client.frontmost()
    const fake = current()
    await untilWritten(() => fake, 2)
    const pingId = requestByOp(fake, 'ping').id
    const frontmostId = requestByOp(fake, 'frontmost').id
    fake.respond({ id: frontmostId, ok: true, result: { bundleId: 'com.apple.Safari', windowTitle: null } })
    fake.respond({ id: pingId, ok: true, result: { version: '2.0.0' } })
    await expect(pingPromise).resolves.toBe('2.0.0')
    await expect(frontmostPromise).resolves.toMatchObject({ bundleId: 'com.apple.Safari' })
  })

  it('跨数据块的分隔行也能解析', async () => {
    const pending = client.ping()
    const fake = current()
    await untilWritten(() => fake)
    const request = lastRequest(fake)
    fake.respondRaw(`{"id":"${request.id}","ok":tr`)
    fake.respondRaw(`ue,"result":{"version":"1.1.0"}}\n`)
    await expect(pending).resolves.toBe('1.1.0')
  })

  it('ok:false 时以助手错误信息拒绝', async () => {
    const pending = client.frontmost()
    const fake = current()
    await untilWritten(() => fake)
    const request = lastRequest(fake)
    fake.respond({ id: request.id, ok: false, error: 'cannot read image: /x.jpg' })
    await expect(pending).rejects.toThrow('cannot read image: /x.jpg')
  })

  it('daemon 退出时拒绝全部未决请求', async () => {
    const pending = client.ping()
    current()?.simulateExit(1, null)
    await expect(pending).rejects.toThrow('vision-ocr daemon exited')
  })

  it('daemon 退出后下一次调用重新拉起进程', async () => {
    const firstPing = client.ping()
    const first = current()
    await untilWritten(() => first)
    const firstRequest = lastRequest(first)
    first.respond({ id: firstRequest.id, ok: true, result: { version: '1.0.0' } })
    await firstPing

    first.simulateExit(0, null)
    const secondPing = client.ping()
    await vi.waitFor(() => {
      if (fakes.length < 2) throw new Error('waiting for respawn')
    }, { timeout: 5_000, interval: 10 })
    const second = current()
    expect(second).not.toBe(first)
    await untilWritten(() => second)
    const secondRequest = lastRequest(second)
    expect(secondRequest.id).not.toBe(firstRequest.id)
    second.respond({ id: secondRequest.id, ok: true, result: { version: '1.0.0' } })
    await expect(secondPing).resolves.toBe('1.0.0')
  }, 10_000)

  it('dispose 后请求直接拒绝', async () => {
    await client.dispose()
    await expect(client.ping()).rejects.toThrow('vision-ocr client disposed')
  })

  it('executable 缺失时 available 为 false 且请求报错', async () => {
    const missing = new VisionOcrClient(null)
    expect(missing.available).toBe(false)
    await expect(missing.ping()).rejects.toThrow('vision-ocr executable not found')
  })

  it('dispose 对运行中 daemon 发 SIGTERM 并等待退出', async () => {
    const pending = client.ping()
    const fake = current()
    await untilWritten(() => fake)
    const request = lastRequest(fake)
    fake.respond({ id: request.id, ok: true, result: { version: '1.0.0' } })
    await pending

    await client.dispose()
    expect(fake.killedOnce).toBe(true)
  })
})

const realBinaryPath = join(__dirname, '../../../build/vision-ocr/darwin-universal/vision-ocr')
const realBinaryExists = existsSync(realBinaryPath)
const fixturePath = join(__dirname, '../../../tests/fixtures/vision-ocr-sample.jpg')
const fixtureExists = existsSync(fixturePath)

describe.skipIf(!(realBinaryExists && fixtureExists))('vision-ocr 真二进制契约', () => {
  it('daemon 完成 ping 与真实 OCR', async () => {
    const client = new VisionOcrClient(realBinaryPath)
    try {
      await expect(client.ping()).resolves.toBe('1.0.0')
      const result = await client.ocr(fixturePath)
      expect(result.width).toBeGreaterThan(0)
      expect(result.lines.length).toBeGreaterThan(5)
      expect(result.lines[0]!.text).toContain('EverRoom')
    } finally {
      await client.dispose()
    }
  }, 30_000)
})
