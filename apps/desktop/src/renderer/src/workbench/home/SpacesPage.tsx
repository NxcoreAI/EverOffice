import type { AgentWorkspace } from '@nxcore/agent-contract'
import { Languages, LayoutGrid, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel, workspaceDisplayName } from '../types'
import { Badge, Button, EmptyState, IconButton, PageHeader, TextInput } from '../ui/primitives'
import { ConfirmModal } from '../ui/modal'
import { WorkspaceEnglishNameDialog } from '../ui/WorkspaceEnglishNameDialog'
import { workbenchToast } from '../shell/toast'
import { requestNewSpace } from './parts'
import { cn } from '../ui/cn'

/** 项目空间页：真实 workspace 网格 + 搜索 + 新建 / 行内重命名 / 删除确认。 */
export function SpacesPage() {
  const { t, locale } = useLocale()
  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const renameWorkspace = useWorkbenchStore((state) => state.renameWorkspace)
  const deleteWorkspace = useWorkbenchStore((state) => state.deleteWorkspace)
  const updateWorkspaceMeta = useWorkbenchStore((state) => state.updateWorkspaceMeta)

  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspace | null>(null)
  const [aliasTarget, setAliasTarget] = useState<AgentWorkspace | null>(null)
  const renameCommittedRef = useRef(false)

  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      if (!session.workspaceId) continue
      counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1)
    }
    return counts
  }, [sessions])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return workspaces
    return workspaces.filter((workspace) =>
      [workspace.name, workspace.nameEn ?? '', workspace.description ?? '', ...(workspace.goals ?? []), workspace.path ?? '']
        .some((field) => field.toLowerCase().includes(keyword)))
  }, [query, workspaces])

  const startRename = (workspace: AgentWorkspace) => {
    renameCommittedRef.current = false
    setRenamingId(workspace.id)
    setRenameDraft(workspace.name)
  }

  const saveEnglishName = async (nameEn: string | null): Promise<boolean> => {
    if (!aliasTarget) return false
    const ok = await updateWorkspaceMeta(aliasTarget.id, { nameEn })
    workbenchToast(ok ? t('workbench:workspaceAlias.saved') : t('workbench:workspaceAlias.saveFailed'))
    return ok
  }

  const commitRename = async (workspace: AgentWorkspace) => {
    if (renameCommittedRef.current) return
    renameCommittedRef.current = true
    setRenamingId(null)
    const name = renameDraft.trim()
    if (!name || name === workspace.name) return
    const ok = await renameWorkspace(workspace.id, name)
    workbenchToast(ok ? t('workbench:home.spaces.renamed') : t('workbench:home.spaces.renameFailed'))
  }

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title={t('workbench:home.spaces.title')}
        actions={(
          <Button variant="primary" icon={<Plus size={15} />} onClick={requestNewSpace}>
            {t('workbench:home.spaces.new')}
          </Button>
        )}
      />

      {workspaces.length > 0 ? (
        <div className="wb-home-toolbar">
          <label className="wb-home-search">
            <TextInput
              type="search"
              aria-label={t('workbench:home.spaces.searchAria')}
              placeholder={t('workbench:home.spaces.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="wb-home-toolbar-meta">
            {query.trim() ? t('workbench:home.spaces.matchCount', { matched: filtered.length, total: workspaces.length }) : null}
          </span>
        </div>
      ) : null}

      {workspaces.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={18} />}
          title={t('workbench:home.spaces.emptyTitle')}
          description={t('workbench:home.spaces.emptyDescription')}
          action={<Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={requestNewSpace}>{t('workbench:home.spaces.new')}</Button>}
        />
      ) : filtered.length === 0 ? (
        <div className="wb-home-empty">{t('workbench:home.spaces.noMatch')}</div>
      ) : (
        <div className="wb-home-space-grid">
          {filtered.map((workspace) => {
            const renaming = renamingId === workspace.id
            const displayName = workspaceDisplayName(workspace, locale)
            const count = sessionCounts.get(workspace.id) ?? 0
            return (
              <article key={workspace.id} className={cn('wb-home-space-tile', renaming && 'is-renaming')}>
                <div className="wb-home-space-tile-head">
                  {renaming ? (
                    <div className="wb-home-space-open is-static">
                      <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                      <span className="wb-home-space-main">
                        <TextInput
                          className="wb-home-rename-input"
                          aria-label={t('workbench:home.spaces.nameAria')}
                          autoFocus
                          value={renameDraft}
                          maxLength={120}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void commitRename(workspace)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              renameCommittedRef.current = true
                              setRenamingId(null)
                            }
                          }}
                          onBlur={() => { void commitRename(workspace) }}
                        />
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="wb-home-space-open"
                      onClick={() => openWorkspaceTab(workspace.id)}
                      title={t('workbench:home.spaces.openNamed', { name: displayName })}
                    >
                      <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                      <span className="wb-home-space-main">
                        <span className="wb-home-space-name">
                          <span className="wb-home-truncate">{displayName}</span>
                          {workspace.kind === 'default' ? <Badge tone="neutral">{t('workbench:home.common.default')}</Badge> : null}
                        </span>
                      </span>
                    </button>
                  )}
                </div>
                <div className="wb-home-space-tile-foot">
                  <span className="wb-home-space-tile-meta">
                    {t('workbench:home.spaces.workCount', { count })}
                    {' · '}
                    {relativeTimeLabel(workspace.lastOpenedAt) || t('workbench:home.spaces.neverOpened')}
                  </span>
                  <span className="wb-home-space-tile-actions">
                    <IconButton
                      label={t('workbench:workspaceAlias.editNamed', { name: displayName })}
                      size="sm"
                      icon={<Languages size={13} />}
                      onClick={() => setAliasTarget(workspace)}
                    />
                    <IconButton
                      label={t('workbench:home.spaces.renameNamed', { name: displayName })}
                      size="sm"
                      icon={<Pencil size={13} />}
                      onClick={() => startRename(workspace)}
                    />
                    {workspace.kind !== 'default' ? (
                      <IconButton
                        label={t('workbench:home.spaces.deleteNamed', { name: displayName })}
                        size="sm"
                        tone="danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(workspace)}
                      />
                    ) : null}
                  </span>
                </div>
              </article>
            )
          })}
          <button type="button" className="wb-home-space-tile is-new" onClick={requestNewSpace}>
            <span className="wb-home-space-tile-head">
              <span className="wb-home-space-icon" aria-hidden="true"><Plus size={17} /></span>
              <span className="wb-home-space-main">
                <strong>{t('workbench:home.spaces.new')}</strong>
              </span>
            </span>
          </button>
        </div>
      )}

      <WorkspaceEnglishNameDialog
        open={aliasTarget !== null}
        onOpenChange={(open) => { if (!open) setAliasTarget(null) }}
        workspace={aliasTarget}
        onSave={saveEnglishName}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={t('workbench:home.spaces.deleteTitle', { name: pendingDelete?.name ?? '' })}
        description={t('workbench:home.spaces.deleteDescription')}
        confirmLabel={t('workbench:home.spaces.deleteConfirm')}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (!target) return
          void deleteWorkspace(target.id).then((ok) => {
            workbenchToast(ok ? t('workbench:home.spaces.deleted') : t('workbench:home.spaces.deleteFailed'))
          })
        }}
      />
    </div>
  )
}
