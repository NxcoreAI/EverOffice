import {
  ChevronRight,
  FileText,
  FolderOpen,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useWorkspaceDocuments } from '@/components/documents/WorkspaceDocumentsProvider'
import { useLocale } from '@/i18n/LocaleContext'

import './HomePage.css'

export function HomePage({
  onNavigate,
  onFocusAgent,
}: {
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
}) {
  const { t } = useLocale()
  const { documents, documentsLoading } = useWorkspaceDocuments()
  const [currentHour, setCurrentHour] = useState(() => new Date().getHours())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentHour(new Date().getHours())
    }, 60_000)

    return () => window.clearInterval(timer)
  }, [])

  const greetingKey = currentHour >= 5 && currentHour < 12
    ? 'surface:home.goodMorning'
    : currentHour < 18
      ? 'surface:home.goodAfternoon'
      : 'surface:home.goodEvening'

  const recentDocuments = useMemo(() => (
    [...documents]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5)
  ), [documents])

  return (
    <section className="workspace-home-surface" data-testid="workspace-home-surface">
      <div className="workspace-home-inner">
        <header className="workspace-home-heading">
          <div>
            <h1>{t(greetingKey)}</h1>
          </div>
        </header>

        <div className="workspace-home-grid">
          <section className="workspace-home-quick-start">
            <div className="workspace-home-section-heading">
              <div>
                <h2>{t('surface:home.startFromHere')}</h2>
              </div>
            </div>
            <div className="workspace-quick-grid">
              <button type="button" className="workspace-quick-action" onClick={onFocusAgent}>
                <Sparkles aria-hidden="true" strokeWidth={1.8} data-tone="blue" />
                <span>{t('surface:home.askAi')}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('docs')}>
                <FileText aria-hidden="true" strokeWidth={1.8} data-tone="emerald" />
                <span>{t('surface:navigation.documents')}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('files')}>
                <FolderOpen aria-hidden="true" strokeWidth={1.8} data-tone="violet" />
                <span>{t('surface:navigation.files')}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          </section>

          <section className="workspace-home-recent">
            <header className="workspace-home-section-heading">
              <div>
                <span className="workspace-home-eyebrow">{t('surface:home.recent')}</span>
                <h2>{t('surface:home.recentlyOpened')}</h2>
              </div>
              <button type="button" className="workspace-home-link" onClick={() => onNavigate('docs')}>
                {t('surface:navigation.documents')}<ChevronRight aria-hidden="true" />
              </button>
            </header>
            <div className="workspace-home-recent-grid">
              <div className="workspace-home-list-column">
                <div className="workspace-home-list-heading">
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                  <strong>{t('surface:home.documents')}</strong>
                  <span>{recentDocuments.length}</span>
                </div>
                {documentsLoading && recentDocuments.length === 0 ? (
                  <div className="workspace-home-loading-list" aria-busy="true">
                    <i /><i /><i />
                  </div>
                ) : recentDocuments.length > 0 ? recentDocuments.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="workspace-home-list-item"
                    onClick={() => onNavigate('docs')}
                  >
                    <FileText aria-hidden="true" strokeWidth={1.8} />
                    <span>
                      <strong>{document.title || t('surface:docs.untitledDocument')}</strong>
                      <small>{t('surface:docs.type.document')}</small>
                    </span>
                    <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                  </button>
                )) : (
                  <button type="button" className="workspace-home-empty-row" onClick={() => onNavigate('docs')}>
                    <FileText aria-hidden="true" />
                    <span>{t('surface:home.noDocuments')}</span>
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
