import { FolderOpen, PackageOpen, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { RoomDocument } from '@nxcore/agent-contract'

import { useLocale } from '@/i18n/LocaleContext'
import { cloudDocumentToOfficeFile, cloudDocumentTitle, type RealOfficeFile } from '@/office-proto/data'

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
import { type FileItemActions } from './fileItemViews'
import { cloudDocRows, folderLabel, folderOf, sortCloudDocsByUpdatedDesc, type LibraryRow } from './libraryTree'
import { LibraryGrid, LibraryList } from './LibraryViews'
import { useCloudDocuments } from './useCloudDocuments'
import { useFileLibrary } from './useFileLibrary'
import './library.css'

type ArtifactFilter = 'all' | 'agent-generated' | 'artifact-imported' | 'cloud-doc'

/**
 * 产物页：本工作空间里 `sourceKind ∈ {agent-generated, artifact-imported}` 的文件，
 * 加上网关 documents 表的工作空间云文档（Agent 用 document_write_* 链路生成的文稿）。
 *
 * 文件产物在入库时带其会话所属的 workspaceId，产物导入按当前空间归属；
 * 云文档同样按 workspaceId 归属（documents-workspaces 索引）。两者按更新时间
 * 倒序混排；筛选 chips 里「云文档」单独一类。
 * 点开走注入的 onOpenFile → 气泡窗（云文档转伪文件进 CloudDocumentEditor）。
 */
export function OutputsPage({ workspace, onOpenFile, onToast, onOpenPage, onNewWork }: WorkspacePageProps) {
  const { t } = useLocale()
  const library = useFileLibrary(workspace.id)
  const cloudDocuments = useCloudDocuments(workspace.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [view, setView] = useState<FileViewMode>('grid')

  const artifacts = useMemo(
    () => sortFilesByUpdatedDesc(library.items.filter(isArtifactFile)),
    [library.items],
  )
  // 云文档与文件产物同类：都是 Agent/用户在本空间产出的交付物。
  const cloudArts = useMemo(
    () => (cloudDocuments.available ? sortCloudDocsByUpdatedDesc(cloudDocuments.documents) : []),
    [cloudDocuments.available, cloudDocuments.documents],
  )
  const counts = useMemo(() => ({
    all: artifacts.length + cloudArts.length,
    'agent-generated': artifacts.filter((item) => item.catalog.sourceKind === 'agent-generated').length,
    'artifact-imported': artifacts.filter((item) => item.catalog.sourceKind === 'artifact-imported').length,
    'cloud-doc': cloudArts.length,
  }), [artifacts, cloudArts])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return artifacts.filter((item) => {
      if (filter !== 'all' && item.catalog.sourceKind !== filter) return false
      return !keyword || fileSearchText(item).includes(keyword)
    })
  }, [artifacts, filter, query])

  // 云文档筛选：'all' 与 'cloud-doc' 时纳入；搜索按标题命中。
  const filteredCloudDocs = useMemo(() => {
    if (filter !== 'all' && filter !== 'cloud-doc') return []
    const keyword = query.trim().toLowerCase()
    return cloudArts.filter((document) => (
      !keyword || cloudDocumentTitle(document).toLowerCase().includes(keyword)
    ))
  }, [cloudArts, filter, query])

  // 复用资料页的列表/网格：文件行与云文档行混排，按更新时间倒序统一排序。
  // 文件行位置列保持资料同口径（relativePath 派生），云文档行显示「云文档」。
  const rows = useMemo(() => {
    const fileRows: LibraryRow[] = filtered.map((item) => ({
      kind: 'file' as const,
      item,
      location: folderLabel(folderOf(item), t),
    }))
    const docRows = cloudDocRows(filteredCloudDocs, t)
    return [...fileRows, ...docRows].sort((left, right) => {
      const leftAt = left.kind === 'file'
        ? Date.parse(left.item.catalog.updatedAt)
        : left.kind === 'cloud-doc' ? Date.parse(left.document.updatedAt) : Number.NaN
      const rightAt = right.kind === 'file'
        ? Date.parse(right.item.catalog.updatedAt)
        : right.kind === 'cloud-doc' ? Date.parse(right.document.updatedAt) : Number.NaN
      if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return 0
      return rightAt - leftAt
    })
  }, [filtered, filteredCloudDocs, t])

  const filters: ReadonlyArray<FileFilterOption<ArtifactFilter>> = [
    { key: 'all', label: t('workbench:workspace.outputs.filter.all'), count: counts.all },
    { key: 'agent-generated', label: t('workbench:workspace.outputs.filter.agent'), count: counts['agent-generated'] },
    { key: 'artifact-imported', label: t('workbench:workspace.outputs.filter.imported'), count: counts['artifact-imported'] },
    { key: 'cloud-doc', label: t('workbench:workspace.outputs.filter.cloudDoc'), count: counts['cloud-doc'] },
  ]

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      onToast(t('workbench:workspace.common.desktopFileUnavailable'))
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      onToast(t('workbench:workspace.common.exported'))
    } catch {
      onToast(t('workbench:workspace.common.exportFailed'))
    }
  }

  const openOriginal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.openOriginal !== 'function') {
      onToast(t('workbench:workspace.common.desktopFileUnavailable'))
      return
    }
    try {
      const result = await api.openOriginal(item.catalog.id, item.catalog.originalName, item.catalog.contentHash, {
        workspaceId: workspace.id,
      })
      if (result.openedWith === 'office') {
        onToast(t('workbench:workspace.common.openedInOffice', { name: item.file.name }))
      } else {
        onToast(t('workbench:workspace.common.openedDefaultApp'))
      }
    } catch {
      onToast(t('workbench:workspace.common.openFailed'))
    }
  }

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
    onError: onToast,
  }

  // 云文档行点开：转伪文件走 onOpenFile（→ 气泡窗 CloudDocumentEditor），
  // 与对话产物云文档卡/资料页同一条打开链路。
  const openCloudDocument = (document: RoomDocument) => {
    onOpenFile(cloudDocumentToOfficeFile(document))
  }

  // 综合空态：文件产物与云文档都为空才算「还没有产物」；工具条同理。
  const totalCount = artifacts.length + cloudArts.length

  return (
    <div className="wb-wspage wb-outputs-page">
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">{t('workbench:workspacePage.outputs')}</h1>
        <div className="wb-file-head-actions">
          <IconButton
            label={t('workbench:workspace.outputs.refresh')}
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={() => { library.refresh(); cloudDocuments.refresh() }}
            disabled={library.refreshing}
          />
          <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={() => onOpenPage('library')}>
            {t('workbench:workspace.outputs.goLibrary')}
          </Button>
        </div>
      </header>

      {library.state === 'ready' && totalCount > 0 ? (
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

      {library.state === 'ready' && totalCount === 0 ? (
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

      {library.state === 'ready' && totalCount > 0 && rows.length === 0 ? (
        <FileNoMatches onClear={() => { setQuery(''); setFilter('all') }} />
      ) : null}

      {library.state === 'ready' && rows.length > 0 ? (
        view === 'list' ? (
          <LibraryList rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} onOpenCloudDocument={openCloudDocument} />
        ) : (
          <LibraryGrid rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} onOpenCloudDocument={openCloudDocument} />
        )
      ) : null}
    </div>
  )
}
