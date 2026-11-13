import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Squirrel.Mac 并发周期防护（src/main/updater.ts）：
 *
 * macOS 上 update-downloaded 事件发出时，原生 Squirrel.Mac 周期才刚被触发
 * （HTTP 代理 → 取 zip → ditto 解压 → 签名校验 → 暂存）。此窗口内任何新的
 * checkForUpdates 都会启动第二个原生周期，其例行清理（housekeeping）会删掉
 * 第一个周期正在解压的 update.* 暂存目录——线上事故表现为
 * 「ditto: Could not lstat .../update.vN6suvo/...: No such file or directory」
 * 或解压残缺导致的「code object is not signed at all」。
 *
 * 防护：JS 层 update-downloaded 之后进入 native-cycle 锁定窗口，直到原生
 * update-downloaded（electron.autoUpdater，ShipIt 暂存完成）或周期报错
 * （error 事件，允许重试）。锁定期间：
 * - 轮询 check() 静默跳过
 * - 手动 checkNow() 返回 'busy'
 * 仅 darwin 生效（Windows NSIS 无原生并发周期）。
 */

const appState = { isPackaged: true }

// 原生 autoUpdater（electron 模块导出的 Squirrel 桥）：macOS 上
// update-downloaded = ShipIt 暂存完成信号
const nativeListeners = new Map<string, Listener>()

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
    getVersion: () => '0.1.3-nightly.20261111.3',
    getPath: () => '/tmp/nxcore-test-userData',
  },
  autoUpdater: {
    on: (event: string, listener: Listener) => {
      nativeListeners.set(event, listener)
    },
  },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) },
  ipcMain: { handle: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}))

vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('no pending update file')
  },
  unlinkSync: () => {},
  writeFileSync: () => {},
}))

// verifyPendingUpdate / report 里的 fetch 在测试环境直接短路
vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })))

type Listener = (...args: unknown[]) => unknown

const listeners = new Map<string, Listener>()

const checkForUpdates = vi.fn(() => Promise.resolve({ isUpdateAvailable: true }))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (event: string, listener: Listener) => {
      // 多监听器按数组语义保留：error 事件会被业务与库同时订阅
      const key = event
      const existing = listeners.get(key)
      if (existing) {
        listeners.set(key, (...args: unknown[]) => {
          existing(...args)
          listener(...args)
        })
      } else {
        listeners.set(key, listener)
      }
    },
    checkForUpdates: () => checkForUpdates(),
    setFeedURL: vi.fn(),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    logger: null,
  },
}))

import { DesktopUpdater } from '../src/main/updater'

function emit(event: string, ...args: unknown[]): void {
  listeners.get(event)?.(...args)
}

/** 原生 Squirrel.Mac 事件（electron.autoUpdater） */
function emitNative(event: string, ...args: unknown[]): void {
  nativeListeners.get(event)?.(...args)
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let updater: DesktopUpdater | null = null

/** 启动 updater。首轮自动检查在 5s setTimeout 里，测试里不实际等待。 */
async function bootUpdater(): Promise<DesktopUpdater> {
  updater = new DesktopUpdater(null)
  void updater.start().catch(() => {})
  await flushAsync()
  return updater
}

let platformSpy: { restore: () => void } | null = null

function setPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  platformSpy = {
    restore: () => Object.defineProperty(process, 'platform', original),
  }
}

beforeEach(() => {
  vi.resetModules()
  listeners.clear()
  nativeListeners.clear()
  checkForUpdates.mockClear()
  appState.isPackaged = true
  platformSpy?.restore()
  platformSpy = null
})

afterEach(() => {
  platformSpy?.restore()
  platformSpy = null
})

describe('Squirrel.Mac native-cycle guard', () => {
  it('manual checkNow is rejected while native Squirrel cycle is in progress', async () => {
    updater = await bootUpdater()
    // 手动触发首轮检查（等价启动后 5s 的自动检查）
    await updater.checkNow()

    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    // 自动检查发现新版并完成下载：update-downloaded 触发，原生周期刚启动
    emit('update-downloaded', { version: '0.1.3-nightly.20261112.4' })
    await flushAsync()

    // 原生周期进行中（解压/校验暂存目录）——用户在设置页点「检查更新」
    const result = await updater!.checkNow()

    expect(result).toBe('busy')
    // 不得再次触发 checkForUpdates：第二个原生周期的 housekeeping
    // 会删除第一个周期正在解压的暂存目录（事故根因）
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('periodic background check is skipped while native cycle is in progress', async () => {
    updater = await bootUpdater()
    await updater.checkNow()

    emit('update-downloaded', { version: '0.1.3-nightly.20261112.4' })
    await flushAsync()

    checkForUpdates.mockClear()
    // 直接调用轮询入口（等价 4h interval 触发，不实际等待）
    await (updater as unknown as { check: () => Promise<void> }).check()

    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('guard is released when the native cycle reports an error', async () => {
    updater = await bootUpdater()
    await updater.checkNow()

    emit('update-downloaded', { version: '0.1.3-nightly.20261112.4' })
    await flushAsync()

    // 原生周期失败（如 ditto 竞争/签名校验失败）→ error 事件
    emit('error', new Error('ditto: Could not lstat ...'))
    await flushAsync()

    // 锁定解除：手动检查应真正执行而不是 busy
    const result = await updater!.checkNow()

    expect(result).toBe('update-found')
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('guard is released when the native cycle finishes staging the update', async () => {
    updater = await bootUpdater()
    await updater.checkNow()

    emit('update-downloaded', { version: '0.1.3-nightly.20261112.4' })
    await flushAsync()

    // 原生 Squirrel.Mac 暂存完成（ShipItState 就绪）
    emitNative('update-downloaded')
    await flushAsync()

    // 解锁：手动检查正常执行
    const result = await updater!.checkNow()

    expect(result).toBe('update-found')
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('guard is not engaged on non-darwin platforms', async () => {
    setPlatform('win32')
    updater = await bootUpdater()
    await updater.checkNow()

    emit('update-downloaded', { version: '0.1.3-nightly.20261112.4' })
    await flushAsync()

    // Windows 上无原生 Squirrel 周期，不锁定
    const result = await updater!.checkNow()

    expect(result).toBe('update-found')
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('guard is not engaged before update-downloaded fires', async () => {
    updater = await bootUpdater()

    // 未进入原生周期窗口：手动检查正常执行
    const result = await updater!.checkNow()

    expect(result).toBe('update-found')
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
