/**
 * 文件关联应用服务：macOS「打开方式」枚举 + 用外部应用打开。
 *
 * 这里锁的契约：
 * ① JXA 输出严格校验、同应用多副本按 bundle+名称折叠（默认优先 → 最高版本）；
 * ② 查询按扩展名缓存且并发合并，失败降级为空列表（界面隐藏入口而不是报错）；
 * ③ 打开指定应用前重新查 handler，不在系统注册列表里的路径一律拒绝；
 * ④ 非 macOS 不查询、不渲染入口，仍保留默认打开链路。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  compareVersions,
  dedupeMacApplications,
  FileApplicationsService,
  parseMacApplications,
  toFileApplications,
  type FileApplicationCommandRunner,
  type NativeFileApplication,
} from '../src/main/files/file-applications'

const PNG_ICON = 'data:image/png;base64,AAAA'

function app(over: Partial<NativeFileApplication> & { id: string }): NativeFileApplication {
  return {
    name: `${over.id.split('/').pop()}`,
    default: false,
    icon: PNG_ICON,
    bundle: null,
    version: null,
    ...over,
  }
}

let workDirectory: string
let filePath: string

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'everroom-file-apps-'))
  filePath = join(workDirectory, '报告.docx')
  await writeFile(filePath, 'docx')
})

afterEach(async () => {
  await rm(workDirectory, { recursive: true, force: true })
})

function fakeRunner(output: unknown, overrides: {
  handlersOutput?: unknown
} = {}): { run: FileApplicationCommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    if (command === '/usr/bin/osascript') {
      const wantsHandlers = args[args.length - 1] === 'handlers'
      return { stdout: JSON.stringify(wantsHandlers && overrides.handlersOutput !== undefined ? overrides.handlersOutput : output) }
    }
    return { stdout: '' }
  }) as unknown as FileApplicationCommandRunner
  return { run, calls }
}

function darwinService(run: FileApplicationCommandRunner, options: { cacheTtlMs?: number; now?: () => number } = {}) {
  return new FileApplicationsService({
    platform: 'darwin',
    run,
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}

describe('parseMacApplications', () => {
  it('接受合法条目并保留 bundle/version/icon', () => {
    const [entry] = parseMacApplications([{
      id: '/Applications/WPS Office.app',
      name: 'WPS Office.app',
      default: true,
      icon: PNG_ICON,
      bundle: 'com.kingsoft.wpsoffice.mac',
      version: '12.1.0',
    }])
    expect(entry).toMatchObject({
      id: '/Applications/WPS Office.app',
      name: 'WPS Office.app',
      default: true,
      icon: PNG_ICON,
      bundle: 'com.kingsoft.wpsoffice.mac',
      version: '12.1.0',
    })
  })

  it('icon=null 合法；坏 data URL / 缺字段 / 非数组整批拒绝', () => {
    expect(parseMacApplications([{ id: '/a.app', name: 'a', default: false, icon: null }])[0]?.icon).toBeNull()
    expect(() => parseMacApplications([{ id: '/a.app', name: 'a', default: false, icon: 'javascript:alert(1)' }]))
      .toThrow()
    expect(() => parseMacApplications([{ id: '', name: 'a', default: false, icon: null }])).toThrow()
    expect(() => parseMacApplications([{ id: '/a.app', name: 'a', icon: null }])).toThrow()
    expect(() => parseMacApplications('nope')).toThrow()
  })
})

describe('dedupeMacApplications', () => {
  it('同 bundle+名称的更新副本折叠：默认优先，否则最高版本；位置保持首次出现处', () => {
    const apps = [
      app({ id: '/Applications/Work.app', name: 'Work.app', bundle: 'com.work', version: '1.0', default: false }),
      app({ id: '/Applications/WPS.app', name: 'WPS Office.app', bundle: 'com.kingsoft', version: '12.0' }),
      app({ id: '/Applications/Work.app.installing.2', name: 'Work.app', bundle: 'com.work', version: '1.2' }),
      app({ id: '/Applications/WPS.app', name: 'WPS Office.app', bundle: 'com.kingsoft', version: '12.1' }),
    ]
    const deduped = dedupeMacApplications(apps)
    expect(deduped.map((entry) => entry.id)).toEqual([
      '/Applications/Work.app.installing.2',
      '/Applications/WPS.app',
    ])
  })

  it('有默认副本时保留默认（即便版本更低）', () => {
    const deduped = dedupeMacApplications([
      app({ id: '/Applications/Default.app', name: 'Default.app', bundle: 'com.def', version: '1.0', default: true }),
      app({ id: '/Applications/Default.app.installing', name: 'Default.app', bundle: 'com.def', version: '9.9' }),
    ])
    expect(deduped.map((entry) => entry.id)).toEqual(['/Applications/Default.app'])
  })

  it('无 bundle id 的条目原样保留（不与其它条目合并）', () => {
    const deduped = dedupeMacApplications([
      app({ id: '/Applications/A.app', name: 'A.app', bundle: null }),
      app({ id: '/Applications/A.app', name: 'A.app', bundle: null }),
    ])
    expect(deduped).toHaveLength(2)
  })
})

describe('compareVersions / toFileApplications', () => {
  it('按数值比较点分版本，缺失版本最低', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0)
    expect(compareVersions('2', '2.0.0')).toBe(0)
    expect(compareVersions(null, '0')).toBeLessThan(0)
    expect(compareVersions(null, null)).toBe(0)
  })

  it('展示条目只保留 id/name/default/icon', () => {
    expect(toFileApplications([
      app({ id: '/a.app', name: 'A.app', bundle: 'com.a', version: '1.0', default: true }),
    ])).toEqual([{ id: '/a.app', name: 'A.app', default: true, icon: PNG_ICON }])
  })
})

describe('FileApplicationsService.applicationsFor', () => {
  it('macOS 查询一次并返回折叠后的展示列表', async () => {
    const { run, calls } = fakeRunner([
      app({ id: '/Applications/WorkBuddy.app', name: 'WorkBuddy.app', bundle: 'com.tencent.workbuddy.mac', version: '5.9.0', default: true }),
      app({ id: '/Applications/Xcode.app', name: 'Xcode.app', bundle: 'com.apple.dt.Xcode', version: '26.6' }),
    ])
    const service = darwinService(run)

    await expect(service.applicationsFor(filePath)).resolves.toEqual([
      { id: '/Applications/WorkBuddy.app', name: 'WorkBuddy.app', default: true, icon: PNG_ICON },
      { id: '/Applications/Xcode.app', name: 'Xcode.app', default: false, icon: PNG_ICON },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('/usr/bin/osascript')
    expect(calls[0]!.args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
    expect(calls[0]!.args.at(-2)).toBe(filePath)
    expect(calls[0]!.args.at(-1)).toBe('icons')
  })

  it('同扩展名的第二个文件命中缓存；过期后重新查询', async () => {
    let now = 1_000
    const { run, calls } = fakeRunner([
      app({ id: '/Applications/Xcode.app', name: 'Xcode.app', bundle: 'com.apple.dt.Xcode', default: true }),
    ])
    const service = darwinService(run, { cacheTtlMs: 100, now: () => now })
    const otherPath = join(workDirectory, '另一份.docx')
    await writeFile(otherPath, 'docx')

    await service.applicationsFor(filePath)
    await service.applicationsFor(otherPath)
    expect(calls).toHaveLength(1)

    now += 101
    await service.applicationsFor(otherPath)
    expect(calls).toHaveLength(2)
  })

  it('并发查询同一扩展名只跑一次 osascript', async () => {
    const { run, calls } = fakeRunner([
      app({ id: '/Applications/Xcode.app', name: 'Xcode.app', bundle: 'com.apple.dt.Xcode', default: true }),
    ])
    const service = darwinService(run)
    const concurrentPath = join(workDirectory, '并发.docx')
    await writeFile(concurrentPath, 'docx')
    const [first, second] = await Promise.all([
      service.applicationsFor(filePath),
      service.applicationsFor(concurrentPath),
    ])
    expect(first).toEqual(second)
    expect(calls).toHaveLength(1)
  })

  it('查询失败降级为空列表：外部入口隐藏但文件本身仍可打开', async () => {
    const run = vi.fn(async () => {
      throw new Error('osascript failed')
    }) as unknown as FileApplicationCommandRunner
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const service = darwinService(run)
      await expect(service.applicationsFor(filePath)).resolves.toEqual([])
    } finally {
      warning.mockRestore()
    }
  })

  it('非 macOS 返回空列表且不执行任何命令', async () => {
    const { run, calls } = fakeRunner([])
    const service = new FileApplicationsService({ platform: 'win32', run })
    await expect(service.applicationsFor(filePath)).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('拒绝空路径/相对路径/不存在的文件', async () => {
    const { run } = fakeRunner([])
    const service = darwinService(run)
    await expect(service.applicationsFor('')).rejects.toThrow('文件路径为空')
    await expect(service.applicationsFor('relative.docx')).rejects.toThrow('绝对路径')
    await expect(service.applicationsFor(join(workDirectory, 'missing.docx'))).rejects.toThrow('文件不存在')
  })
})

describe('FileApplicationsService.openWith', () => {
  it('省略应用 = 交给系统默认应用（open <path>）', async () => {
    const { run, calls } = fakeRunner([])
    const service = darwinService(run)
    await expect(service.openWith(filePath)).resolves.toBe('default')
    expect(calls).toEqual([{ command: '/usr/bin/open', args: [filePath] }])
  })

  it('指定已注册应用：先查 handler 校验，再 open -a <app> <path>', async () => {
    const handlers = [app({ id: '/Applications/WPS Office.app', name: 'WPS Office.app', bundle: 'com.kingsoft', default: true })]
    const { run, calls } = fakeRunner(handlers)
    const service = darwinService(run)

    await expect(service.openWith(filePath, '/Applications/WPS Office.app')).resolves.toBe('application')
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['/usr/bin/osascript', 'handlers'],
      ['/usr/bin/open', filePath],
    ])
    expect(calls[1]!.args).toEqual(['-a', '/Applications/WPS Office.app', filePath])
  })

  it('未注册应用 / 相对应用路径直接拒绝，不启动任何进程', async () => {
    const handlers = [app({ id: '/Applications/WPS Office.app', name: 'WPS Office.app', bundle: 'com.kingsoft' })]
    const { run, calls } = fakeRunner(handlers)
    const service = darwinService(run)

    await expect(service.openWith(filePath, '/Applications/Evil.app')).rejects.toThrow('未注册')
    await expect(service.openWith(filePath, 'Evil.app')).rejects.toThrow('不合法')
    expect(calls.filter((call) => call.command === '/usr/bin/open')).toEqual([])
  })

  it('非 macOS / 文件不存在时拒绝（不会退回任意启动）', async () => {
    const { run } = fakeRunner([])
    const windowsService = new FileApplicationsService({ platform: 'win32', run })
    await expect(windowsService.openWith(filePath)).rejects.toThrow('暂不支持')
    const macService = darwinService(run)
    await expect(macService.openWith(join(workDirectory, 'missing.docx'), '/Applications/WPS.app')).rejects.toThrow('文件不存在')
  })
})