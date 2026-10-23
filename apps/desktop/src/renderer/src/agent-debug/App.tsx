import type { AgentDebugEvent, AgentDebugRun, AgentDebugSnapshot } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorMessage, loadRunEvents, loadSnapshot, loadSources, type DebugSource } from './api'
import { AgentList, type AgentKindTab } from './components/AgentList'
import { RunDetail } from './components/RunDetail'
import { RunList } from './components/RunList'
import { mergeRunEvents, reduceRunTimeline, type DebugFilters } from './reducer'

const SNAPSHOT_INTERVAL_MS = 1200
const EVENTS_INTERVAL_MS = 400
const EVENTS_PAGE_LIMIT = 1000
const SOURCES_RETRY_MS = 3000
const SOURCES_REFRESH_MS = 15_000

type ConnectionState = 'connecting' | 'online' | 'offline'

const EMPTY_RUNS: AgentDebugRun[] = []
const EMPTY_EVENTS: AgentDebugEvent[] = []
const EMPTY_AGENTS: AgentDebugSnapshot['agents'] = []
const DEFAULT_FILTERS: DebugFilters = { reasoning: true, tool: true, message: true, system: true }

const FILTER_DEFS = [
  { key: 'reasoning', label: '思考' },
  { key: 'tool', label: '工具' },
  { key: 'message', label: '消息' },
  { key: 'system', label: '系统' },
] as const

interface SnapshotState {
  sourceId: string
  snapshot: AgentDebugSnapshot
}

interface RunEventsState {
  sourceId: string | null
  runId: string | null
  events: AgentDebugEvent[]
  latestSeq: number
  run: AgentDebugRun | null
  error: string | null
  loaded: boolean
}

const EMPTY_RUN_EVENTS: RunEventsState = {
  sourceId: null,
  runId: null,
  events: [],
  latestSeq: 0,
  run: null,
  error: null,
  loaded: false,
}

export function App() {
  const [sources, setSources] = useState<DebugSource[]>([])
  const [sourcesReady, setSourcesReady] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [snapshotState, setSnapshotState] = useState<SnapshotState | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [filters, setFilters] = useState<DebugFilters>(DEFAULT_FILTERS)
  const [selectedAgentId, setSelectedAgentId] = useState<string>('all')
  const [kindTab, setKindTab] = useState<AgentKindTab>('all')
  const [followLatest, setFollowLatest] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [eventsState, setEventsState] = useState<RunEventsState>(EMPTY_RUN_EVENTS)

  const eventsRef = useRef(eventsState)
  useEffect(() => {
    eventsRef.current = eventsState
  }, [eventsState])

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  // ── sources：启动即拉取，空结果 3s 重试（等 Desktop 启动）、有结果 15s 刷新（等重启换端口） ──
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      let nextDelay = SOURCES_RETRY_MS
      try {
        const result = await loadSources()
        if (cancelled) return
        setSources(result.sources)
        setSourcesReady(true)
        setSourcesError(result.warning ?? (result.sources.length === 0 ? '未发现 gateway runtime manifest' : null))
        nextDelay = result.sources.length > 0 ? SOURCES_REFRESH_MS : SOURCES_RETRY_MS
        setSourceId((current) => {
          if (current && result.sources.some((source) => source.id === current)) return current
          return result.sources[0]?.id ?? null
        })
      } catch (error) {
        if (cancelled) return
        setSourcesReady(true)
        setSourcesError(errorMessage(error))
      } finally {
        if (!cancelled) timer = window.setTimeout(() => { void load() }, nextDelay)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshNonce])

  // ── snapshot：1200ms；暂停时只做一次（手动刷新仍可拍快照） ──
  useEffect(() => {
    if (!sourceId) return undefined
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const next = await loadSnapshot(sourceId)
        if (cancelled) return
        setSnapshotState({ sourceId, snapshot: next })
        setConnection('online')
        setConnectionError(null)
      } catch (error) {
        if (cancelled) return
        setConnection('offline')
        setConnectionError(errorMessage(error))
      }
      if (!cancelled && !paused) timer = window.setTimeout(() => { void tick() }, SNAPSHOT_INTERVAL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sourceId, paused, refreshNonce])

  // 切换来源后丢弃旧快照（避免把上一个 Gateway 的 run 当成当前来源）。
  const snapshot = snapshotState && snapshotState.sourceId === sourceId ? snapshotState.snapshot : null
  const agents = snapshot?.agents ?? EMPTY_AGENTS
  const runs = snapshot?.runs ?? EMPTY_RUNS

  // ── 选中 Agent / run 的自动跟随 ──
  const selectedAgent = selectedAgentId === 'all'
    ? null
    : agents.find((agent) => agent.id === selectedAgentId) ?? null

  useEffect(() => {
    if (selectedAgentId !== 'all' && snapshot && !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId('all')
    }
  }, [agents, selectedAgentId, snapshot])

  const agentRuns = useMemo(
    () => (selectedAgentId === 'all' ? runs : runs.filter((run) => run.agentId === selectedAgentId)),
    [runs, selectedAgentId],
  )

  useEffect(() => {
    setSelectedRunId((current) => {
      if (agentRuns.length === 0) return null
      if (followLatest) {
        const active = agentRuns.find((run) => run.status === 'running')
        if (active) return active.runId
      }
      if (current && agentRuns.some((run) => run.runId === current)) return current
      const running = agentRuns.find((run) => run.status === 'running')
      return running?.runId ?? agentRuns[0]!.runId
    })
  }, [agentRuns, followLatest])

  const selectedRunInSnapshot = selectedRunId !== null && runs.some((run) => run.runId === selectedRunId)

  // ── 选中 run 的增量事件：运行中 400ms，终态/暂停后停止 ──
  useEffect(() => {
    if (!sourceId || !selectedRunId || !selectedRunInSnapshot) return undefined
    const runId = selectedRunId
    if (eventsRef.current.sourceId !== sourceId || eventsRef.current.runId !== runId) {
      setEventsState({ ...EMPTY_RUN_EVENTS, sourceId, runId, run: runs.find((run) => run.runId === runId) ?? null })
      eventsRef.current = { ...EMPTY_RUN_EVENTS, sourceId, runId }
    }
    let cancelled = false
    let timer: number | undefined
    let afterSeq = eventsRef.current.sourceId === sourceId && eventsRef.current.runId === runId
      ? eventsRef.current.latestSeq
      : 0

    const tick = async (): Promise<void> => {
      try {
        let incoming: AgentDebugEvent[] = []
        let latestRun: AgentDebugRun | null = null
        // afterSeq 推进到「本页最后一条已拿到的事件」而不是响应的 latestSeq：
        // 一页被 limit 截断时 latestSeq 是缓冲里最大 seq，直接跳过去会漏事件。
        let cursor = afterSeq
        for (let round = 0; round < 12; round += 1) {
          const response = await loadRunEvents(sourceId, runId, cursor, EVENTS_PAGE_LIMIT)
          latestRun = response.run
          if (response.events.length === 0) {
            cursor = Math.max(cursor, response.latestSeq)
            break
          }
          incoming = mergeRunEvents(incoming, response.events)
          let pageLastSeq = cursor
          for (const event of response.events) pageLastSeq = Math.max(pageLastSeq, event.seq)
          cursor = pageLastSeq
          if (response.events.length < EVENTS_PAGE_LIMIT) break
        }
        afterSeq = cursor
        if (cancelled) return
        setEventsState((previous) => previous.sourceId === sourceId && previous.runId === runId
          ? {
            ...previous,
            events: mergeRunEvents(previous.events, incoming),
            latestSeq: Math.max(previous.latestSeq, afterSeq),
            run: latestRun ?? previous.run,
            error: null,
            loaded: true,
          }
          : {
            ...EMPTY_RUN_EVENTS,
            sourceId,
            runId,
            events: incoming,
            latestSeq: afterSeq,
            run: latestRun,
            loaded: true,
          })
        if (!cancelled && !paused && latestRun?.status === 'running') {
          timer = window.setTimeout(() => { void tick() }, EVENTS_INTERVAL_MS)
        }
      } catch (error) {
        if (cancelled) return
        setEventsState((previous) => previous.sourceId === sourceId && previous.runId === runId
          ? { ...previous, error: errorMessage(error), loaded: true }
          : previous)
        if (!cancelled && !paused) timer = window.setTimeout(() => { void tick() }, 1500)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
    // runs 只用于首帧补齐 run 元数据，进依赖会造成每次 snapshot 重置增量拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, selectedRunId, selectedRunInSnapshot, paused, refreshNonce])

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    if (eventsState.sourceId === sourceId && eventsState.runId === selectedRunId && eventsState.run) {
      return eventsState.run
    }
    return runs.find((run) => run.runId === selectedRunId) ?? null
  }, [eventsState.run, eventsState.runId, eventsState.sourceId, runs, selectedRunId, sourceId])

  const activeEvents = eventsState.sourceId === sourceId && eventsState.runId === selectedRunId
    ? eventsState.events
    : EMPTY_EVENTS
  const activeEventsError = eventsState.sourceId === sourceId && eventsState.runId === selectedRunId
    ? eventsState.error
    : null
  const timeline = useMemo(() => reduceRunTimeline(activeEvents), [activeEvents])

  const currentSource = sources.find((source) => source.id === sourceId) ?? null
  const connectionLabel = sourcesReady && sources.length === 0
    ? '未发现 Gateway'
    : paused
      ? '已暂停'
      : connection === 'online'
        ? '在线'
        : connection === 'offline'
          ? '离线'
          : '连接中'

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-label">来源</span>
        <select
          className="source-select"
          value={sourceId ?? ''}
          disabled={sources.length === 0}
          onChange={(event) => setSourceId(event.target.value || null)}
          title={currentSource ? `代理目标 ${currentSource.baseUrl}` : '未发现 gateway runtime manifest'}
        >
          {sources.length === 0 ? <option value="">未发现 Gateway</option> : null}
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}{source.version ? ` · v${source.version}` : ''}
            </option>
          ))}
        </select>
        <span className="conn" data-state={paused ? 'paused' : connection} title={connectionError ?? (paused ? '轮询已暂停' : '')}>
          {connectionLabel}
        </span>
        {connection === 'offline' && connectionError ? (
          <span className="conn-error" title={connectionError}>{connectionError}</span>
        ) : null}
        <div className="topbar-spacer" />
        <div className="topbar-filters" role="group" aria-label="事件过滤">
          {FILTER_DEFS.map((definition) => (
            <button
              key={definition.key}
              type="button"
              className="text-btn"
              data-active={filters[definition.key]}
              aria-pressed={filters[definition.key]}
              onClick={() => setFilters((previous) => ({ ...previous, [definition.key]: !previous[definition.key] }))}
              title={`${filters[definition.key] ? '隐藏' : '显示'}${definition.label}事件`}
            >
              {definition.label}
            </button>
          ))}
        </div>
        <button type="button" className="text-btn" onClick={refresh} title="立即重新拉取 sources / snapshot / 事件">
          刷新
        </button>
        <button
          type="button"
          className="text-btn text-btn--accent"
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
          title={paused ? '恢复轮询' : '暂停所有轮询'}
        >
          {paused ? '继续' : '暂停'}
        </button>
      </header>

      {!sourcesReady ? (
        <div className="boot">正在检测 Gateway runtime manifest</div>
      ) : sources.length === 0 ? (
        <EmptySources error={sourcesError} onRefresh={refresh} />
      ) : (
        <main className="main">
          <AgentList
            agents={agents}
            runs={runs}
            kindTab={kindTab}
            onKindTabChange={setKindTab}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
          />
          <RunList
            runs={agentRuns}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            agentTitle={selectedAgent ? selectedAgent.name : '全部 Agent'}
            showAgent={selectedAgentId === 'all'}
            followLatest={followLatest}
            onToggleFollow={() => setFollowLatest((value) => !value)}
          />
          {selectedRun ? (
            <RunDetail
              key={selectedRun.runId}
              run={selectedRun}
              events={activeEvents}
              model={timeline}
              filters={filters}
              eventsError={activeEventsError}
            />
          ) : (
            <section className="col col--detail">
              <div className="empty">
                <p className="empty-text">
                  {snapshot
                    ? '选择一个 run 查看时间线、事件与输出。'
                    : connectionError ?? '正在连接 Gateway'}
                </p>
              </div>
            </section>
          )}
        </main>
      )}
    </div>
  )
}

function EmptySources({ error, onRefresh }: { error: string | null; onRefresh: () => void }) {
  const detail = error && error !== '未发现 gateway runtime manifest' ? error : null
  return (
    <main className="empty">
      <div className="empty-text">
        <p>未发现 Gateway runtime manifest。请先启动 EverRoom，或设置 manifest 路径后重启调试页。</p>
        <p><code>EVERROOM_AGENT_DEBUG_MANIFEST=/path/to/runtime/gateway.json pnpm debug:agents</code></p>
        {detail ? <p>{detail}</p> : null}
        <button type="button" className="text-btn" onClick={onRefresh}>重新检测</button>
      </div>
    </main>
  )
}
