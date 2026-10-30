import { FolderOpen, PackageOpen, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { RealOfficeFile } from '@/office-proto/data'

import { Badge, Button, EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileGrid,
  FileLibraryLoading,
  FileLibraryUnavailable,
  FileList,
  FileNoMatches,
  FileToolbar,
  fileSearchText,
  isArtifactFile,
  sortFilesByUpdatedDesc,
  type FileItemActions,
  type FileViewMode,
  type FileFilterOption,
} from './fileBrowser'
import { useFileLibrary, FILE_LIBRARY_LIMIT } from './useFileLibrary'
import './library.css'

type ArtifactFilter = 'all' | 'agent-generated' | 'artifact-imported'

/**
 * 产物页：本工作空间里 `sourceKind ∈ {agent-generated, artifact-imported}` 的文件。
 *
 * Agent 生成的产物在入库时带其会话所属的 workspaceId，产物导入按当前空间归属；
 * 本页只拉 `workspace.id` 名下的产物，与资料库同一套隔离口径。
 * 点开走注入的 onOpenFile → 气泡窗。
 */
export function OutputsPage({ workspace, onOpenFile, onToast, onOpenPage, onNewWork }: WorkspacePageProps) {
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

  const filters: ReadonlyArray<FileFilterOption<ArtifactFilter>> = [
    { key: 'all', label: '全部产物', count: counts.all },
    { key: 'agent-generated', label: 'Agent 生成', count: counts['agent-generated'] },
    { key: 'artifact-imported', label: '产物导入', count: counts['artifact-imported'] },
  ]

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      onToast('桌面端文件能力不可用')
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      onToast('已导出到「下载/EverRoom」并定位到文件管理器')
    } catch {
      onToast('导出失败，请稍后重试')
    }
  }

  const openOriginal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.openOriginal !== 'function') {
      onToast('桌面端文件能力不可用')
      return
    }
    try {
      const result = await api.openOriginal(item.catalog.id, item.catalog.originalName, item.catalog.contentHash)
      if (result.openedWith === 'office') onToast(`已在内置 Office 预览中打开「${item.file.name}」`)
      else onToast('已用系统默认应用打开')
    } catch {
      onToast('打开失败，请稍后重试')
    }
  }

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
  }

  const countLabel = library.state === 'ready' ? `本空间产物 ${artifacts.length} 个` : '本空间产物'
  const showCapNote = library.state === 'ready' && library.total > FILE_LIBRARY_LIMIT

  return (
    <div className="wb-wspage wb-outputs-page">
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">产物</h1>
        <Badge tone="neutral">{countLabel}</Badge>
        <div className="wb-file-head-actions">
          <IconButton
            label="刷新产物"
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
            disabled={library.refreshing}
          />
          <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={() => onOpenPage('library')}>
            去资料库
          </Button>
        </div>
        <p className="wb-wspage-sub">
          「{workspace.name}」里由 Agent 生成（agent-generated）或作为产物导入（artifact-imported）的文件，按更新时间倒序；
          Agent 产物归属其会话所在的工作空间，各空间互不可见。
        </p>
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
          searchPlaceholder="搜索产物名称或路径"
          filterAriaLabel="产物来源筛选"
        />
      ) : null}

      {showCapNote ? (
        <p className="wb-file-note">
          本空间文件库共 {library.total} 个文件；产物取自最近 {FILE_LIBRARY_LIMIT} 条中的 Agent 生成 / 产物导入文件，
          更早的产物暂未加载。
        </p>
      ) : null}

      {library.state === 'loading' ? <FileLibraryLoading label="正在读取产物…" /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && artifacts.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<PackageOpen size={18} />}
          title="还没有产物"
          description="Agent 生成或作为产物导入的文件会出现在这里。也可以先去资料库整理/导入文件，或新建一个工作让 Agent 产出。"
          action={(
            <div className="wb-file-empty-actions">
              <Button variant="primary" icon={<FolderOpen size={15} />} onClick={() => onOpenPage('library')}>去资料库</Button>
              <Button variant="ghost" onClick={onNewWork}>新建工作</Button>
            </div>
          )}
        />
      ) : null}

      {library.state === 'ready' && artifacts.length > 0 && filtered.length === 0 ? (
        <FileNoMatches onClear={() => { setQuery(''); setFilter('all') }} />
      ) : null}

      {library.state === 'ready' && filtered.length > 0 ? (
        view === 'list' ? (
          <FileList items={filtered} actions={actions} />
        ) : (
          <FileGrid items={filtered} actions={actions} />
        )
      ) : null}

      {library.state === 'ready' && artifacts.length > 0 ? (
        <p className="wb-file-footnote">显示 {filtered.length} / {artifacts.length} 个产物</p>
      ) : null}
    </div>
  )
}
