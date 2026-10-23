import type { AgentDebugRun } from '@nxcore/agent-contract'
import { memo, useMemo } from 'react'

import { formatCharCount } from '../format'
import { LiveDuration, runStatusLabel } from './Indicators'

interface RunListProps {
  runs: AgentDebugRun[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  /** 当前跟踪对象的名称（Agent 名或「全部 Agent」）。 */
  agentTitle: string
  /** 是否展示每行的 Agent 名（跟踪全部时需要）。 */
  showAgent: boolean
  followLatest: boolean
  onToggleFollow: () => void
}

function sortRuns(runs: AgentDebugRun[]): AgentDebugRun[] {
  return [...runs].sort((left, right) => {
    const leftRunning = left.status === 'running' ? 0 : 1
    const rightRunning = right.status === 'running' ? 0 : 1
    if (leftRunning !== rightRunning) return leftRunning - rightRunning
    const leftAt = Date.parse(left.lastEventAt ?? left.startedAt)
    const rightAt = Date.parse(right.lastEventAt ?? right.startedAt)
    return rightAt - leftAt
  })
}

export const RunList = memo(function RunList({
  runs,
  selectedRunId,
  onSelectRun,
  agentTitle,
  showAgent,
  followLatest,
  onToggleFollow,
}: RunListProps) {
  const sorted = useMemo(() => sortRuns(runs), [runs])
  const runningCount = useMemo(() => runs.filter((run) => run.status === 'running').length, [runs])

  return (
    <section className="col col--runs" aria-label="Run 列表">
      <div className="col-head">
        <span className="col-title">运行</span>
        <span className="col-count col-count--inline">
          {runningCount > 0 ? `${runningCount}/${runs.length}` : runs.length}
        </span>
        <button
          type="button"
          className="text-btn follow-btn"
          data-active={followLatest}
          aria-pressed={followLatest}
          onClick={onToggleFollow}
          title={agentTitle}
        >
          跟随 {followLatest ? '开' : '关'}
        </button>
      </div>
      <div className="scroll run-list">
        {sorted.map((run) => (
          <button
            key={run.runId}
            type="button"
            className="run-row"
            data-status={run.status}
            data-selected={selectedRunId === run.runId}
            onClick={() => onSelectRun(run.runId)}
            title={run.task}
          >
            <span className="run-top">
              <span className="run-status" data-status={run.status}>{runStatusLabel(run.status)}</span>
              {showAgent ? <span className="run-agent">{run.agentName}</span> : null}
            </span>
            <span className="run-task">{run.task || '（无任务摘要）'}</span>
            <span className="run-meta">
              耗时 <LiveDuration startedAt={run.startedAt} completedAt={run.completedAt} running={run.status === 'running'} />
              {' · '}工具 {run.toolCallCount}
              {' · '}思考 {formatCharCount(run.reasoningChars)} 字
              {' · '}事件 {run.eventCount}
              {run.droppedEvents > 0 ? ` · 丢弃 ${run.droppedEvents}` : ''}
            </span>
          </button>
        ))}
        {sorted.length === 0 ? <div className="empty-inline">该 Agent 暂无 run</div> : null}
      </div>
    </section>
  )
})
