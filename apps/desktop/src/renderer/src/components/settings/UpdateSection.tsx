import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

interface UpdateStatus {
  version: string
  channel: 'stable' | 'nightly'
  installId: string
  supported: boolean
  lastError: string | null
}
type CheckResult = 'update-found' | 'no-update' | 'busy' | 'error'
type UpdateNotice = { tone: 'muted' | 'success' | 'error'; text: string }
interface DownloadProgress {
  percent: number
  bytesPerSecond: number
}

/** 下载速度按可读单位显示。主进程刚开下载时还没采样到速度（<=0），此时不显示。 */
function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

/**
 * 单点决定状态提示文案。优先级：失败 > 已下载 > 环境限制 > 检查结果 > 上次诊断错误。
 * 进度块显示期间不渲染提示行，所以这里不必关心 downloading。
 */
function resolveNotice(input: {
  updateError: string | null
  downloaded: string | null
  supported: boolean | undefined
  result: CheckResult | null
  checking: boolean
  lastError: string | null
}): UpdateNotice | null {
  if (input.updateError) return { tone: 'error', text: `更新失败：${input.updateError}` }
  if (input.downloaded) return { tone: 'success', text: `新版本 ${input.downloaded} 已下载完成，按弹窗提示重启生效` }
  if (input.supported === false) return { tone: 'muted', text: '开发模式不支持更新检查' }
  if (input.result === 'no-update') return { tone: 'muted', text: '已是最新版本' }
  if (input.result === 'error') return { tone: 'error', text: '检查失败，请稍后重试' }
  // busy = 主进程里已有另一个手动检查在跑，给个反馈但不禁用按钮，方便稍后重试。
  if (input.checking || input.result === 'busy') return { tone: 'muted', text: '正在检查…' }
  if (input.lastError) return { tone: 'error', text: `最近一次更新检查失败：${input.lastError}` }
  return null
}

/** 设置页「软件更新」区块：手动检查 + 安装包下载进度 + 更新诊断信息。 */
export function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloaded, setDownloaded] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)

  useEffect(() => { void window.nxcore?.updater?.getStatus().then(setStatus).catch(() => setStatus(null)) }, [])
  useEffect(() => {
    const offProgress = window.nxcore?.updater?.onProgress(next => {
      setProgress(next)
      // 主源失败切备源重试后进度会重新出现，此时清掉上一轮的失败提示。
      setUpdateError(null)
    })
    const offDownloaded = window.nxcore?.updater?.onDownloaded(info => {
      setDownloaded(info.version)
      setProgress(null)
      setUpdateError(null)
    })
    // 下载/校验/安装失败实时显示：此前错误被主进程吞掉，界面永远停在「正在下载」
    const offError = window.nxcore?.updater?.onError(payload => { setUpdateError(payload.message); setProgress(null) })
    return () => { offProgress?.(); offDownloaded?.(); offError?.() }
  }, [])

  const check = async () => {
    if (checking) return
    setChecking(true)
    setResult('busy')
    setProgress(null)
    // 已下载的安装包仍在磁盘上，重查期间保留「已下载完成」提示，避免状态倒退。
    setUpdateError(null)
    try {
      setResult(await (await window.nxcore?.updater?.checkNow()) ?? 'error')
    } catch {
      setResult('error')
    } finally {
      setChecking(false)
    }
  }

  const downloading = progress !== null
  // checkNow 已判定「有新版本」但第一个字节还没到：先给准备态，免得界面空着。
  const preparing = result === 'update-found' && !downloading && !downloaded && !updateError
  const showProgress = downloading || preparing
  const busy = checking || showProgress

  const notice = resolveNotice({
    updateError,
    downloaded,
    supported: status?.supported,
    result,
    checking,
    lastError: status?.lastError ?? null,
  })

  const percent = progress && Number.isFinite(progress.percent)
    ? Math.min(100, Math.max(0, progress.percent))
    : null
  const speedText = progress ? formatSpeed(progress.bytesPerSecond) : ''
  const buttonLabel = downloading ? '正在下载' : showProgress ? '准备下载' : checking ? '正在检查' : '检查更新'

  return (
    <section id="settings-update" className="reality-settings-section settings-anchor-section" aria-labelledby="update-settings-title">
      <header>
        <span><RefreshCw aria-hidden="true" /></span>
        <div>
          <h2 id="update-settings-title">软件更新</h2>
        </div>
      </header>
      <div className="reality-setting-row">
        <div>
          <strong>当前版本 {status ? `v${status.version}` : '—'}</strong>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => void check()}
          disabled={busy || status?.supported === false}
        >
          <RefreshCw aria-hidden="true" className={busy ? 'spin' : undefined} />
          {buttonLabel}
        </button>
      </div>
      {showProgress ? (
        <div className="reality-setting-row settings-update-progress-row">
          <div className="settings-update-progress">
            <div className="settings-update-progress-head">
              <strong aria-live="polite" aria-atomic="true">
                {downloading ? '正在下载新版本' : '发现新版本'}
              </strong>
              <span className="settings-update-percent">
                {percent !== null ? `${Math.round(percent)}%` : '准备下载…'}
              </span>
            </div>
            <div
              className="settings-update-progress-track"
              role="progressbar"
              aria-label="安装包下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent !== null ? Math.round(percent) : undefined}
              data-indeterminate={String(percent === null)}
            >
              <i aria-hidden="true" style={percent !== null ? { width: `${percent}%` } : undefined} />
            </div>
            <small>
              {downloading
                ? [speedText, '下载完成后按弹窗提示重启'].filter(Boolean).join(' · ')
                : '正在准备下载，完成后会弹窗提示重启'}
            </small>
          </div>
        </div>
      ) : notice ? (
        <div className="reality-setting-row">
          <small className="settings-update-notice" data-tone={notice.tone} role="status">{notice.text}</small>
        </div>
      ) : null}
    </section>
  )
}
