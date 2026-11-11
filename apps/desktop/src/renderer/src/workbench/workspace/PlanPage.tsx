import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { PlanStatus } from '@nxcore/agent-contract'

import { workbenchApi } from '../api'
import { sessionDisplayTitle } from '../types'
import { Button, Spinner, TextInput } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import { PlanBoard } from './plan/PlanBoard'
import { PlanItemDetail, type PlanDetailPatch } from './plan/PlanItemDetail'
import { resolveDrop } from './plan/planDrag'
import { usePlanItems } from './plan/usePlanItems'
import './plan/plan.css'

/**
 * 工作空间「计划」：任务的看板（用户与 Agent 的共同待办池）。
 *
 * 四列常显：没有任务时也渲染四个状态列（空列保留各自的「新建任务」入口），
 * 不用空态整页替换看板。任务不按负责人区分（卡片上也没有我/Agent 标签），
 * 会话降级为卡片上的执行入口；会话列表仍在侧栏「工作 N」里，这里不再重复。
 */
export function PlanPage({ workspace, sessions, onOpenSession, onNewWork, onToast }: WorkspacePageProps) {
  const { t } = useLocale()
  const plan = usePlanItems(workspace.id)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return plan.items
    return plan.items.filter((item) => item.title.toLowerCase().includes(keyword)
      || (item.detail ?? '').toLowerCase().includes(keyword)
      || item.tags.some((tag) => tag.toLowerCase().includes(keyword)))
  }, [plan.items, query])

  const groups = useMemo(() => {
    const buckets: Record<PlanStatus, typeof visible> = { todo: [], doing: [], done: [], dropped: [] }
    for (const item of visible) buckets[item.status].push(item)
    return buckets
  }, [visible])

  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, sessionDisplayTitle(session, t))
    return map
  }, [sessions, t])

  const blockedTitles = useMemo(() => {
    const byId = new Map(plan.items.map((item) => [item.id, item]))
    const map = new Map<string, string[]>()
    for (const item of plan.items) {
      if (!item.blockedBy.length) continue
      const titles: string[] = []
      for (const id of item.blockedBy) {
        const blocker = byId.get(id)
        if (blocker && blocker.status !== 'done') titles.push(blocker.title)
      }
      if (titles.length) map.set(item.id, titles)
    }
    return map
  }, [plan.items])

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runBatch = async (action: 'move' | 'drop', status?: PlanStatus) => {
    const ids = [...selectedIds]
    if (!ids.length) return
    try {
      const result = await workbenchApi.batchPlanItems(ids, action, status)
      setSelectedIds(new Set())
      setSelectMode(false)
      await plan.reload()
      const failed = result.failed.length
      if (action === 'drop') {
        onToast(failed
          ? t('workbench:workspace.plan.batch.cancelledPartial', { count: result.items.length, failed })
          : t('workbench:workspace.plan.batch.cancelled', { count: result.items.length }))
      } else {
        onToast(failed
          ? t('workbench:workspace.plan.batch.movedPartial', { count: result.items.length, failed })
          : t('workbench:workspace.plan.batch.moved', { count: result.items.length }))
      }
    } catch {
      onToast(t('workbench:workspace.plan.batchFailed'))
    }
  }

  const selected = selectedId ? plan.items.find((item) => item.id === selectedId) ?? null : null

  const createTask = async (title: string, status: PlanStatus = 'todo') => {
    const created = await plan.createItem(title, status)
    if (!created) {
      onToast(t('workbench:workspace.plan.createFailed'))
      return
    }
    setSelectedId(created.id)
  }

  const commitDraft = async () => {
    const title = draftTitle.trim()
    setDraftTitle('')
    setComposing(false)
    if (title) await createTask(title)
  }

  const detailHandlers = selected ? {
    onClose: () => setSelectedId(null),
    onSave: async (patch: PlanDetailPatch) => (
      (await plan.updateItem(selected, patch)) !== null
    ),
    onAssign: async () => {
      const result = await plan.assignItem(selected)
      if (!result) {
        onToast(t('workbench:workspace.plan.assignFailed'))
        return
      }
      onToast(t('workbench:workspace.plan.assigned'))
      onOpenSession(result.sessionId)
    },
    onRemove: async () => {
      if (await plan.removeItem(selected)) {
        onToast(t('workbench:workspace.plan.removed'))
        setSelectedId(null)
      } else {
        onToast(t('workbench:workspace.plan.removeFailed'))
      }
    },
    onRestore: async () => {
      const todoCount = plan.items.filter((item) => item.status === 'todo').length
      const target = resolveDrop(plan.items, selected.id, 'todo', todoCount)
      if (await plan.moveItem(selected, target)) onToast(t('workbench:workspace.plan.restored'))
      else onToast(t('workbench:workspace.plan.restoreFailed'))
    },
    onOpenSession,
    onToast,
  } : null

  return (
    <div className="wb-wspage wb-tools-page wb-plan-page">
      <header className="wb-plan-toolbar">
        <div className="wb-plan-toolbar-title">
          <h2>{t('workbench:workspacePage.plan')}</h2>
        </div>
        <div className="wb-plan-toolbar-search">
          <Search size={14} aria-hidden="true" />
          <TextInput
            value={query}
            placeholder={t('workbench:workspace.plan.searchPlaceholder')}
            aria-label={t('workbench:workspace.plan.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="wb-plan-toolbar-actions">
          {plan.items.length ? (
            <Button
              variant={selectMode ? 'soft' : 'ghost'}
              size="sm"
              onClick={() => {
                setSelectMode((current) => !current)
                setSelectedIds(new Set())
              }}
            >
              {selectMode
                ? t('workbench:workspace.plan.exitMultiSelect')
                : t('workbench:workspace.plan.multiSelect')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onNewWork}>
            {t('workbench:workspaceSidebar.newWork')}
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setComposing(true)}>
            {t('workbench:workspace.plan.newTask')}
          </Button>
        </div>
      </header>

      {composing ? (
        <div className="wb-plan-compose-bar">
          <TextInput
            autoFocus
            value={draftTitle}
            placeholder={t('workbench:workspace.plan.composePlaceholder')}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitDraft()
              if (event.key === 'Escape') {
                setDraftTitle('')
                setComposing(false)
              }
            }}
            onBlur={() => void commitDraft()}
          />
        </div>
      ) : null}

      {plan.error && plan.state !== 'ready' ? (
        <div className="wb-tool-error" role="alert">
          {plan.state === 'unavailable'
            ? t('workbench:workspace.plan.unavailable')
            : t('workbench:workspace.plan.loadFailed', { error: plan.error })}
        </div>
      ) : null}

      {plan.state === 'loading' ? (
        <div className="wb-plan-loading">
          <Spinner /> {t('workbench:workspace.plan.loading')}
        </div>
      ) : (
        <PlanBoard
          groups={groups}
          sessionTitles={sessionTitles}
          blockedTitles={blockedTitles}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onDrop={async (dragId, column, index) => {
            const ok = await plan.dropItem(dragId, column, index)
            if (!ok) onToast(t('workbench:workspace.plan.moveFailed'))
          }}
          onCreate={(title, status) => void createTask(title, status)}
          onOpenCard={setSelectedId}
        />
      )}

      {selectedIds.size ? (
        <div className="wb-plan-batch-bar" role="toolbar" aria-label={t('workbench:workspace.plan.batchBar')}>
          <span className="wb-plan-batch-count">
            {t('workbench:workspace.plan.selectedCount', { count: selectedIds.size })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'todo')}>
            {t('workbench:workspace.plan.moveToTodo')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'doing')}>
            {t('workbench:workspace.plan.moveToDoing')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'done')}>
            {t('workbench:workspace.plan.markDone')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void runBatch('drop')}>
            {t('workbench:workspace.plan.cancelTask')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            {t('workbench:workspace.plan.clearSelection')}
          </Button>
        </div>
      ) : null}

      <div className={selected ? 'wb-plan-detail-layer is-open' : 'wb-plan-detail-layer'}>
        {selected && detailHandlers ? (
          <PlanItemDetail item={selected} {...detailHandlers} />
        ) : null}
      </div>
    </div>
  )
}
