import {
  Search,
  FileSpreadsheet,
  FileText,
  FileType,
  LayoutGrid,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { WindowControls } from '@/components/WindowControls'
import { useLocale } from '@/i18n/LocaleContext'
import type { OfficePreviewKind, OfficePreviewTab } from '../../../shared/sources'

const officeTabIcons: Record<OfficePreviewKind, LucideIcon> = {
  docx: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
  pdf: FileType,
}

export function TopBar({
  officeTabs,
  activeOfficeId,
  agentOpen,
  onActivateWorkbench,
  onActivateOfficeTab,
  onCloseOfficeTab,
  onToggleAgent,
  onOpenSearch,
}: {
  officeTabs: OfficePreviewTab[]
  activeOfficeId: string | null
  agentOpen: boolean
  onActivateWorkbench: () => void
  onActivateOfficeTab: (instanceId: string) => void
  onCloseOfficeTab: (instanceId: string) => void
  onToggleAgent: () => void
  onOpenSearch: () => void
}) {
  const { t } = useLocale()
  const workbenchActive = activeOfficeId === null
  return (
    <header className="topbar">
      <div className="tabs" role="tablist" aria-label={t('surface:topBar.openPages')}>
        <div
          className="tab"
          data-active={String(workbenchActive)}
          data-page="home"
          role="tab"
          aria-label={t('surface:topBar.workspace')}
          aria-selected={workbenchActive}
        >
          <button type="button" onClick={onActivateWorkbench}>
            <LayoutGrid aria-hidden="true" strokeWidth={1.8} />
            <span>{t('surface:topBar.workspace')}</span>
            <LockKeyhole className="tab-lock" aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
        {officeTabs.map((tab) => {
          const isActive = activeOfficeId === tab.id
          const OfficeIcon = officeTabIcons[tab.kind]
          // 标签只报文件名：editable 取决于打开来源（Room 产物可编辑、文件页只读），
          // OfficePreviewTab 未携带该字段，宁可不标也不标错。
          return (
            <div
              key={tab.id}
              className="tab"
              data-active={String(isActive)}
              data-office-id={tab.id}
              role="tab"
              aria-label={tab.title}
              aria-selected={isActive}
            >
              <button type="button" onClick={() => onActivateOfficeTab(tab.id)}>
                <OfficeIcon aria-hidden="true" strokeWidth={1.8} />
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={t('surface:topBar.closeTitle', { title: tab.title })}
                onClick={() => onCloseOfficeTab(tab.id)}
              >
                <X aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="top-actions no-drag">
        <button
          type="button"
          className="icon-button"
          title={t('surface:topBar.openSearch')}
          aria-label={t('surface:topBar.openSearch')}
          onClick={onOpenSearch}
        >
          <Search aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t(agentOpen ? 'surface:topBar.collapseAgent' : 'surface:topBar.expandAgent')}
          aria-label={t(agentOpen ? 'surface:topBar.collapseAgent' : 'surface:topBar.expandAgent')}
          onClick={onToggleAgent}
        >
          {agentOpen ? <PanelRightClose aria-hidden="true" strokeWidth={1.8} /> : <PanelRightOpen aria-hidden="true" strokeWidth={1.8} />}
        </button>
        <WindowControls />
      </div>
    </header>
  )
}
