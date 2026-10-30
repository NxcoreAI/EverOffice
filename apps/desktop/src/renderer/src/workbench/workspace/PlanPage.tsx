import { Plus } from 'lucide-react'

import type { AgentSession } from '@nxcore/agent-contract'

import {
  type WorkSessionStatus,
  relativeTimeLabel,
  sessionDisplayTitle,
  workSessionStatus,
  WORK_SESSION_STATUS_META,
} from '../types'
import { Button, PageHeader } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import './tools.css'

/** 看板三列（与 session.status 的映射：closed/interrupted → 已结束）。 */
export const PLAN_COLUMNS: ReadonlyArray<{ key: WorkSessionStatus; empty: string }> = [
  { key: 'running', empty: '暂无进行中的工作' },
  { key: 'idle', empty: '暂无待开始的工作' },
  { key: 'done', empty: '暂无已结束的工作' },
]

/**
 * 把本空间会话按看板状态分列。
 *
 * 只做归类，不改顺序：WorkspaceTabHost 注入的 sessions 已按「运行中优先 + 更新时间倒序」
 * 排过，列内沿用该顺序，避免看板与侧栏工作列表的顺序打架。
 */
export function groupPlanColumns(sessions: readonly AgentSession[]): Record<WorkSessionStatus, AgentSession[]> {
  const groups: Record<WorkSessionStatus, AgentSession[]> = { running: [], idle: [], done: [] }
  for (const session of sessions) groups[workSessionStatus(session)].push(session)
  return groups
}

/**
 * 工作空间「计划」看板。
 *
 * 只读视图：状态来自 `AgentSession.status`，由网关 run 驱动；渲染层不提供拖拽改状态，
 * 以免做出后端并不存在的写操作。点卡片跳到对应工作会话继续对话。
 */
export function PlanPage({ sessions, onOpenSession, onNewWork }: WorkspacePageProps) {
  const groups = groupPlanColumns(sessions)

  return (
    <div className="wb-wspage wb-tools-page wb-plan-page">
      <PageHeader
        eyebrow="计划"
        title="计划"
        subtitle="按状态查看本空间的工作。看板是只读视图：状态由 Agent 运行自动推进，不能拖拽修改。"
        actions={(
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={onNewWork}>
            新建工作
          </Button>
        )}
      />

      <div className="wb-plan-board wb-plan-board--tools">
        {PLAN_COLUMNS.map((column) => {
          const items = groups[column.key]
          return (
            <section key={column.key} className={`wb-plan-col wb-plan-col--${column.key}`}>
              <header className="wb-plan-col-head">
                <span className={`wb-status-dot is-${column.key}`} aria-hidden="true" />
                <strong>{WORK_SESSION_STATUS_META[column.key].label}</strong>
                <span className="wb-plan-col-count">{items.length}</span>
              </header>
              <div className="wb-plan-col-body">
                {items.length === 0 ? (
                  <div className="wb-plan-none">{column.empty}</div>
                ) : (
                  items.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className="wb-plan-card"
                      onClick={() => onOpenSession(session.id)}
                    >
                      <span className="wb-plan-card-title">{sessionDisplayTitle(session)}</span>
                      <span className="wb-plan-card-meta">
                        <span className={`wb-status-dot is-${column.key}`} aria-hidden="true" />
                        <span className="wb-plan-card-time">{relativeTimeLabel(session.updatedAt)}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          )
        })}
      </div>

      <p className="wb-plan-footnote">
        状态由网关里的 Agent 运行结果决定；要改状态请进入对应工作会话继续推进，而不是拖卡片。
      </p>
    </div>
  )
}
