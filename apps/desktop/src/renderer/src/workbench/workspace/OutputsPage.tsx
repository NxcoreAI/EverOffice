import { FolderOpen, PackageOpen, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'

import { Button, EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileLibraryLoading,
  FileLibraryUnavailable,
  FileNoMatches,
  FileToolbar,
  fileSearchText,
  isArtifactFile,
  sortFilesByUpdatedDesc,
  type FileViewMode,
  type FileFilterOption,
} from './fileBrowser'
import { type FileItemActions, revealedToastKey } from './fileItemViews'
import { folderLabel, folderOf, type LibraryRow } from './libraryTree'
import { LibraryGrid, LibraryList } from './LibraryViews'
import { useFileLibrary } from './useFileLibrary'
import './library.css'

type ArtifactFilter = 'all' | 'agent-generated' | 'artifact-imported'

/**
 * 产物页：本工作空间里 `sourceKind ∈ {agent-generated, artifact-imported}` 的文件。
 *
 * Agent 生成的产物在入库时带其会话所属的 workspaceId，产物导入按当前空间归属；
 * 本页只拉 `workspace.id` 名下的产物，与资料同一套隔离口径。
 * 点开走注入的 onOpenFile → 气泡窗。
 *
 * 列表排序 UI 与资料页一致（以资料为主）：网格/列表复用 LibraryViews 的
 * 同一套瓦片与六列表格（表头「修改时间」带倒序指示），行序同为更新时间倒序；
 * 本页多出的只是来源筛选 chips（筛选不是排序）。
 */
export function OutputsPage({ workspace, onOpenFile, onToast, onOpenPage, onNewWork }: WorkspacePageProps) {
  const { t } = useLocale()
  const library = useFileLibrary(workspace.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [view, setView] = useState<FileViewMode>('grid')

  const artifacts = useMemo(
    () => sortFilesByUpdatedDesc(library.items.filter(isArtifactFile)),
    [library.items],
  )
  const counts = useMemo(() => ({
    all: artifacts.length,
    'agent-generated': artifacts.filter((item) => item.catalog.sourceKind === 'agent-generated').length,
    'artifact-imported': artifacts.filter((item) => item.catalog.sourceKind === 'artifact-imported').length,
  }), [artifacts])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return artifacts.filter((item) => {
      if (filter !== 'all' && item.catalog.sourceKind !== filter) return false
      return !keyword || fileSearchText(item).includes(keyword)
    })
  }, [artifacts, filter, query])

  // 复用资料页的列表/网格：产物没有文件夹，全部行都是文件行，
  // 位置列与资料同口径（relativePath 派生，根目录显示「资料」）。
  const rows = useMemo(
    () => filtered.map((item): LibraryRow => ({
      kind: 'file',
      item,
      location: folderLabel(folderOf(item), t),
    })),
    [filtered, t],
  )

  const filters: ReadonlyArray<FileFilterOption<ArtifactFilter>> = [
    { key: 'all', label: t('workbench:workspace.outputs.filter.all'), count: counts.all },
    { key: 'agent-generated', label: t('workbench:workspace.outputs.filter.agent'), count: counts['agent-generated'] },
    { key: 'artifact-imported', label: t('workbench:workspace.outputs.filter.imported'), count: counts['artifact-imported'] },
  ]

  /** 在系统文件管理器中定位文件本体（mac=访达 / win=资源管理器）。 */
  const revealFile = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.reveal !== 'function') {
      onToast(t('workbench:workspace.common.desktopFileUnavailable'))
      return
    }
    try {
      await api.reveal(item.catalog.id)
      onToast(t(revealedToastKey()))
    } catch {
      onToast(t('workbench:workspace.library.toast.revealFailed'))
    }
  }

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onReveal: (item) => { void revealFile(item) },
    onError: onToast,
  }

  return (
    <div className="wb-wspage wb-outputs-page">
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">{t('workbench:workspacePage.outputs')}</h1>
        <div className="wb-file-head-actions">
          <IconButton
            label={t('workbench:workspace.outputs.refresh')}
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
            disabled={library.refreshing}
          />
          <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={() => onOpenPage('library')}>
            {t('workbench:workspace.outputs.goLibrary')}
          </Button>
        </div>
      </header>

      {library.state === 'ready' && artifacts.length > 0 ? (
        <FileToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          filter={filter}
          onFilterChange={setFilter}
          view={view}
          onViewChange={setView}
          searchPlaceholder={t('workbench:workspace.outputs.searchPlaceholder')}
          filterAriaLabel={t('workbench:workspace.outputs.filterAria')}
        />
      ) : null}

      {library.state === 'loading' ? <FileLibraryLoading /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && artifacts.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<PackageOpen size={18} />}
          title={t('workbench:workspace.outputs.empty')}
          action={(
            <Button variant="ghost" onClick={onNewWork}>
              {t('workbench:workspaceSidebar.newWork')}
            </Button>
          )}
        />
      ) : null}

      {library.state === 'ready' && artifacts.length > 0 && filtered.length === 0 ? (
        <FileNoMatches onClear={() => { setQuery(''); setFilter('all') }} />
      ) : null}

      {library.state === 'ready' && filtered.length > 0 ? (
        view === 'list' ? (
          <LibraryList rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} />
        ) : (
          <LibraryGrid rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} />
        )
      ) : null}
    </div>
  )
}
