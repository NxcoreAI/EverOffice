import {
  FolderOpen,
  MoreHorizontal,
  PanelRightOpen,
  Stamp,
  Trash2,
} from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'
import { FileOpenWithSubmenu } from '@/components/files/FileOpenWithSubmenu'

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'

/**
 * 文件行内的操作菜单（资料/产物两页共用；网格与列表本体在 LibraryViews.tsx，
 * 产物页与资料页复用同一套视图）。
 *
 * 只做纯展示 + 点开回调；打开文件一律通过 `FileItemActions.onOpen`
 * （页面转交 WorkspacePageProps.onOpenFile → 气泡窗侧栏）。「用其他应用打开」
 * 子菜单是自包含组件（内部走 preload 的文件关联接口），页面只注入失败提示。
 * 「在访达中打开」按平台显示文案（mac=访达 / win=资源管理器），动作是定位
 * 文件本体（onReveal）。
 */

/* ───────────────── 行操作菜单 ───────────────── */

export interface FileItemActions {
  /** 交给注入的 onOpenFile → 工作空间右侧气泡窗侧栏。 */
  onOpen: (item: RealOfficeFile) => void
  /** 在系统文件管理器中定位文件本体（mac=访达 / win=资源管理器）。 */
  onReveal?: (item: RealOfficeFile) => void
  /** 把资料库文件设为当前工作区的论文排版模版（AI 面板「排版」里可见）。 */
  onSetThesisTemplate?: (item: RealOfficeFile) => void
  onDelete?: (item: RealOfficeFile) => void
  /** 行内操作失败提示（用其他应用打开/定位失败）。 */
  onError?: (message: string) => void
}

/** 论文模版只收 Word/PDF（与网关 thesis-format 解析入口一致）。 */
function canBeThesisTemplate(item: RealOfficeFile): boolean {
  return /\.(docx?|pdf)$/i.test(item.file.name)
}

/** 当前平台是否 Windows（菜单/文案按它区分访达 vs 资源管理器）。 */
export function isWindowsPlatform(): boolean {
  return window.nxcore?.platform === 'win32'
}

/** 平台区分的「已定位」toast 文案（mac=访达 / win=资源管理器）。 */
export function revealedToastKey(): string {
  return isWindowsPlatform()
    ? 'workbench:workspace.library.toast.revealed.windows'
    : 'workbench:workspace.library.toast.revealed'
}

export function FileItemMenu({ item, actions, align = 'end' }: {
  item: RealOfficeFile
  actions: FileItemActions
  align?: 'start' | 'center' | 'end'
}) {
  const { t } = useLocale()
  return (
    <Menu>
      <MenuTrigger asChild>
        {/* 用原生 button（而非 IconButton）：Radix Trigger asChild 需要转发 ref 才能定位浮层。 */}
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--sm wb-file-menu-trigger"
          aria-label={t('workbench:workspace.file.menu.actions', { name: item.file.name })}
          title={t('workbench:workspace.file.menu.more')}
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align={align}>
        <MenuItem icon={<PanelRightOpen size={14} />} onSelect={() => actions.onOpen(item)}>
          {t('workbench:workspace.file.menu.openInBubble')}
        </MenuItem>
        <FileOpenWithSubmenu fileId={item.catalog.id} onError={actions.onError} label="用其他应用打开" />
        {actions.onReveal ? (
          <MenuItem icon={<FolderOpen size={14} />} onSelect={() => actions.onReveal?.(item)}>
            {isWindowsPlatform()
              ? t('workbench:workspace.file.menu.reveal.windows')
              : t('workbench:workspace.file.menu.reveal')}
          </MenuItem>
        ) : null}
        {actions.onSetThesisTemplate && canBeThesisTemplate(item) ? (
          <MenuItem icon={<Stamp size={14} />} onSelect={() => actions.onSetThesisTemplate?.(item)}>
            {t('workbench:workspace.file.menu.thesisTemplate')}
          </MenuItem>
        ) : null}
        {actions.onDelete ? (
          <>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => actions.onDelete?.(item)}>
              {t('workbench:workspace.file.menu.delete')}
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  )
}

/* ───────────────── 文件夹操作菜单 ───────────────── */

export interface FolderItemActions {
  /** 删除文件夹（虚拟目录）：该前缀下全部文件进回收站。 */
  onDelete?: (row: { path: string; name: string; fileCount: number }) => void
}

/**
 * 资料页文件夹行/瓦片的操作菜单。文件夹是从 relativePath 派生的虚拟目录
 * （磁盘上无实体），可做的操作是"删除文件夹"＝按前缀批量删除其下文件。
 */
export function FolderItemMenu({ row, actions, align = 'end' }: {
  row: { path: string; name: string; fileCount: number }
  actions: FolderItemActions
  align?: 'start' | 'center' | 'end'
}) {
  const { t } = useLocale()
  if (!actions.onDelete) return null
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--sm wb-file-menu-trigger"
          aria-label={t('workbench:workspace.library.folderMenu.actions', { name: row.name })}
          title={t('workbench:workspace.file.menu.more')}
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align={align}>
        <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => actions.onDelete?.(row)}>
          {t('workbench:workspace.library.folderMenu.delete')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/* ───────────────── 列表 / 网格视图 ─────────────────
 * 产物页原本自带一套行/卡片（wb-file-row / wb-file-card），与资料页的
 * 六列表格、Finder 瓦片不一致；已改为直接复用 LibraryViews（以资料为主），
 * 本文件只保留共用的行内操作菜单。 */
