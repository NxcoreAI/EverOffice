// @vitest-environment happy-dom
/**
 * 回归：设置页「软件更新」下载安装包时必须显示文件下载进度。
 *
 * 背景：此前主进程已通过 update:progress 广播下载进度（percent + bytesPerSecond），
 * 设置页只把它压成一行 11px 小字，既没有进度条也没有完成/失败的视觉反馈，下载过程
 * 中看起来像「没反应」。这里用 happy-dom 渲染真实 UpdateSection，mock preload 的
 * updater 桥，断言准备/下载中/已下载/失败，以及失败后备源恢复这几种状态都能看见。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UpdateSection } from '../src/renderer/src/components/settings/UpdateSection'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ProgressPayload = { percent: number; bytesPerSecond: number }
type ProgressListener = (progress: ProgressPayload) => void
type DownloadedListener = (info: { version: string }) => void
type ErrorListener = (payload: { message: string }) => void

let container: HTMLDivElement
let root: Root
let progressListeners: ProgressListener[]
let downloadedListeners: DownloadedListener[]
let errorListeners: ErrorListener[]

/** 让 checkNow 的 promise、effect 里的微任务与 React 状态落定。 */
async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function queriedProgressBar(): HTMLElement | null {
  return container.querySelector('[role="progressbar"]')
}

beforeEach(async () => {
  progressListeners = []
  downloadedListeners = []
  errorListeners = []
  ;(window as unknown as { nxcore: unknown }).nxcore = {
    updater: {
      getStatus: async () => ({
        version: '0.1.2',
        channel: 'stable',
        installId: 'install-qa',
        supported: true,
        lastError: null,
      }),
      checkNow: async () => 'update-found',
      onProgress: (listener: ProgressListener) => {
        progressListeners.push(listener)
        return () => {}
      },
      onDownloaded: (listener: DownloadedListener) => {
        downloadedListeners.push(listener)
        return () => {}
      },
      onError: (listener: ErrorListener) => {
        errorListeners.push(listener)
        return () => {}
      },
    },
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // getStatus 的 promise 也在 act 内落定，避免「not wrapped in act」告警。
  await act(async () => {
    root.render(<UpdateSection />)
    await Promise.resolve()
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

async function startCheck(): Promise<void> {
  const button = container.querySelector('button.primary-button') as HTMLButtonElement
  expect(button.disabled).toBe(false)
  await act(async () => { button.click() })
  await flush()
}

describe('UpdateSection 下载进度', () => {
  it('下载前沿用原来的诊断行，不显示进度条', async () => {
    await flush()
    expect(container.textContent).toContain('当前版本 v0.1.2')
    expect(queriedProgressBar()).toBeNull()
  })

  it('开始下载后显示进度条、百分比与实时速度，下载完成转为成功提示', async () => {
    await startCheck()
    // checkNow 判定有新版本、但主进程还没回第一个 progress：先给不确定态，避免空窗。
    // 此时下载其实已开始，按钮必须禁用并显示「准备下载」，避免用户重复触发检查把进度清空。
    expect(container.textContent).toContain('发现新版本')
    expect(queriedProgressBar()?.getAttribute('data-indeterminate')).toBe('true')
    const preparingButton = container.querySelector('button.primary-button') as HTMLButtonElement
    expect(preparingButton.textContent).toContain('准备下载')
    expect(preparingButton.disabled).toBe(true)

    await act(async () => {
      for (const listener of progressListeners) listener({ percent: 42.4, bytesPerSecond: 3.2 * 1024 * 1024 })
    })

    expect(container.textContent).toContain('正在下载新版本')
    expect(container.textContent).toContain('42%')
    expect(container.textContent).toContain('3.2 MB/s')
    const bar = queriedProgressBar()
    expect(bar?.getAttribute('data-indeterminate')).toBe('false')
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
    expect((bar?.querySelector('i') as HTMLElement).style.width).toBe('42.4%')
    // 下载中按钮变「正在下载」并禁用，避免重复触发检查。
    const button = container.querySelector('button.primary-button') as HTMLButtonElement
    expect(button.textContent).toContain('正在下载')
    expect(button.disabled).toBe(true)

    await act(async () => {
      for (const listener of downloadedListeners) listener({ version: '0.1.3' })
    })

    expect(queriedProgressBar()).toBeNull()
    expect(container.textContent).toContain('新版本 0.1.3 已下载完成')
    const notice = container.querySelector('.settings-update-notice')
    expect(notice?.getAttribute('data-tone')).toBe('success')
    // 下载完成后按钮恢复可用（安装包已就绪，用户可再次检查或稍后重启）。
    const doneButton = container.querySelector('button.primary-button') as HTMLButtonElement
    expect(doneButton.textContent).toContain('检查更新')
    expect(doneButton.disabled).toBe(false)
  })

  it('下载失败显示错误详情，并撤回进度条', async () => {
    await startCheck()
    await act(async () => {
      for (const listener of errorListeners) listener({ message: 'net::ERR_CONNECTION_RESET' })
    })

    expect(queriedProgressBar()).toBeNull()
    expect(container.textContent).toContain('更新失败：net::ERR_CONNECTION_RESET')
    const notice = container.querySelector('.settings-update-notice')
    expect(notice?.getAttribute('data-tone')).toBe('error')
  })

  it('失败后备源重试收到进度，会撤回错误并按新进度显示', async () => {
    await startCheck()
    await act(async () => {
      for (const listener of errorListeners) listener({ message: 'feed down' })
    })
    expect(container.textContent).toContain('更新失败：feed down')

    await act(async () => {
      for (const listener of progressListeners) listener({ percent: 12, bytesPerSecond: 512 * 1024 })
    })

    expect(container.textContent).not.toContain('更新失败：feed down')
    expect(container.textContent).toContain('正在下载新版本')
    expect(container.textContent).toContain('12%')
    expect(container.textContent).toContain('512 KB/s')
    expect(queriedProgressBar()?.getAttribute('data-indeterminate')).toBe('false')
  })

  it('已下载完成后再次检查，成功提示不倒退成准备态', async () => {
    await startCheck()
    await act(async () => {
      for (const listener of downloadedListeners) listener({ version: '0.1.3' })
    })
    expect(container.textContent).toContain('新版本 0.1.3 已下载完成')

    const button = container.querySelector('button.primary-button') as HTMLButtonElement
    await act(async () => { button.click() })
    await flush()

    // 安装包还在磁盘上，重查期间不展示「发现新版本/准备下载」，也不隐藏完成提示。
    expect(container.textContent).toContain('新版本 0.1.3 已下载完成')
    expect(queriedProgressBar()).toBeNull()
  })
})
