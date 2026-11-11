import {
  CalendarDays,
  ChevronRight,
  FolderOpen,
  LayoutDashboard,
  Languages,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  PlusCircle,
  Trash2,
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

import type { AgentSession } from '@nxcore/agent-contract'

import { useLocale } from '@/i18n/LocaleContext'

import type { WorkspaceTab } from '../types'
import {
  WORK_SESSION_STATUS_META,
  WORKSPACE_PAGES,
  relativeTimeLabel,
  sessionDisplayTitle,
  workspaceDisplayName,
  workSessionStatus,
} from '../types'
import { workbenchApi } from '../api'
import { useWorkbenchStore, useWorkspace, useWorkspaceSessions } from '../state/store'
import { Hint, IconButton } from '../ui/primitives'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { ConfirmModal } from '../ui/modal'
import { WorkspaceEnglishNameDialog } from '../ui/WorkspaceEnglishNameDialog'
import { workbenchToast } from './toast'
import { cn } from '../ui/cn'

const PAGE_ICONS: Record<string, React.ReactNode> = {
  overview: <LayoutDashboard size={16} strokeWidth={1.8} />,
  library: <FolderOpen size={16} strokeWidth={1.8} />,
  outputs: <Package size={16} strokeWidth={1.8} />,
  plan: <CalendarDays size={16} strokeWidth={1.8} />,
}

type DeleteTarget = { kind: 'workspace'; id: string; title: string } | { kind: 'session'; id: string; title: string }

/** 工作空间标签的侧栏：空间标题 + 功能菜单 + 工作列表（= 该空间的会话）。 */
export function WorkspaceSidebar({ tab }: { tab: WorkspaceTab }) {
  const { t, locale } = useLocale()
  const workspace = useWorkspace(tab.workspaceId)
  const sessions = useWorkspaceSessions(tab.workspaceId)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const renameWorkspace = useWorkbenchStore((state) => state.renameWorkspace)
  const deleteWorkspace = useWorkbenchStore((state) => state.deleteWorkspace)
  const updateWorkspaceMeta = useWorkbenchStore((state) => state.updateWorkspaceMeta)
  const renameSession = useWorkbenchStore((state) => state.renameSession)
  const deleteSession = useWorkbenchStore((state) => state.deleteSession)

  const [renamingWorkspace, setRenamingWorkspace] = useState(false)
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [aliasOpen, setAliasOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRenamingWorkspace(false)
    setRenamingSessionId(null)
  }, [tab.workspaceId])

  if (!workspace) return null

  const workspaceName = workspaceDisplayName(workspace, locale)
  const activePage = tab.view.kind === 'page' ? tab.view.page : null
  const activeSessionId = tab.view.kind === 'session' ? tab.view.sessionId : null

  const beginRenameWorkspace = () => {
    setWorkspaceDraft(workspace.name)
    setRenamingWorkspace(true)
  }
  const commitRenameWorkspace = () => {
    const name = workspaceDraft.trim()
    if (name && name !== workspace.name) void renameWorkspace(workspace.id, name)
    setRenamingWorkspace(false)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    if (deleteTarget.kind === 'workspace') await deleteWorkspace(deleteTarget.id)
    else await deleteSession(deleteTarget.id)
    setBusy(false)
    setDeleteTarget(null)
  }

  const startDraft = () => {
    const existingDraft = tab.view.kind === 'draft'
    if (!existingDraft) setWorkspaceView(tab.id, { kind: 'draft' })
  }

  /** 在访达中打开空间目录（原概览「空间目录」卡的能力，卡删除后收进这里）。 */
  const saveEnglishName = async (nameEn: string | null): Promise<boolean> => {
    const ok = await updateWorkspaceMeta(workspace.id, { nameEn })
    workbenchToast(ok ? t('workbench:workspaceAlias.saved') : t('workbench:workspaceAlias.saveFailed'))
    return ok
  }

  const revealInFinder = async () => {
    if (!workspace.path) {
      workbenchToast(t('workbench:workspaceSidebar.noLocalDirToast'))
      return
    }
    try {
      const layout = await workbenchApi.spaceLayout(workspace.id).catch(() => null)
      const ok = await workbenchApi.revealDirectory(layout?.paths.root ?? workspace.path)
      if (!ok) workbenchToast(t('workbench:workspaceSidebar.dirMissing'))
    } catch {
      workbenchToast(t('workbench:workspaceSidebar.dirMissing'))
    }
  }

  return (
    <aside className="wb-sidebar wb-ws-sidebar" aria-label={t('workbench:workspaceSidebar.navigation')}>
      <div className="wb-sidebar-titlebar" aria-hidden="true" />

      <div className="wb-ws-head">
        {renamingWorkspace ? (
          <input
            className="ui-input wb-ws-name-input"
            autoFocus
            value={workspaceDraft}
            aria-label={t('workbench:workspaceSidebar.name')}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRenameWorkspace()
              if (event.key === 'Escape') setRenamingWorkspace(false)
            }}
            onBlur={commitRenameWorkspace}
          />
        ) : (
          <Hint label={workspace.path ?? t('workbench:workspaceSidebar.noLocalDir')} side="bottom">
            <h2 className="wb-ws-name" title={workspaceName}>{workspaceName}</h2>
          </Hint>
        )}
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t('workbench:workspaceSidebar.operations')} size="sm" icon={<MoreHorizontal size={15} />} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Pencil size={14} />} onSelect={beginRenameWorkspace}>{t('workbench:workspaceSidebar.rename')}</MenuItem>
            <MenuItem icon={<Languages size={14} />} onSelect={() => setAliasOpen(true)}>{t('workbench:workspaceAlias.edit')}</MenuItem>
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => { void revealInFinder() }}>
              {t('workbench:workspaceSidebar.reveal')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={14} />}
              danger
              disabled={workspace.kind === 'default'}
              onSelect={() => setDeleteTarget({ kind: 'workspace', id: workspace.id, title: workspaceName })}
            >
              {t('workbench:workspaceSidebar.deleteSpace')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <nav className="wb-sidebar-nav" aria-label={t('workbench:workspaceSidebar.features')}>
        <button
          type="button"
          className={cn('wb-nav-item', tab.view.kind === 'draft' && 'is-active')}
          onClick={startDraft}
        >
          <span className="wb-nav-icon" aria-hidden="true"><PlusCircle size={16} strokeWidth={1.8} /></span>
          <span className="wb-nav-label">{t('workbench:workspaceSidebar.newWork')}</span>
        </button>
        {WORKSPACE_PAGES.map((page) => (
          <button
            key={page.key}
            type="button"
            className={cn('wb-nav-item', activePage === page.key && 'is-active')}
            aria-current={activePage === page.key ? 'page' : undefined}
            onClick={() => setWorkspaceView(tab.id, { kind: 'page', page: page.key })}
          >
            <span className="wb-nav-icon" aria-hidden="true">{PAGE_ICONS[page.key]}</span>
            <span className="wb-nav-label">{t(page.labelKey)}</span>
          </button>
        ))}
      </nav>

      <div className="wb-ws-work">
        <div className="wb-ws-work-head">
          <span>{t('workbench:workspaceSidebar.workList')}</span>
          <span className="wb-ws-work-count">{sessions.length}</span>
        </div>
        <div className="wb-ws-work-list" role="list">
          {tab.view.kind === 'draft' ? (
            <div className="wb-ws-work-row is-active is-draft">
              <span className="wb-ws-work-dot" aria-hidden="true" />
              <span className="wb-ws-work-title">{t('workbench:common.newWork')}</span>
              <span className="wb-ws-work-time">{t('workbench:workspaceSidebar.draft')}</span>
            </div>
          ) : null}
          {sessions.length === 0 && tab.view.kind !== 'draft' ? (
            <div className="wb-ws-work-empty">{t('workbench:workspaceSidebar.noWork')}</div>
          ) : null}
          {sessions.map((session) => (
            <WorkRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              renaming={renamingSessionId === session.id}
              onOpen={() => setWorkspaceView(tab.id, { kind: 'session', sessionId: session.id })}
              onStartRename={() => setRenamingSessionId(session.id)}
              onFinishRename={() => setRenamingSessionId(null)}
              onRename={(title) => { void renameSession(session.id, title) }}
              onDelete={() => setDeleteTarget({ kind: 'session', id: session.id, title: sessionDisplayTitle(session, t) })}
            />
          ))}
        </div>
      </div>

      <WorkspaceEnglishNameDialog
        open={aliasOpen}
        onOpenChange={setAliasOpen}
        workspace={workspace}
        onSave={saveEnglishName}
      />

      <ConfirmModal
        open={deleteTarget?.kind === 'workspace'}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('workbench:workspaceSidebar.deleteSpaceTitle')}
        description={deleteTarget ? t('workbench:workspaceSidebar.deleteSpaceBody', { title: deleteTarget.title }) : undefined}
        confirmLabel={t('workbench:workspaceSidebar.deleteSpace')}
        busy={busy}
        onConfirm={() => { void confirmDelete() }}
      />
      <ConfirmModal
        open={deleteTarget?.kind === 'session'}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('workbench:workspaceSidebar.deleteWorkTitle')}
        description={deleteTarget ? t('workbench:workspaceSidebar.deleteWorkBody', { title: deleteTarget.title }) : undefined}
        confirmLabel={t('workbench:workspaceSidebar.deleteWork')}
        busy={busy}
        onConfirm={() => { void confirmDelete() }}
      />
    </aside>
  )
}

function WorkRow({ session, active, renaming, onOpen, onStartRename, onRename, onFinishRename, onDelete }: {
  session: AgentSession
  active: boolean
  renaming: boolean
  onOpen: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onFinishRename: () => void
  onDelete: () => void
}) {
  const { t } = useLocale()
  const [draft, setDraft] = useState(sessionDisplayTitle(session, t))
  const status = workSessionStatus(session)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!renaming) setDraft(sessionDisplayTitle(session, t))
  }, [renaming, session, t])

  const commit = () => {
    const title = draft.trim()
    if (title && title !== sessionDisplayTitle(session, t)) onRename(title)
    onFinishRename()
  }

  if (renaming) {
    return (
      <div ref={rowRef} className="wb-ws-work-row is-renaming">
        <input
          className="ui-input wb-ws-work-rename"
          autoFocus
          value={draft}
          aria-label={t('workbench:workspaceSidebar.workName')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') { setDraft(sessionDisplayTitle(session, t)); onFinishRename() }
          }}
          onBlur={commit}
        />
      </div>
    )
  }

  return (
    <div
      ref={rowRef}
      role="listitem"
      className={cn('wb-ws-work-row', active && 'is-active')}
    >
      <button type="button" className="wb-ws-work-main" title={sessionDisplayTitle(session, t)} onClick={onOpen}>
        <span className={cn('wb-ws-work-dot', `is-${status}`)} aria-hidden="true">
          {status === 'running' ? <Loader2 size={10} className="ui-spin" /> : null}
        </span>
        <span className="wb-ws-work-title">{sessionDisplayTitle(session, t)}</span>
        <span className="wb-ws-work-time">{relativeTimeLabel(session.updatedAt, t)}</span>
      </button>
      <span className="wb-ws-work-status" title={t(WORK_SESSION_STATUS_META[status].labelKey)}>
        <ChevronRight size={12} aria-hidden="true" />
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="wb-ws-work-more" aria-label={t('workbench:workspaceSidebar.workActions')} title={t('workbench:workspaceSidebar.more')}>
            <MoreHorizontal size={14} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil size={14} />} onSelect={onStartRename}>{t('workbench:workspaceSidebar.renameWork')}</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger disabled={session.status === 'running'} onSelect={onDelete}>
            {t('workbench:workspaceSidebar.delete')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
