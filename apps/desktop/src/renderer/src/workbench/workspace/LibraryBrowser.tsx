import { ChevronLeft, ChevronRight, LayoutGrid, List, Search, X } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import type { AgentScratchListing } from '@nxcore/agent-contract'
import { useLocale } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'

import { IconButton } from '../ui/primitives'
import type { FileViewMode } from './fileBrowser'
import type { FileItemActions } from './fileItemViews'
import {
  buildLibraryLevel,
  folderCrumbs,
  parentFolderOf,
  levelRows,
  LIBRARY_ROOT_KEY,
  searchLibrary,
  buildScratchLevel,
  scratchRows,
  TMP_FOLDER_PATH,
  isTmpPath,
  type LibraryRow,
} from './libraryTree'
import { LibraryGrid, LibraryList } from './LibraryViews'

/**
 * 资料浏览器：顶部工具行（返回上一级 / 面包屑 / 搜索 / 网格·列表切换）+ 内容区。
 *
 * 布局照 everoffice 原型「资料」文件管理器：当前目录逐级进入，搜索是**全库**
 * 范围（忽略当前目录），搜索中强制列表视图并禁用视图切换。
 * 当前目录 / 搜索词 / 视图模式是本页局部状态，切走页面即重置（与原型一致）。
 *
 * `.tmp/`（Agent 过程缓存）作为根目录下的保留文件夹展示：scratch 由清单接口
 * 只读派生，不入文件库索引；里面的文件不能打开/删除，只支持在访达中定位。
 *
 * 访达拖放的落点在页面根节点（LibraryPage），空库/加载态也能拖；本组件只管浏览。
 */
export function LibraryBrowser({ items, actions, scratch, onRevealScratch }: {
  items: readonly RealOfficeFile[]
  actions: FileItemActions
  /** `.tmp/` 只读清单；null = 桥不可用/未绑定目录（不显示 .tmp 入口）。 */
  scratch: AgentScratchListing | null
  /** 在访达中定位 `.tmp` 里的文件（参数为相对 `.tmp` 根的路径）。 */
  onRevealScratch: (relativePath: string) => void
}) {
  const { t } = useLocale()
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<FileViewMode>('grid')

  const keyword = query.trim()
  const searching = keyword.length > 0
  const inTmp = isTmpPath(path)
  const level = useMemo(() => buildLibraryLevel(items, path), [items, path])
  const levelRowsList = useMemo(() => levelRows(level, t), [level, t])
  const scratchEntries = useMemo(
    () => (scratch?.present ? scratch.entries : []),
    [scratch],
  )
  const scratchLevel = useMemo(
    () => (inTmp ? buildScratchLevel(scratchEntries, path) : null),
    [inTmp, scratchEntries, path],
  )
  const hits = useMemo(
    () => (searching ? searchLibrary(items, keyword, t) : null),
    [items, keyword, searching, t],
  )

  // 根目录额外挂 .tmp 文件夹（scratch 根存在且有内容时），排在普通目录前。
  const tmpFolderRow: LibraryRow[] = !inTmp && !searching && scratchEntries.length > 0
    ? [{
        kind: 'folder',
        path: TMP_FOLDER_PATH,
        name: TMP_FOLDER_PATH,
        fileCount: 0,
        location: t(LIBRARY_ROOT_KEY),
      }]
    : []
  const rows: LibraryRow[] = hits
    ? [...hits.folders, ...hits.files]
    : inTmp && scratchLevel
      ? scratchRows(scratchLevel, t)
      : [...tmpFolderRow, ...levelRowsList]
  const crumbs = useMemo(() => folderCrumbs(level.path), [level.path])

  // 任何目录跳转（进入 / 返回 / 面包屑）都顺手清掉搜索词：
  // 搜索是全库结果，跳目录后再停在搜索态会让人以为看到的是该目录内容。
  const goTo = (target: string) => {
    setQuery('')
    setPath(target)
  }

  const viewProps = {
    rows,
    actions,
    onEnterFolder: goTo,
    onOpenFile: (item: RealOfficeFile) => actions.onOpen(item),
    onRevealScratch: (row: Extract<LibraryRow, { kind: 'scratch' }>) => onRevealScratch(
      row.path.slice(TMP_FOLDER_PATH.length + 1),
    ),
  }

  return (
    <div className="wb-lib">
      <div className="wb-lib-bar">
        <button
          type="button"
          className="wb-lib-back"
          title={t('workbench:workspace.library.back')}
          aria-label={t('workbench:workspace.library.back')}
          disabled={!level.path || searching}
          onClick={() => goTo(parentFolderOf(level.path))}
        >
          <ChevronLeft size={15} />
        </button>

        <nav className="wb-lib-crumbs" aria-label={t('workbench:workspace.library.location')}>
          <button
            type="button"
            className={level.path ? undefined : 'is-current'}
            aria-current={level.path ? undefined : 'page'}
            onClick={() => goTo('')}
          >
            {t(LIBRARY_ROOT_KEY)}
          </button>
          {crumbs.map((crumb) => (
            <Fragment key={crumb.path}>
              <ChevronRight size={12} className="wb-lib-crumb-sep" aria-hidden="true" />
              <button
                type="button"
                className={crumb.path === level.path ? 'is-current' : undefined}
                aria-current={crumb.path === level.path ? 'page' : undefined}
                onClick={() => goTo(crumb.path)}
              >
                {crumb.name}
              </button>
            </Fragment>
          ))}
        </nav>

        <label className="wb-lib-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('workbench:workspace.library.searchPlaceholder')}
            aria-label={t('workbench:workspace.library.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="wb-lib-search-clear"
              title={t('workbench:workspace.common.clearSearch')}
              aria-label={t('workbench:workspace.common.clearSearch')}
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>

        <div className="wb-lib-views" role="group" aria-label={t('workbench:workspace.common.viewSwitch')}>
          <IconButton
            label={t('workbench:workspace.common.gridView')}
            size="sm"
            active={view === 'grid' && !searching}
            disabled={searching}
            icon={<LayoutGrid size={15} />}
            onClick={() => setView('grid')}
          />
          <IconButton
            label={t('workbench:workspace.common.listView')}
            size="sm"
            active={view === 'list' || searching}
            disabled={searching}
            icon={<List size={15} />}
            onClick={() => setView('list')}
          />
        </div>
      </div>

      {inTmp && scratch?.truncated ? (
        <p className="wb-lib-note">
          {t('workbench:workspace.library.scratchTruncated', { count: scratchEntries.length })}
        </p>
      ) : null}

      {rows.length > 0 ? (
        searching || view === 'list'
          ? <LibraryList {...viewProps} />
          : <LibraryGrid {...viewProps} />
      ) : (
        <p className="wb-lib-empty">
          {searching
            ? t('workbench:workspace.library.searchNoMatch', { keyword })
            : inTmp
              ? t('workbench:workspace.library.tmpEmpty')
              : t('workbench:workspace.library.folderEmpty')}
        </p>
      )}
    </div>
  )
}
