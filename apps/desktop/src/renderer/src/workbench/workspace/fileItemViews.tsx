import {
  Download,
  ExternalLink,
  MoreHorizontal,
  PanelRightOpen,
  Stamp,
  Trash2,
} from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'

/**
 * 文件行内的操作菜单（资料/产物两页共用；网格与列表本体在 LibraryViews.tsx，
 * 产物页与资料页复用同一套视图）。
 *
 * 只做纯展示 + 点开回调；打开文件一律通过 `FileItemActions.onOpen`
 * （页面转交 WorkspacePageProps.onOpenFile → 气泡窗），本模块不碰任何 IPC。
 */

/* ───────────────── 行操作菜单 ───────────────── */

export interface FileItemActions {
  /** 交给注入的 onOpenFile → 工作空间右侧气泡窗。 */
  onOpen: (item: RealOfficeFile) => void
  onOpenOriginal?: (item: RealOfficeFile) => void
  onExportReveal?: (item: RealOfficeFile) => void
  /** 把资料库文件设为当前工作区的论文排版模版（AI 面板「排版」里可见）。 */
  onSetThesisTemplate?: (item: RealOfficeFile) => void
  onDelete?: (item: RealOfficeFile) => void
}

/** 论文模版只收 Word/PDF（与网关 thesis-format 解析入口一致）。 */
function canBeThesisTemplate(item: RealOfficeFile): boolean {
  return /\.(docx?|pdf)$/i.test(item.file.name)
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
        {actions.onOpenOriginal ? (
          <MenuItem icon={<ExternalLink size={14} />} onSelect={() => actions.onOpenOriginal?.(item)}>
            {t('workbench:workspace.file.menu.openOriginal')}
          </MenuItem>
        ) : null}
        {actions.onExportReveal ? (
          <MenuItem icon={<Download size={14} />} onSelect={() => actions.onExportReveal?.(item)}>
            {t('workbench:workspace.file.menu.exportReveal')}
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

/* ───────────────── 列表 / 网格视图 ─────────────────
 * 产物页原本自带一套行/卡片（wb-file-row / wb-file-card），与资料页的
 * 六列表格、Finder 瓦片不一致；已改为直接复用 LibraryViews（以资料为主），
 * 本文件只保留共用的行内操作菜单。 */
