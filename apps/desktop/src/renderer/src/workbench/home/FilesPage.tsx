import { FolderOpen, LayoutGrid, List, RotateCw, Search, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { type FileKind, type RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { workbenchToast } from '../shell/toast'
import { cn } from '../ui/cn'
import { ConfirmModal } from '../ui/modal'
import { Button, EmptyState, PageHeader } from '../ui/primitives'
import { FileTableHead, FileTableRow, type FileRowActions } from './fileTable'
import { HomeSkeleton } from './parts'
import { useFileLibrary } from './useFileLibrary'

type ViewMode = 'list' | 'grid'
type KindFilter = 'all' | FileKind

const ALL_KINDS = 'all'
/** 一次装载的目录条数上限（`files.list` 的分页大小）：超出时页面会说明只列最近这些。 */
const LOAD_LIMIT = 200

/** 类型筛选标签的顺序与原型 `FileTable` 一致：全部 / 文档 / 表格 / 演示 / PDF / Markdown。 */
const KIND_ORDER: readonly FileKind[] = ['docx', 'xlsx', 'pptx', 'pdf', 'md']

/**
 * 所有文件页，布局照 everoffice 原型 `pages/AllFilesView.tsx` + `FileTable`：
 *
 * 页头（标题 + 「共 N 个文件」+ 导入）→ 工具行（类型标签 / 文件名搜索 / 列表·网格切换）
 * → 无外框平铺表格（表头 + 文件行：图标 / 文件名 / 修改时间 / 大小 / 操作）。
 *
 * 原型里「网格视图暂未开放」和行尾「⋯」只弹 toast；这里两者都是真功能：
 * 网格是文件瓦片，行菜单能打开文件、定位文件位置、删除。
 * 来源筛选标签是本端曾有的扩展，原型没有这一行，已按原型去除。
 */
export function FilesPage() {
  const { t } = useLocale()
  const openFileInWorkspace = useWorkbenchStore((state) => state.openFileInWorkspace)
  const files = useFileLibrary(LOAD_LIMIT)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>(ALL_KINDS)
  const [view, setView] = useState<ViewMode>('list')
  const [importing, setImporting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RealOfficeFile | null>(null)
  const [deleting, setDeleting] = useState(false)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.items.filter((item) => {
      if (kind !== ALL_KINDS && item.file.kind !== kind) return false
      return !keyword || item.file.name.toLowerCase().includes(keyword)
    })
  }, [files.items, kind, query])

  const canImport = typeof window.nxcore?.files?.pickAndImport === 'function'

  const handleImport = async () => {
    if (importing || !canImport) return
    setImporting(true)
    try {
      const outcomes = await window.nxcore!.files.pickAndImport()
      const imported = outcomes?.length ?? 0
      if (imported > 0) {
        workbenchToast(t('workbench:home.files.imported', { count: imported }))
        files.reload()
      }
    } catch (error) {
      workbenchToast(error instanceof Error && error.message ? error.message : t('workbench:home.files.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      workbenchToast(t('workbench:home.files.desktopUnavailable'))
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      workbenchToast(t('workbench:home.files.exportDone'))
    } catch {
      workbenchToast(t('workbench:home.files.exportFailed'))
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    const api = window.nxcore?.files
    if (!api || typeof api.delete !== 'function') {
      workbenchToast(t('workbench:home.files.desktopUnavailable'))
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    try {
      await api.delete(target.catalog.id)
      workbenchToast(t('workbench:home.files.deletedNamed', { name: target.file.name }))
      setPendingDelete(null)
      files.reload()
    } catch {
      workbenchToast(t('workbench:home.files.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const rowActions: FileRowActions = {
    onOpen: (item) => openFileInWorkspace(item.file),
    onExportReveal: (item) => { void exportReveal(item) },
    onDelete: (item) => setPendingDelete(item),
  }

  /** 工具行左侧的类型标签（原型 `Seg`：胶囊裸标签，不带计数徽标）。 */
  const kindTabs: Array<{ key: KindFilter; label: string }> = [
    { key: ALL_KINDS, label: t('workbench:home.files.allKinds') },
    ...KIND_ORDER.map((item) => ({ key: item as KindFilter, label: t(`workbench:home.files.filterKind.${item}`) })),
  ]

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title={t('workbench:home.files.title')}
        actions={(
          <Button
            variant="primary"
            icon={<Upload size={15} />}
            disabled={!canImport || importing}
            title={canImport ? t('workbench:home.files.importTitle') : t('workbench:home.files.importDisabledTitle')}
            onClick={() => { void handleImport() }}
          >
            {importing ? t('workbench:home.files.importing') : t('workbench:home.files.import')}
          </Button>
        )}
      />

      {files.state === 'loading' ? <HomeSkeleton rows={5} /> : null}

      {files.state === 'unavailable' ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title={t('workbench:home.files.unavailable')}
          description={t('workbench:home.files.unavailableDescription')}
          action={<Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={files.reload}>{t('workbench:home.common.retry')}</Button>}
        />
      ) : null}

      {files.state === 'ready' && files.items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title={t('workbench:home.files.emptyTitle')}
          description={t('workbench:home.files.emptyDescription')}
          action={canImport ? (
            <Button variant="primary" size="sm" icon={<Upload size={13} />} onClick={() => { void handleImport() }}>
              {t('workbench:home.files.import')}
            </Button>
          ) : null}
        />
      ) : null}

      {files.state === 'ready' && files.items.length > 0 ? (
        <div className="wb-home-filetbl">
          <div className="wb-home-filetbl-bar">
            <div className="wb-home-ft-seg" role="tablist" aria-label={t('workbench:home.files.filterAria')}>
              {kindTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={kind === tab.key}
                  className={cn('wb-home-ft-seg-btn', kind === tab.key && 'active')}
                  onClick={() => setKind(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="wb-home-ft-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label={t('workbench:home.files.searchAria')}
                placeholder={t('workbench:home.files.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  className="wb-home-ft-search-clear"
                  type="button"
                  title={t('workbench:home.files.clearTitle')}
                  aria-label={t('workbench:home.files.clearSearchAria')}
                  onClick={() => setQuery('')}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <div className="wb-home-ft-views" role="group" aria-label={t('workbench:home.files.viewAria')}>
              <button
                type="button"
                className={cn(view === 'list' && 'active')}
                title={t('workbench:home.files.listView')}
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <List size={15} />
              </button>
              <button
                type="button"
                className={cn(view === 'grid' && 'active')}
                title={t('workbench:home.files.gridView')}
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <LayoutGrid size={15} />
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="wb-home-filetbl-empty">{t('workbench:home.files.noMatch')}</div>
          ) : view === 'list' ? (
            <>
              <FileTableHead />
              {filtered.map((item) => (
                <FileTableRow key={item.file.id} item={item} actions={rowActions} iconSize={36} />
              ))}
            </>
          ) : (
            <div className="wb-home-filetbl-grid">
              <div className="wb-home-file-grid">
                {filtered.map((item) => (
                  <button
                    key={item.file.id}
                    type="button"
                    className="wb-home-file-tile"
                    title={item.file.name}
                    onClick={() => openFileInWorkspace(item.file)}
                  >
                    <FileTypeIcon kind={item.file.kind} size={38} />
                    <span className="wb-home-file-tile-name">{item.file.name}</span>
                    <span className="wb-home-file-tile-meta">
                      {[item.catalog.sourceLabel, item.file.updatedLabel].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {files.state === 'ready' && files.total > LOAD_LIMIT ? (
        <p className="wb-home-footnote">
          {t('workbench:home.files.limitNote', { limit: LOAD_LIMIT })}
        </p>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(next) => { if (!next) setPendingDelete(null) }}
        title={t('workbench:home.files.deleteTitle')}
        description={pendingDelete
          ? t('workbench:home.files.deleteDescription', { name: pendingDelete.file.name })
          : undefined}
        confirmLabel={deleting ? t('workbench:home.files.deleting') : t('workbench:home.common.delete')}
        busy={deleting}
        onConfirm={() => { void confirmDelete() }}
      />
    </div>
  )
}
