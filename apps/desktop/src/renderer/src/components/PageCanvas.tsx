import { FilePenLine, LoaderCircle } from 'lucide-react'

import type { OfficePreviewTab } from '../../../shared/sources'
import type { PageId } from '@/data/navigation'
import { DocFlowPage } from './docflow/DocFlowPage'
import { DocsPage } from './pages/DocsPage'
import { FilesPage } from './pages/FilesPage'
import { HomePage } from './pages/HomePage'
import { SettingsPage } from './pages/SettingsPage'
import { SourcesPage } from './pages/SourcesPage'
import { AgentStatusPage } from './pages/AgentStatusPage'
import { AgentSchedulesPage } from './pages/AgentSchedulesPage'
import { AgentConnectionsPage } from './pages/AgentConnectionsPage'
import { useLocale } from '@/i18n/LocaleContext'

export function PageCanvas({
  page,
  agentDocumentFocus,
  onNavigate,
  onFocusAgent,
  onOpenOfficePreview,
  agentFileFocus,
  onStartFullOnboarding,
  officeViewStalled = false,
}: {
  page: PageId
  agentDocumentFocus: {
    documentId: string
    blockId?: string | null
    requestId: number
  } | null
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
  onOpenOfficePreview: (tab: OfficePreviewTab) => void
  agentFileFocus?: { fileId: string; requestId: number } | null
  onStartFullOnboarding?: () => void
  /** 预览页打开后原生视图迟迟未显示（超过宽限期）：此时才值得给出「重新打开」的兜底。 */
  officeViewStalled?: boolean
}) {
  const { t } = useLocale()
  let content = null
  if (page === 'home') content = <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
  if (page === 'doc-flow') content = <DocFlowPage onNavigate={onNavigate} onOpenOfficePreview={onOpenOfficePreview} />
  if (page === 'office') content = <AgentStatusPage />
  if (page === 'office-document') {
    // 页体不承载内容：Office 文档由主进程 WebContentsView 叠在 workspace-main 上显示
    //（App 依 activeOfficeInstanceId 挂载）。原生视图就绪前先给「正在打开」，
    // 超过宽限期仍未显示才退化成「回文稿页重开」的兜底——直接摆兜底文案会让
    // 首次打开（内嵌视图冷启动）看起来像坏了。
    content = (
      <div className="page">
        <div className="doc-empty" role={officeViewStalled ? undefined : 'status'} aria-live={officeViewStalled ? undefined : 'polite'}>
          {officeViewStalled
            ? <FilePenLine aria-hidden="true" strokeWidth={1.6} />
            : <LoaderCircle className="doc-spinner" aria-hidden="true" strokeWidth={1.8} />}
          <strong>
            {t(officeViewStalled
              ? 'surface:pageCanvas.officePreviewTitle'
              : 'surface:pageCanvas.officePreviewLoadingTitle')}
          </strong>
          <small>
            {t(officeViewStalled
              ? 'surface:pageCanvas.officePreviewHint'
              : 'surface:pageCanvas.officePreviewLoadingHint')}
          </small>
          {officeViewStalled ? (
            <button type="button" className="primary-button" onClick={() => onNavigate('docs')}>
              {t('surface:pageCanvas.reopenFromDocuments')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }
  if (page === 'schedules') content = <AgentSchedulesPage />
  if (page === 'agent-connections') content = <AgentConnectionsPage />
  if (page === 'docs') {
    content = (
      <DocsPage
        focusRequest={agentDocumentFocus
          ? { documentId: agentDocumentFocus.documentId, requestId: agentDocumentFocus.requestId }
          : null}
        onNavigate={onNavigate}
      />
    )
  }
  if (page === 'sources') content = <SourcesPage />
  if (page === 'files') content = <FilesPage onNavigate={onNavigate} onOpenOfficePreview={onOpenOfficePreview} focusRequest={agentFileFocus} />
  if (page === 'settings') content = <SettingsPage onStartFullOnboarding={onStartFullOnboarding} />
  return (
    <div key={page} className="workspace-page-transition" data-page={page}>
      {content}
    </div>
  )
}