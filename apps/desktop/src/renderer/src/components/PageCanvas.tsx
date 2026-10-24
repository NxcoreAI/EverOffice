import { FilePenLine } from 'lucide-react'

import type { OfficePreviewTab } from '../../../shared/sources'
import type { PageId } from '@/data/navigation'
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
}) {
  const { t } = useLocale()
  let content = null
  if (page === 'home') content = <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
  if (page === 'office') content = <AgentStatusPage />
  if (page === 'office-document') {
    // 页体不承载内容：Office 文档由主进程 WebContentsView 叠在 workspace-main 上显示
    //（App 依 activeOfficeInstanceId 挂载）；PageCanvas 拿不到实例状态，所以只留兜底空态，
    // 不硬编码「正在加载」假装进度。原生视图未就绪时给一条回文稿页重开的出口。
    content = (
      <div className="page">
        <div className="doc-empty">
          <FilePenLine aria-hidden="true" strokeWidth={1.6} />
          <strong>{t('surface:pageCanvas.officePreviewTitle')}</strong>
          <small>{t('surface:pageCanvas.officePreviewHint')}</small>
          <button type="button" className="primary-button" onClick={() => onNavigate('docs')}>
            {t('surface:pageCanvas.reopenFromDocuments')}
          </button>
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