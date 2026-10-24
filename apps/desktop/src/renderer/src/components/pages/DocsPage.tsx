import { FileText, FolderOpen, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useWorkspaceDocuments } from '@/components/documents/WorkspaceDocumentsProvider'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { PageHeader } from './PageHeader'

function formatDocumentTime(iso: string, locale: AppLocale, t: Translate): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diffMs = Date.now() - time
  const diffMinutes = Math.floor(diffMs / 60_000)
  if (diffMinutes < 1) return t('surface:docs.justNow')
  if (diffMinutes < 60) return t('surface:docs.countMinutesAgo', { count: diffMinutes })
  if (diffMinutes < 60 * 24) return t('surface:docs.countHoursAgo', { count: Math.floor(diffMinutes / 60) })
  if (diffMinutes < 60 * 24 * 2) return t('surface:docs.yesterday')
  return new Date(time).toLocaleString(locale, {
    year: diffMs > 365 * 24 * 3600_000 ? 'numeric' : undefined,
    month: 'numeric',
    day: 'numeric',
  })
}

/**
 * 文稿库（P0-2c）：直接消费工作区文稿清单（`documents.list(null)` + 工作区订阅），
 * 不再按 Room 分组、也不再列 Room 产物。行只做「定位」——Agent 建好/改动文稿后会
 * 带着 documentId 跳到本页，这里按 `focusRequest` 高亮对应行。
 */
export function DocsPage({
  focusRequest,
  onNavigate,
}: {
  focusRequest?: { documentId: string; requestId: number } | null
  onNavigate: (page: PageId) => void
}) {
  const { locale, t } = useLocale()
  const { documents, documentsLoading } = useWorkspaceDocuments()
  const [search, setSearch] = useState('')
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const keyword = search.trim().toLowerCase()
  const visibleDocuments = useMemo(() => (
    keyword
      ? documents.filter((document) => (document.title || t('surface:docs.untitledDocument')).toLowerCase().includes(keyword))
      : documents
  ), [documents, keyword, t])

  const focusedDocumentId = focusRequest?.documentId ?? null
  useEffect(() => {
    if (!focusedDocumentId) return
    rowRefs.current.get(focusedDocumentId)?.scrollIntoView({ block: 'nearest' })
  }, [focusedDocumentId, focusRequest?.requestId])

  return (
    <div className="page doc-page">
      <PageHeader title={t('surface:docs.documents')} />
      <div className="doc-toolbar">
        <label className="doc-search">
          <Search aria-hidden="true" strokeWidth={1.8} />
          <input
            type="search"
            value={search}
            placeholder={t('surface:docs.searchDocumentTitles')}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {documentsLoading ? (
        <div className="doc-list" aria-busy="true" aria-label={t('surface:docs.loadingDocuments')}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="doc-row doc-row-skeleton" aria-hidden="true">
              <span className="item-icon"><FileText strokeWidth={1.8} /></span>
              <span className="doc-skeleton-copy">
                <i className="doc-skeleton-line" style={{ width: `${46 + (index % 3) * 12}%` }} />
                <i className="doc-skeleton-line short" />
              </span>
            </div>
          ))}
        </div>
      ) : visibleDocuments.length === 0 ? (
        <div className="doc-empty">
          <FolderOpen aria-hidden="true" strokeWidth={1.6} />
          <strong>{t(keyword ? 'surface:docs.noMatchingDocuments' : 'surface:docs.noDocuments')}</strong>
          {keyword ? <small>{t('surface:docs.tryAnotherSearch')}</small> : null}
          <button type="button" className="primary-button" onClick={() => onNavigate('home')}>
            {t('surface:navigation.home')}
          </button>
        </div>
      ) : (
        <div className="doc-list">
          {visibleDocuments.map((document) => {
            const focused = document.id === focusedDocumentId
            return (
              <div
                key={document.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(document.id, node)
                  else rowRefs.current.delete(document.id)
                }}
                className="doc-row"
                data-focused={focused ? 'true' : undefined}
                aria-current={focused ? 'true' : undefined}
              >
                <span className="item-icon">
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                </span>
                <span>
                  <strong>{document.title || t('surface:docs.untitledDocument')}</strong>
                  <small>{[
                    t('surface:docs.type.document'),
                    document.version ? `v${document.version}` : null,
                  ].filter((part): part is string => Boolean(part)).join(' · ')}</small>
                </span>
                <time>{formatDocumentTime(document.updatedAt, locale, t)}</time>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
