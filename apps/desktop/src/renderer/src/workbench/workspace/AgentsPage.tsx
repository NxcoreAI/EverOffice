import { Bot, Check, Plus, RefreshCw, StickyNote, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WorkspacePageProps } from './contracts'
import {
  type AgentNote,
  type DiscoveredAgent,
  type EnabledAgent,
  type MainAgentStatusView,
  type McpServersView,
  MAX_NOTE_LENGTH,
  bridgeErrorMessage,
  createLocalId,
  LOCAL_AGENT_STATUS_META,
  mergeEnabledAgents,
  normalizeDiscoveredAgents,
  normalizeMainAgentStatus,
  normalizeMcpServers,
  providerLabel,
  readAgentNotes,
  readEnabledAgents,
  writeAgentNotes,
  writeEnabledAgents,
} from './agentCatalog'
import { Badge, Button, EmptyState, IconButton, PageHeader, Spinner, TextArea } from '../ui/primitives'
import { Modal } from '../ui/modal'
import { cn } from '../ui/cn'
import './tools.css'

/** 桌面桥缺失时的可读错误（与 workbench/api.ts 口径一致，不伪造数据）。 */
function callBridge<T>(fn: (() => Promise<T>) | undefined, label: string): Promise<T> {
  if (!fn) return Promise.reject(new Error(`${label}接口未就绪，请重启 EverRoom`))
  try {
    return fn()
  } catch (error) {
    return Promise.reject(error)
  }
}

interface EnabledAgentCard {
  entry: EnabledAgent
  discovered: DiscoveredAgent | null
}

/**
 * 工作空间「智能体」页。
 *
 * 真实数据：
 * - 主 Agent 状态 `agent.getStatus()`（全局）
 * - 本机 CLI Agent `agent.discoverLocalAgents()`（全局）
 * - MCP 服务 `mcp.listServers()`（全局）
 *
 * 无后端归属：「本空间启用的智能体」与「经验便签」按 workspace.id 存 localStorage，
 * 页面上明确标注为本机偏好（只在本机生效、不上传、不同步团队）。
 */
export function AgentsPage({ workspace, onToast }: WorkspacePageProps) {
  const [mainAgent, setMainAgent] = useState<MainAgentStatusView | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([])
  const [mcp, setMcp] = useState<McpServersView | null>(null)
  const [enabledAgents, setEnabledAgents] = useState<EnabledAgent[]>(() => readEnabledAgents(workspace.id))
  const [notes, setNotes] = useState<AgentNote[]>(() => readAgentNotes(workspace.id))
  const [noteDraft, setNoteDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const [prefError, setPrefError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setPrefError(null)
    const [statusResult, agentsResult, mcpResult] = await Promise.allSettled([
      callBridge(window.nxcore?.agent?.getStatus, 'Agent 状态'),
      callBridge(window.nxcore?.agent?.discoverLocalAgents, '本机 Agent 发现'),
      callBridge(window.nxcore?.mcp?.listServers, 'MCP 服务'),
    ])
    setMainAgent(normalizeMainAgentStatus(statusResult.status === 'fulfilled' ? statusResult.value : null))
    setDiscovered(normalizeDiscoveredAgents(agentsResult.status === 'fulfilled' ? agentsResult.value : null))
    setMcp(normalizeMcpServers(mcpResult.status === 'fulfilled' ? mcpResult.value : null))
    if (agentsResult.status === 'rejected') {
      setPrefError(bridgeErrorMessage(agentsResult.reason, '读取本机 Agent 失败，可点「刷新」重试'))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 切到另一个空间时重新读取本机偏好（同一页面实例会被不同工作空间标签复用）。
  useEffect(() => {
    setEnabledAgents(readEnabledAgents(workspace.id))
    setNotes(readAgentNotes(workspace.id))
    setNoteDraft('')
    setSelection([])
    setPrefError(null)
  }, [workspace.id])

  const cards = useMemo<EnabledAgentCard[]>(
    () => enabledAgents.map((entry) => ({
      entry,
      discovered: discovered.find((agent) => agent.id === entry.id) ?? null,
    })),
    [enabledAgents, discovered],
  )

  const persistAgents = (next: EnabledAgent[]): boolean => {
    setEnabledAgents(next)
    const saved = writeEnabledAgents(workspace.id, next)
    if (!saved) setPrefError('本机偏好保存失败（浏览器隐私模式或存储被禁用），本次变更只在当前页面生效。')
    return saved
  }

  const openPicker = () => {
    setSelection([])
    setPickerOpen(true)
  }

  const toggleSelection = (id: string) => {
    setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const addSelectedAgents = () => {
    const picked = discovered.filter((agent) => selection.includes(agent.id))
    if (picked.length === 0) return
    const saved = persistAgents(mergeEnabledAgents(enabledAgents, picked))
    setSelection([])
    setPickerOpen(false)
    onToast(saved
      ? `已添加 ${picked.length} 个智能体到「${workspace.name}」`
      : '已添加，但本机偏好没保存成功')
  }

  const toggleAgent = (id: string) => {
    const next = enabledAgents.map((agent) => agent.id === id ? { ...agent, enabled: !agent.enabled } : agent)
    const target = next.find((agent) => agent.id === id)
    if (!target) return
    if (persistAgents(next)) onToast(target.enabled ? `已启用 ${target.displayName}` : `已停用 ${target.displayName}`)
  }

  const removeAgent = (id: string) => {
    const target = enabledAgents.find((agent) => agent.id === id)
    persistAgents(enabledAgents.filter((agent) => agent.id !== id))
    onToast(target ? `已从本空间移除 ${target.displayName}` : '已移除')
  }

  const addNote = () => {
    const text = noteDraft.trim()
    if (!text) return
    const next: AgentNote[] = [
      { id: createLocalId(), text, createdAt: new Date().toISOString() },
      ...notes,
    ]
    setNotes(next)
    setNoteDraft('')
    if (!writeAgentNotes(workspace.id, next)) {
      setPrefError('便签保存失败（浏览器隐私模式或存储被禁用），本次内容只在当前页面生效。')
    }
  }

  const removeNote = (id: string) => {
    const next = notes.filter((note) => note.id !== id)
    setNotes(next)
    if (!writeAgentNotes(workspace.id, next)) {
      setPrefError('便签保存失败（浏览器隐私模式或存储被禁用），本次变更只在当前页面生效。')
    }
  }

  return (
    <div className="wb-wspage wb-tools-page">
      <PageHeader
        eyebrow="智能体"
        title="智能体"
        subtitle={`${workspace.name} 可用的 Agent 与工具。主 Agent、本机 Agent、MCP 配置都是全局的；「启用列表」和「经验便签」是本机偏好，只保存在这台电脑。`}
        actions={(
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              disabled={loading}
              onClick={() => { void refresh() }}
            >
              {loading ? '读取中…' : '刷新'}
            </Button>
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openPicker}>
              添加智能体
            </Button>
          </>
        )}
      />

      {prefError ? <div className="wb-tool-error" role="alert">{prefError}</div> : null}

      {/* ① 主 Agent（全局状态） */}
      <section className="wb-tool-section">
        <header className="wb-tool-section-head">
          <h2>工作台主 Agent</h2>
          <span className="wb-tool-scope">全局 · 不按空间</span>
        </header>
        {loading && mainAgent === null ? (
          <div className="wb-tool-loading"><Spinner /> 正在读取主 Agent 状态…</div>
        ) : mainAgent?.available ? (
          <>
            <div className="wb-main-agent">
              <span className="wb-main-agent-icon" aria-hidden="true"><Bot size={18} /></span>
              <span className="wb-main-agent-text">
                <strong>主 Agent</strong>
                <span>负责对话、文档与 Office 产物</span>
              </span>
              <Badge tone={mainAgent.running > 0 ? 'running' : 'success'} dot>
                {mainAgent.running > 0 ? `运行中 · ${mainAgent.running}` : '空闲'}
              </Badge>
            </div>
            <dl className="wb-main-agent-stats">
              {[
                ['Agent', mainAgent.total],
                ['运行中', mainAgent.running],
                ['空闲', mainAgent.idle],
                ['异常', mainAgent.error],
              ].map(([label, value]) => (
                <div key={label} className="wb-main-agent-stat">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {mainAgent.agents.length > 0 ? (
              <ul className="wb-main-agent-list">
                {mainAgent.agents.slice(0, 6).map((agent) => (
                  <li key={agent.id}>
                    <span
                      className={`wb-status-dot is-${agent.state === 'running' ? 'running' : agent.state === 'error' ? 'done' : 'idle'}`}
                      aria-hidden="true"
                    />
                    <span className="wb-main-agent-name">{agent.name}</span>
                    <span className="wb-main-agent-state">
                      {agent.state === 'running' ? `运行中 · ${agent.activeRunCount}` : agent.state === 'error' ? '异常' : '空闲'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <div className="wb-tool-note">
            主 Agent 状态暂不可用（网关未就绪时会这样）。恢复后点「刷新」重试。
          </div>
        )}
      </section>

      {/* ② 本空间启用的智能体（本机偏好） */}
      <section className="wb-tool-section">
        <header className="wb-tool-section-head">
          <h2>本空间启用的智能体</h2>
          <span className="wb-tool-scope">本机偏好 · 仅这台电脑</span>
          <span className="wb-tool-count">
            {enabledAgents.filter((agent) => agent.enabled).length} 个启用 · 本机发现 {discovered.length} 个
          </span>
        </header>
        <p className="wb-tool-hint">
          「启用」只是这台电脑上给这个空间做的标记：不改 Agent 安装，也不同步给团队。
        </p>
        {cards.length === 0 ? (
          <EmptyState
            icon={<Bot size={18} />}
            title="还没有启用任何智能体"
            description="从本机已发现的 CLI Agent 里挑几个，加入后就能在这个空间里找到它们。"
            action={(
              <Button variant="soft" size="sm" icon={<Plus size={13} />} onClick={openPicker}>
                添加智能体
              </Button>
            )}
          />
        ) : (
          <div className="wb-agent-grid">
            {cards.map(({ entry, discovered: found }) => {
              const meta = LOCAL_AGENT_STATUS_META[found?.status ?? 'unknown']
              return (
                <article key={entry.id} className={cn('wb-agent-card', !entry.enabled && 'is-off')}>
                  <div className="wb-agent-card-head">
                    <span className="wb-agent-avatar" aria-hidden="true"><Bot size={16} /></span>
                    <span className="wb-agent-name-block">
                      <strong>{entry.displayName}</strong>
                      <span>{providerLabel(entry.provider)}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={entry.enabled}
                      aria-label={`${entry.enabled ? '停用' : '启用'} ${entry.displayName}`}
                      className={cn('wb-switch', entry.enabled && 'is-on')}
                      onClick={() => toggleAgent(entry.id)}
                    >
                      <span className="wb-switch-thumb" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="wb-agent-meta">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {!entry.enabled ? <Badge tone="neutral">已停用</Badge> : null}
                    {found?.version ? <span className="wb-agent-version">{found.version}</span> : null}
                    {found && found.skillCount > 0 ? <span className="wb-agent-skill">{found.skillCount} 项能力</span> : null}
                  </div>
                  {!found ? (
                    <p className="wb-agent-note">本次没有检测到这个 Agent（可能已卸载或不在 PATH 里），启用标记仍保留。</p>
                  ) : null}
                  {found?.error ? <p className="wb-agent-note">{found.error}</p> : null}
                  <div className="wb-agent-card-foot">
                    <IconButton
                      label={`从本空间移除 ${entry.displayName}`}
                      size="sm"
                      tone="danger"
                      icon={<Trash2 size={13} />}
                      onClick={() => removeAgent(entry.id)}
                    />
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* ③ MCP 工具（全局配置） */}
      <section className="wb-tool-section">
        <header className="wb-tool-section-head">
          <h2>MCP 工具</h2>
          <span className="wb-tool-scope">全局配置 · 不按空间</span>
          {mcp ? <span className="wb-tool-count">{mcp.servers.length} 个服务</span> : null}
        </header>
        {loading && mcp === null ? (
          <div className="wb-tool-loading"><Spinner /> 正在读取 MCP 配置…</div>
        ) : mcp && mcp.servers.length > 0 ? (
          <>
            <ul className="wb-mcp-list">
              {mcp.servers.map((server) => (
                <li key={server.name} className="wb-mcp-row">
                  <span className="wb-mcp-icon" aria-hidden="true"><Wrench size={14} /></span>
                  <span className="wb-mcp-main">
                    <strong>{server.name}</strong>
                    <code>{server.command ?? server.url ?? '无启动命令'}</code>
                  </span>
                  {server.lifecycle ? <Badge tone="neutral">{server.lifecycle}</Badge> : null}
                  {server.disabled ? <Badge tone="warning">已停用</Badge> : <Badge tone="success">已启用</Badge>}
                </li>
              ))}
            </ul>
            {mcp.configPath ? <p className="wb-tool-hint">配置文件：<code>{mcp.configPath}</code></p> : null}
          </>
        ) : (
          <div className="wb-tool-note">
            还没有配置 MCP 服务 · 配置是全局的，添加后所有空间都能用。
          </div>
        )}
      </section>

      {/* ④ 经验便签（本机偏好） */}
      <section className="wb-tool-section">
        <header className="wb-tool-section-head">
          <h2>经验便签</h2>
          <span className="wb-tool-scope">本机偏好 · 仅这台电脑</span>
          {notes.length > 0 ? <span className="wb-tool-count">{notes.length} 条</span> : null}
        </header>
        <p className="wb-tool-hint">
          记下这个空间里 Agent 踩过的坑或好用的提示，下次打开还能看到；不会上传，也不同步给团队。
        </p>
        <div className="wb-note-editor">
          <TextArea
            value={noteDraft}
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            aria-label="经验便签内容"
            placeholder="例如：这个空间的文件名要带日期后缀，Agent 才能排对顺序。"
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="wb-note-editor-foot">
            <span>{noteDraft.length}/{MAX_NOTE_LENGTH}</span>
            <Button variant="primary" size="sm" icon={<StickyNote size={13} />} disabled={!noteDraft.trim()} onClick={addNote}>
              添加便签
            </Button>
          </div>
        </div>
        {notes.length === 0 ? (
          <div className="wb-tool-note">还没有便签。写下第一条经验，之后在空间里随时能翻到。</div>
        ) : (
          <ul className="wb-note-list">
            {notes.map((note) => (
              <li key={note.id} className="wb-note">
                <span className="wb-note-text">{note.text}</span>
                <span className="wb-note-side">
                  <time className="wb-note-time" dateTime={note.createdAt}>
                    {formatNoteDate(note.createdAt)}
                  </time>
                  <IconButton
                    label="删除这条便签"
                    size="sm"
                    tone="danger"
                    icon={<Trash2 size={12} />}
                    onClick={() => removeNote(note.id)}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="添加智能体"
        description="从本机已发现的 CLI Agent 里多选；它们会加入这个空间的启用列表（本机偏好）。"
        size="md"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>取消</Button>
            <Button variant="primary" onClick={addSelectedAgents} disabled={selection.length === 0}>
              {selection.length > 0 ? `添加 ${selection.length} 个` : '添加'}
            </Button>
          </>
        )}
      >
        {discovered.length === 0 ? (
          <EmptyState
            icon={<Bot size={18} />}
            title="没有检测到本机 Agent"
            description="装好 Codex / Claude Code / OpenClaw / OpenCode 后回到「智能体」页刷新即可。"
          />
        ) : (
          <ul className="wb-agent-picker">
            {discovered.map((agent) => {
              const added = enabledAgents.some((entry) => entry.id === agent.id)
              const checked = selection.includes(agent.id)
              const meta = LOCAL_AGENT_STATUS_META[agent.status]
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`${agent.displayName}${added ? '（已在空间）' : ''}`}
                    disabled={added}
                    className={cn('wb-agent-pick', checked && 'is-checked', added && 'is-added')}
                    onClick={() => toggleSelection(agent.id)}
                  >
                    <span className="wb-agent-pick-check" aria-hidden="true">
                      {checked || added ? <Check size={12} /> : null}
                    </span>
                    <span className="wb-agent-pick-main">
                      <strong>{agent.displayName}</strong>
                      <span>{providerLabel(agent.provider)} · {meta.label}{agent.skillCount > 0 ? ` · ${agent.skillCount} 项能力` : ''}</span>
                    </span>
                    {added ? <Badge tone="neutral">已在空间</Badge> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Modal>
    </div>
  )
}

/** 便签时间：今天显示时刻，更早显示日期。 */
function formatNoteDate(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}
