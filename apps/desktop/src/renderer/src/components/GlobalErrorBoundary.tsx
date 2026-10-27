import * as Sentry from '@sentry/electron/renderer'
import React from 'react'

/**
 * 全局渲染错误兜底：任何残留的渲染异常此前都以白屏收场。本 Boundary 把
 * 崩溃降级为可恢复的错误页——保留两条出路：
 *   ① 重载界面（常规瞬时状态损坏）；
 *   ② 清空本地界面状态后重载（localStorage 持久化状态导致的崩溃轮回；
 *      文稿与设置都以网关/主进程为准，下次启动会重建）。
 * fallback 完全内联样式、不依赖 i18n/样式系统——Boundary 触发时它们
 * 的可用性不可信。Sentry 已在 main.tsx 初始化，此处上报；未初始化时
 * captureException 为 no-op。
 */
interface GlobalErrorBoundaryState {
  error: Error | null
}

export class GlobalErrorBoundary extends React.Component<
  { children: React.ReactNode },
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): GlobalErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info.componentStack)
    try {
      Sentry.captureException(error)
    } catch {
      // 上报失败不影响降级展示。
    }
  }

  private reload = (): void => {
    window.location.reload()
  }

  private resetLocalStateAndReload = (): void => {
    try {
      window.localStorage.clear()
    } catch {
      // localStorage 不可用时直接重载。
    }
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const detail = `${error.message ?? String(error)}\n${error.stack ?? ''}`.slice(0, 2_000)
    return (
      <div
        role="alert"
        style={{
          position: 'fixed', inset: 0, zIndex: 9_999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: '16px', padding: '32px',
          background: '#f7f8fa', color: '#1f2328', textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
        }}
      >
        <div style={{ fontSize: '40px', lineHeight: 1 }} aria-hidden="true">⚠️</div>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>界面渲染出现异常 / A rendering error occurred</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#57606a', maxWidth: '480px' }}>
          界面进入异常状态。可以先尝试重载；若重载后仍复现（通常是本地界面数据损坏），
          请使用「重置并重载」，本地界面状态会被清空并重新载入。
        </p>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            type="button"
            onClick={this.reload}
            style={{ padding: '8px 18px', fontSize: '13px', border: '1px solid #d0d7de', borderRadius: '8px', background: '#fff', cursor: 'pointer' }}
          >
            重载界面
          </button>
          <button
            type="button"
            onClick={this.resetLocalStateAndReload}
            style={{ padding: '8px 18px', fontSize: '13px', border: '1px solid #d0d7de', borderRadius: '8px', background: '#fff', color: '#b62324', cursor: 'pointer' }}
          >
            重置并重载
          </button>
        </div>
        <details style={{ maxWidth: '640px', fontSize: '12px', color: '#57606a', textAlign: 'left' }}>
          <summary style={{ cursor: 'pointer' }}>错误详情</summary>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#fff', border: '1px solid #d0d7de', borderRadius: '8px', padding: '10px', marginTop: '8px' }}>{detail}</pre>
        </details>
      </div>
    )
  }
}
