import { FilePlus2, FileText, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { useLocale, type Translate } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'

import { workspaceDisplayName } from '../types'
import { ConfirmModal } from '../ui/modal'
import { EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileImportButton,
  FileLibraryLoading,
  FileLibraryUnavailable,
} from './fileBrowser'
import type { FileItemActions } from './fileItemViews'
import { LibraryBrowser } from './LibraryBrowser'
import { useFileLibrary } from './useFileLibrary'
import { useScratchFiles } from './useScratchFiles'
import { useLibraryDropZone } from './useLibraryDropZone'
import './library.css'

/**
 * 资料库页：本工作空间专属的文件管理器（返回上一级 / 面包屑 / 搜索 / 网格·列表）。
 *
 * 布局照 everoffice 原型「资料库」：目录层级由 `relativePath` 派生，网格里文件夹
 * 在前、文件在后，列表是「名称 / 本地位置 / 修改时间 / 大小 / 操作」六列。
 * 文件入库时带 workspaceId（手动导入按当前空间，Agent 产物按其会话所属空间），
 * 本页只拉 `workspace.id` 名下的文件；存量文件迁移后归默认工作区。
 * 打开文件一律走注入的 onOpenFile → 工作空间右侧气泡窗；本页自己不挂编辑器。
 * 访达拖文件进内容区直接导入本空间（与「导入文件」按钮同一条 importPathsOnce 链路）。
 */

/** 导入结果摘要 → toast 文案（按钮导入与拖放导入共用）。 */
function summarizeImport(
  summary: { imported: number; failed: number; skipped: number },
  t: Translate,
): string {
  const parts: string[] = []
  if (summary.imported > 0) {
    parts.push(t('workbench:workspace.library.import.imported', { count: summary.imported }))
  }
  if (summary.failed > 0) {
    parts.push(t('workbench:workspace.library.import.failed', { count: summary.failed }))
  }
  if (summary.skipped > 0) {
    parts.push(t('workbench:workspace.library.import.skipped', { count: summary.skipped }))
  }
  return parts.join(t('workbench:workspace.library.import.joiner'))
    || t('workbench:workspace.library.import.none')
}
export function LibraryPage({ workspace, onOpenFile, onToast }: WorkspacePageProps) {
  const { t, locale } = useLocale()
  const library = useFileLibrary(workspace.id)
  const scratch = useScratchFiles(workspace.id)
  const [pendingDelete, setPendingDelete] = useState<RealOfficeFile | null>(null)
  const [deleting, setDeleting] = useState(false)

  /**
   * 在访达中定位 `.tmp/` 里的临时文件：scratch 清单只给相对路径，
   * 绝对根从空间布局（layout.paths.tmp）取；reveal 由主进程 showItemInFolder 完成。
   */
  const revealScratch = async (relativePath: string) => {
    const bridge = window.nxcore?.workspace
    if (!bridge || typeof bridge.layout !== 'function' || typeof bridge.reveal !== 'function') {
      onToast(t('workbench:workspace.library.toast.spaceUnavailable'))
      return
    }
    try {
      const layout = await bridge.layout(workspace.id)
      const absolute = `${layout.paths.tmp}/${relativePath}`
      const ok = await bridge.reveal(absolute)
      onToast(ok
        ? t('workbench:workspace.library.toast.revealed')
        : t('workbench:workspace.library.toast.cleanedUp'))
    } catch {
      onToast(t('workbench:workspace.library.toast.revealFailed'))
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

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    const api = window.nxcore?.files
    if (!api || typeof api.delete !== 'function') {
      onToast(t('workbench:workspace.common.desktopFileUnavailable'))
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    try {
      await api.delete(target.catalog.id)
      onToast(t('workbench:workspace.library.toast.deleted', { name: target.file.name }))
      setPendingDelete(null)
      library.refresh()
    } catch {
      onToast(t('workbench:workspace.library.toast.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const handleImport = async () => {
    if (library.importing) return
    try {
      const summary = await library.importFiles()
      if (!summary) {
        onToast(t('workbench:workspace.library.toast.unavailable'))
        return
      }
      if (summary.kind === 'cancelled') {
        onToast(t('workbench:workspace.library.toast.importCancelled'))
        return
      }
      onToast(summarizeImport(summary, t))
    } catch {
      onToast(t('workbench:workspace.library.toast.importFailed'))
    }
  }

  /** 访达拖放导入：结果摘要与按钮导入同一套文案。 */
  const handleDropFiles = async (files: File[]) => {
    if (library.importing) {
      onToast(t('workbench:workspace.library.toast.importingBusy'))
      return
    }
    try {
      const summary = await library.importDroppedFiles(files)
      if (!summary) {
        onToast(t('workbench:workspace.library.toast.unavailable'))
        return
      }
      if (summary.kind === 'cancelled') return
      onToast(summarizeImport(summary, t))
    } catch {
      onToast(t('workbench:workspace.library.toast.importFailed'))
    }
  }

  /**
   * 把本空间资料库里的 Word/PDF 设为「论文排版模版」。
   *
   * 排版工具按工作区隔离：在这里设一次，打开本空间任意 docx 后在 AI 面板
   * 「排版」里就能直接选它——不必再走面板里的磁盘选择框重复上传。
   */
  const setThesisTemplate = async (item: RealOfficeFile) => {
    const thesis = window.nxcore?.thesisFormat
    if (!thesis || typeof thesis.setFromLibrary !== 'function') {
      onToast(t('workbench:workspace.library.toast.thesisUnavailable'))
      return
    }
    onToast(t('workbench:workspace.library.toast.thesisParsing', { name: item.file.name }))
    try {
      const result = await thesis.setFromLibrary(workspace.id, item.catalog.id)
      const gaps = Array.isArray(result.factGaps) ? result.factGaps.filter(Boolean) : []
      if (gaps.length > 0) {
        onToast(t('workbench:workspace.library.toast.thesisGaps', { gaps: gaps.join('；') }))
      } else {
        onToast(t('workbench:workspace.library.toast.thesisSet', { name: workspaceDisplayName(workspace, locale) }))
      }
    } catch {
      onToast(t('workbench:workspace.library.toast.thesisFailed'))
    }
  }

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
    onSetThesisTemplate: (item) => { void setThesisTemplate(item) },
    onDelete: (item) => setPendingDelete(item),
  }

  // 访达拖放：落点是页面根节点——空库/加载/不可用态也能拖，不只在有内容的浏览器里。
  const { dragActive, dragProps } = useLibraryDropZone((files) => { void handleDropFiles(files) })

  return (
    <div
      className={dragActive ? 'wb-wspage wb-library-page is-dragover' : 'wb-wspage wb-library-page'}
      {...dragProps}
    >
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">{t('workbench:workspace.library.root')}</h1>
        <div className="wb-file-head-actions">
          <IconButton
            label={t('workbench:workspace.library.refresh')}
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
            disabled={library.refreshing}
          />
          <FileImportButton importing={library.importing} onClick={() => { void handleImport() }} />
        </div>
      </header>

      {library.state === 'loading' ? <FileLibraryLoading /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && library.items.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<FileText size={18} />}
          title={library.total === 0
            ? t('workbench:workspace.library.emptyNoFiles')
            : t('workbench:workspace.library.emptyNoOpenable')}
        />
      ) : null}

      {library.state === 'ready' && library.items.length > 0 ? (
        <LibraryBrowser
          items={library.items}
          actions={actions}
          scratch={scratch.state === 'ready' ? scratch.listing : null}
          onRevealScratch={(relativePath) => { void revealScratch(relativePath) }}
        />
      ) : null}

      {/* 拖放悬停提示：只在拖着文件悬停期间出现，pointer-events:none 防抖动 */}
      {dragActive ? (
        <div className="wb-lib-dropzone" aria-hidden="true">
          <FilePlus2 size={22} aria-hidden="true" />
          <p>
            {library.importing
              ? t('workbench:workspace.library.dropImporting')
              : t('workbench:workspace.library.dropHint')}
          </p>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null) }}
        title={pendingDelete
          ? t('workbench:workspace.library.deleteTitle', { name: pendingDelete.file.name })
          : t('workbench:workspace.library.deleteTitleGeneric')}
        description={t('workbench:workspace.library.deleteDescription')}
        confirmLabel={deleting
          ? t('workbench:workspace.library.deleting')
          : t('workbench:workspace.library.delete')}
        busy={deleting}
        onConfirm={() => { void confirmDelete() }}
      />
    </div>
  )
}
