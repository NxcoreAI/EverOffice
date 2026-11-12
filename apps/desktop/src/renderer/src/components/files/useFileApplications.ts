import { useCallback, useEffect, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { FileApplication } from '@/shared/sources'
import { showToast } from '@/state/toast'

/**
 * 「用外部应用打开」的共享状态：按 fileId 拉一次系统文件关联（主进程按扩展名
 * 缓存，多行/多卡共享一次探测），并串行化打开/定位手势。
 *
 * 关联列表为空（非 macOS、查询失败、无注册应用）时调用方应隐藏入口——
 * 本 hook 不弹错误，静默降级回原有的打开方式。
 */
export interface FileApplicationsApi {
  /** null = 仍在查询；[] = 本机没有可用的外部应用（隐藏入口）。 */
  applications: FileApplication[] | null
  busy: boolean
  /** 用指定应用打开；省略 = 系统默认应用。 */
  openWith: (application?: FileApplication) => Promise<void>
  reveal: () => Promise<void>
}

export function useFileApplications(
  fileId: string | null | undefined,
  onError?: (message: string) => void,
): FileApplicationsApi {
  const { t } = useLocale()
  const [applications, setApplications] = useState<FileApplication[] | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    setApplications(null)
    const api = window.nxcore?.files
    if (!fileId || !api?.listApplications) {
      // 旧 preload/主进程没这个通道时静默隐藏入口；只在开发期留一条线索，
      // 避免「明明改了代码但卡片没有按钮」时无从排查。
      if (fileId && import.meta.env.DEV) {
        console.warn('[open-with] files.listApplications 不可用：请重启桌面端（主进程/preload 需重新构建）')
      }
      setApplications([])
      return () => { cancelled = true }
    }
    void api.listApplications(fileId)
      .then((apps) => { if (!cancelled) setApplications(Array.isArray(apps) ? apps : []) })
      .catch(() => { if (!cancelled) setApplications([]) })
    return () => { cancelled = true }
  }, [fileId])

  const report = useCallback((key: string) => {
    const message = t(key)
    if (onError) onError(message)
    else showToast({ title: message, variant: 'error' })
  }, [onError, t])

  const openWith = useCallback(async (application?: FileApplication) => {
    if (!fileId || busyRef.current) return
    const api = window.nxcore?.files
    if (!api?.openWithApplication) {
      report('surface:files.openWithFailed')
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      // 默认应用走系统关联（与双击同一个动作）；不是默认的应用显式指定路径。
      if (application && !application.default) await api.openWithApplication(fileId, application.id)
      else await api.openWithApplication(fileId)
    } catch {
      report('surface:files.openWithFailed')
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }, [fileId, report])

  const revealFailureKey = window.nxcore?.platform === 'win32'
    ? 'surface:files.unableToRevealOriginal.windows'
    : 'surface:files.unableToRevealOriginal'
  const reveal = useCallback(async () => {
    if (!fileId) return
    const api = window.nxcore?.files
    if (!api?.reveal) {
      report(revealFailureKey)
      return
    }
    try {
      await api.reveal(fileId)
    } catch {
      report(revealFailureKey)
    }
  }, [fileId, report, revealFailureKey])

  return { applications, busy, openWith, reveal }
}