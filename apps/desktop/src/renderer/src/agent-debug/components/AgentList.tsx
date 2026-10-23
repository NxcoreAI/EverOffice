import type { AgentDebugAgent, AgentDebugRun } from '@nxcore/agent-contract'
import { memo, useMemo } from 'react'

import { formatRelativeTime } from '../format'
import { AGENT_KIND_LABEL } from './Indicators'

export type AgentKindTab = 'all' | 'builtin' | 'developer' | 'local'

const KIND_TABS: Array<{ id: AgentKindTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'builtin', label: '内置' },
  { id: 'developer', label: '子 Agent' },
  { id: 'local', label: '本机' },
]

interface AgentListProps {
  agents: AgentDebugAgent[]
  runs: AgentDebugRun[]
  kindTab: AgentKindTab
  onKindTabChange: (tab: AgentKindTab) => void
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
}

function sortAgents(agents: AgentDebugAgent[]): AgentDebugAgent[] {
  const weight: Record<AgentDebugAgent['state'], number> = { running: 0, error: 1, idle: 2 }
  return [...agents].sort((left, right) => {
    const byState = weight[left.state] - weight[right.state]
    if (byState !== 0) return byState
    const leftAt = left.lastRunAt ? Date.parse(left.lastRunAt) : 0
    const rightAt = right.lastRunAt ? Date.parse(right.lastRunAt) : 0
    if (rightAt !== leftAt) return rightAt - leftAt
    return left.name.localeCompare(right.name)
  })
}

export const AgentList = memo(function AgentList({
  agents,
  runs,
  kindTab,
  onKindTabChange,
  selectedAgentId,
  onSelectAgent,
}: AgentListProps) {
  const runStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const run of runs) map.set(run.agentId, (map.get(run.agentId) ?? 0) + 1)
    return map
  }, [runs])

  const visibleAgents = useMemo(
    () => sortAgents(kindTab === 'all' ? agents : agents.filter((agent) => agent.kind === kindTab)),
    [agents, kindTab],
  )

  const globalStats = useMemo(() => {
    let running = 0
    for (const run of runs) if (run.status === 'running') running += 1
    return { running, total: runs.length }
  }, [runs])

  return (
    <aside className="col col--agents" aria-label="Agent 列表">
      <div className="col-head">
        <span className="col-title">Agent</span>
        <span className="col-count">{visibleAgents.length}</span>
      </div>
      <div className="kind-tabs" role="tablist" aria-label="Agent 类型">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={kindTab === tab.id}
            className="text-btn"
            data-active={kindTab === tab.id}
            onClick={() => onKindTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="scroll agent-list">
        <button
          type="button"
          className="agent-row"
          data-selected={selectedAgentId === 'all'}
          onClick={() => onSelectAgent('all')}
        >
          <span className="agent-row-top">
            <span className="agent-mark" data-state={globalStats.running > 0 ? 'running' : 'idle'} />
            <span className="agent-name">全部 Agent</span>
            <span className="agent-count">
              {globalStats.running > 0 ? `${globalStats.running}/${globalStats.total}` : globalStats.total}
            </span>
          </span>
          <span className="agent-sub">所有 run · {globalStats.total} 个</span>
        </button>
        {visibleAgents.map((agent) => {
          const total = runStats.get(agent.id) ?? 0
          return (
            <button
              key={agent.id}
              type="button"
              className="agent-row"
              data-selected={selectedAgentId === agent.id}
              title={`${agent.name}${agent.description ? `\n${agent.description}` : ''}\nid: ${agent.id}`}
              onClick={() => onSelectAgent(agent.id)}
            >
              <span className="agent-row-top">
                <span className="agent-mark" data-state={agent.state} />
                <span className="agent-name">{agent.name}</span>
                <span className="agent-count">{total}</span>
              </span>
              <span className="agent-sub">
                {AGENT_KIND_LABEL[agent.kind]} · {formatRelativeTime(agent.lastRunAt)}
                {agent.activeRunCount > 0 ? ` · ${agent.activeRunCount} 运行` : ''}
              </span>
            </button>
          )
        })}
        {visibleAgents.length === 0 ? <div className="empty-inline">暂无该类型 Agent</div> : null}
      </div>
    </aside>
  )
})
