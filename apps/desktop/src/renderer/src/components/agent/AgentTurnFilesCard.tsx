import { Cloud } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { FileGlyphIcon } from '@/office-proto/pages/parts'
import { FileOpenWithControl } from '@/components/files/FileOpenWithControl'
import { dispatchOpenCloudDocument } from '@/workbench/shell/openAgentFile'

import type { AgentTurnCloudDocument, AgentTurnOfficeFile, AgentTurnFiles } from './agentTurnFiles'

function originLabel(origin: AgentTurnOfficeFile['origin'], format: string, t: ReturnType<typeof useLocale>['t']): string {
  if (origin === 'exported') return t('surface:agentChat.turnFileExported', { format: format.toUpperCase() })
  return t('surface:agentChat.turnFileCreated', { format: format.toUpperCase() })
}

/** 同一文件在请求未返回前不重复发起（连点 / 重渲染触发的二次调用）。 */
const openingIds = new Set<string>()

async function openTurnFile(file: AgentTurnOfficeFile, onError: (message: string) => void): Promise<void> {
  const api = window.nxcore?.files
  if (!api?.openOriginal) {
    onError('surface:agentChat.turnFileOpenUnavailable')
    return
  }
  if (openingIds.has(file.fileEntryId)) return
  openingIds.add(file.fileEntryId)
  try {
    // 与资料库 / 产物库 / 首页文件三个入口对齐：带上 contentHash，主进程就不必
    // 每次读盘重算；catalog 取不到时仍由主进程兜底（effectiveHash 回退 hashFileBytes）。
    let contentHash: string | undefined
    try {
      contentHash = (await api.catalogEntry?.(file.fileEntryId))?.contentHash ?? undefined
    } catch {
      contentHash = undefined
    }
    const result = await api.openOriginal(file.fileEntryId, file.name, contentHash, { editable: true })
    // openedWith === 'external' 表示已交给系统默认应用打开，属正常结果，不报错。
    if (result.openedWith === 'external') {
      console.info('[agent] 文件已交给系统默认应用打开', { fileEntryId: file.fileEntryId })
    }
  } catch (error) {
    console.warn('[agent] 打开文件失败', { fileEntryId: file.fileEntryId, error })
    onError('surface:agentChat.turnFileOpenFailed')
  } finally {
    openingIds.delete(file.fileEntryId)
  }
}

/** 云文档卡：点击派发窗口事件，由当前激活的工作空间标签在气泡窗里打开编辑器。 */
function openTurnCloudDocument(file: AgentTurnCloudDocument): void {
  dispatchOpenCloudDocument({ documentId: file.documentId, title: file.title })
}

/**
 * 「本轮产生的文件」卡条：DSH 产物卡语义——assistant 正文下方按产生顺序列出
 * 本轮生成的关键文件，点击打开可编辑视图。数据来自工具结果（见 agentTurnFiles.ts），
 * 与时间线/进度卡互补：时间线讲过程，这里给最终产物的落点。
 *
 * 文件库产物右侧带分体控件（默认应用图标 + 下拉）：主按钮用系统默认应用打开，
 * 下拉列出本机注册的打开应用（默认项标注「（默认）」）并保留文件定位；点击卡片
 * 本体仍走应用内预览，两条路径互不影响。
 *
 * 云文档产物（`document_write_commit`）没有文件库条目，不挂外部应用控件；
 * 点击即在工作空间侧栏编辑器里打开对应文稿。
 */
export function AgentTurnFilesCard({ files, onOpenError }: { files: AgentTurnFiles; onOpenError?: (message: string) => void }) {
  const { t } = useLocale()
  if (files.length === 0) return null
  const reportError = (key: string) => {
    const message = t(key)
    if (onOpenError) onOpenError(message)
    else showToast({ title: message })
  }
  return (
    <div className="agent-turn-files" role="list" aria-label={t('surface:agentChat.turnFilesLabel')}>
      {files.map((file) => file.kind === 'cloud-doc' ? (
        <div
          key={`cloud-doc:${file.documentId}`}
          role="listitem"
          className="agent-turn-file-shell is-cloud-document"
        >
          <button
            type="button"
            className="agent-turn-file"
            title={t('surface:agentChat.turnFileOpenTitle', { name: file.title })}
            onClick={() => openTurnCloudDocument(file)}
          >
            <span className="agent-turn-file-icon is-cloud-document" aria-hidden="true">
              <Cloud size={20} />
            </span>
            <span className="agent-turn-file-copy">
              <strong>{file.title}</strong>
              <small>{t('surface:agentChat.turnCloudDocument')}</small>
            </span>
          </button>
        </div>
      ) : (
        <div key={file.fileEntryId} role="listitem" className="agent-turn-file-shell">
          <button
            type="button"
            className="agent-turn-file"
            title={t('surface:agentChat.turnFileOpenTitle', { name: file.name })}
            onClick={() => void openTurnFile(file, reportError)}
          >
            <span className="agent-turn-file-icon" aria-hidden="true">
              <FileGlyphIcon kind={file.format} size={28} />
            </span>
            <span className="agent-turn-file-copy">
              <strong>{file.name}</strong>
              <small>{originLabel(file.origin, file.format, t)}</small>
            </span>
          </button>
          <FileOpenWithControl fileId={file.fileEntryId} fileName={file.name} onError={reportError} />
        </div>
      ))}
    </div>
  )
}
