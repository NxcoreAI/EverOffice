// EverRoom agent 聊天的原型数据源：脚本化 window.nxcore.agent mock。
// 事件按 agent-contract 的 AgentEvent 协议吐出（run.accepted → tool.* →
// message.delta 流式 → approval.requested → run.completed），叙事沿用
// 仓库 mock 世界观（周报起草 / 供应商比价 / 记忆引用）。
import type {
  AgentEvent, AgentMessage, AgentRun, AgentSession, AgentSessionSnapshot,
  AgentSocketFrame, StartAgentRunInput,
} from '@nxcore/agent-contract'
import type { NxcoreDesktopApi } from '@/shared/sources'

type Listener = (frame: AgentSocketFrame) => void

interface MockState {
  sessions: AgentSession[]
  messages: Record<string, AgentMessage[]>
  eventsByRun: Map<string, AgentEvent[]>
}

const listeners = new Set<Listener>()
let seq = 100
let installed = false

const state: MockState = { sessions: [], messages: {}, eventsByRun: new Map() }

function mkEvent(sessionId: string, runId: string, type: AgentEvent['type'], payload: unknown): AgentEvent {
  seq += 1
  return {
    id: `mock-e${seq}`,
    sessionId,
    runId,
    seq,
    type,
    occurredAt: new Date().toISOString(),
    payload,
  }
}

function emit(event: AgentEvent) {
  const frame: AgentSocketFrame = { type: 'event', protocol: 1, event }
  for (const listener of listeners) listener(frame)
}

function pushMessage(sessionId: string, message: AgentMessage) {
  state.messages[sessionId] = [...(state.messages[sessionId] ?? []), message]
}

// ---- 种子会话（历史 run，打开即有完整时间线与审阅记录） ----

function seedHistoryRun(sessionId: string, runId: string, prompt: string, answer: string, tools: Array<{ name: string; args: Record<string, unknown>; result: string }>) {
  const events: AgentEvent[] = [
    mkEvent(sessionId, runId, 'run.accepted', { prompt }),
    mkEvent(sessionId, runId, 'run.started', {}),
  ]
  tools.forEach((tool, index) => {
    const toolCallId = `${runId}-tool-${index}`
    events.push(
      mkEvent(sessionId, runId, 'tool.requested', { toolCallId, name: tool.name, args: tool.args }),
      mkEvent(sessionId, runId, 'tool.started', { toolCallId, name: tool.name, args: tool.args }),
      mkEvent(sessionId, runId, 'tool.completed', { toolCallId, result: tool.result }),
    )
  })
  events.push(
    mkEvent(sessionId, runId, 'message.started', {}),
    mkEvent(sessionId, runId, 'message.completed', { content: answer }),
    mkEvent(sessionId, runId, 'run.completed', {}),
  )
  state.eventsByRun.set(runId, events)
  pushMessage(sessionId, {
    id: `${runId}-user`, sessionId, runId, role: 'user', authorAgentId: null,
    content: prompt, createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  })
  pushMessage(sessionId, {
    id: `${runId}-asst`, sessionId, runId, role: 'assistant', authorAgentId: 'main',
    content: answer, createdAt: new Date(Date.now() - 89 * 60_000).toISOString(),
  })
}

function seed() {
  const now = new Date().toISOString()
  const notes: AgentSession = {
    id: 'mock-s-notes', roomId: null, pageLabel: '产品调研笔记.md', runtimeId: 'mock-runtime',
    title: '调研笔记整理', status: 'idle', createdAt: now, updatedAt: now, activeAgentId: 'main',
  }
  state.sessions.push(notes)
  seedHistoryRun(
    notes.id, 'mock-run-notes', '把这条链路的调研结论整理成要点',
    [
      '已把「Gmail 双链路」的调研结论整理为三块：',
      '',
      '1. **现状**：oo runs 与 managed-gmail 分表并存，排障成本集中在身份不一致；',
      '2. **目标**：双链路并入统一格式层，映射表三处同值收口；',
      '3. **下一步**：确认会话失效静默的复现路径，再排联调窗口。',
      '',
      '相关引用已锚定在笔记原文里，点击可回到原始材料。',
    ].join('\n'),
    [
      { name: 'memory.search', args: { query: 'Gmail 双链路' }, result: '{"hits":6,"top":["连接器架构评审","oo runs 分表说明","managed-gmail 迁移记录"]}' },
      { name: 'document.read', args: { document: '产品调研笔记.md' }, result: '{"sections":4,"citations":3}' },
    ],
  )

  const weekly: AgentSession = {
    id: 'mock-s-weekly', roomId: null, pageLabel: '周报：连接器统一排期.docx', runtimeId: 'mock-runtime',
    title: '周报起草', status: 'idle', createdAt: now, updatedAt: now, activeAgentId: 'main',
  }
  state.sessions.push(weekly)
  seedHistoryRun(
    weekly.id, 'mock-run-weekly', '基于本周邮件和会议写周报',
    [
      '周报已起草完成：本周结论 3 条、风险 1 条、下周计划 3 条，全部带引用锚点。',
      '',
      '- 本周结论：身份合并与命名对齐进入阶段一；映射表收口过半；V1 视觉定稿。',
      '- 风险：视觉与连接器里程碑同周重叠，需提前取舍。',
      '- 下周计划：完成映射表收口 / 同步连接器视觉 / 输出联调环境清单。',
    ].join('\n'),
    [
      { name: 'memory.search', args: { query: '本周 连接器 进展' }, result: '{"hits":42,"top":["设计周报","周会纪要 0928","Wiki·双链路收敛"]}' },
      { name: 'mail.search', args: { query: '连接器 排期', window: '7d' }, result: '{"count":18,"threads":6}' },
      { name: 'document.write', args: { document: '周报：连接器统一排期.docx', edits: 3 }, result: '{"applied":true,"citations":4}' },
    ],
  )
}

// ---- 脚本化新 run：工具时间线 + 流式回答 + 写入审阅 ----

const timers = new Set<ReturnType<typeof setTimeout>>()
function later(ms: number, fn: () => void) {
  const t = setTimeout(() => { timers.delete(t); fn() }, ms)
  timers.add(t)
}

function scriptedAnswer(prompt: string, fileName: string): string {
  return [
    `好的，围绕「${prompt.length > 18 ? `${prompt.slice(0, 18)}…` : prompt}」我翻了这份${fileName.includes('周报') ? '周报' : '文档'}相关联的记忆与材料，结论如下：`,
    '',
    '- **关键结论**：连接器阶段一范围确认（身份合并 + 命名对齐），联调窗口 10/28–11/05；',
    '- **引用锚点**：结论均来自设计周报（邮件）与周会纪要 0928（会议），可点击回源；',
    '- **建议动作**：把映射表三处同值的收口进度补进正文，并在风险一节标注与 V1 视觉里程碑的撞期。',
    '',
    '改动建议已生成，等你审阅后写入文档。',
  ].join('\n')
}

function driveRun(sessionId: string, runId: string, prompt: string, fileName: string) {
  const fire = (type: AgentEvent['type'], payload: unknown) => {
    const event = mkEvent(sessionId, runId, type, payload)
    state.eventsByRun.set(runId, [...(state.eventsByRun.get(runId) ?? []), event])
    emit(event)
  }
  fire('run.accepted', { prompt })
  later(160, () => fire('run.started', {}))

  const tools: Array<{ name: string; args: Record<string, unknown>; result: string; ms: number }> = [
    { name: 'memory.search', args: { query: prompt.slice(0, 24) }, result: '{"hits":9,"top":["设计周报","周会纪要 0928","供应商报价（Q4）"]}', ms: 500 },
    { name: 'document.read', args: { document: fileName }, result: '{"sections":4,"citations":3,"memoryRefs":6}', ms: 700 },
  ]
  let t = 420
  tools.forEach((tool, index) => {
    const toolCallId = `${runId}-tool-${index}`
    later(t, () => fire('tool.requested', { toolCallId, name: tool.name, args: tool.args }))
    later(t + 220, () => fire('tool.started', { toolCallId, name: tool.name, args: tool.args }))
    later(t + tool.ms + 300, () => fire('tool.completed', { toolCallId, result: tool.result }))
    t += tool.ms + 380
  })

  later(t + 120, () => fire('message.started', {}))
  const full = scriptedAnswer(prompt, fileName)
  const chunk = 18
  const pieces = Math.ceil(full.length / chunk)
  for (let i = 0; i < pieces; i += 1) {
    later(t + 240 + i * 55, () => fire('message.delta', { delta: full.slice(i * chunk, (i + 1) * chunk) }))
  }
  const afterStream = t + 240 + pieces * 55 + 120
  later(afterStream, () => fire('message.completed', { content: full }))
  later(afterStream + 260, () => fire('approval.requested', {
    approvalId: `${runId}-approval`,
    toolName: 'document.write',
    command: `写入 ${fileName}：3 处修改 · 引用 4 条记忆`,
  }))
  later(afterStream + 300, () => {
    fire('run.completed', {})
    const session = state.sessions.find((s) => s.id === sessionId)
    if (session) { session.status = 'idle'; session.updatedAt = new Date().toISOString() }
  })
}

// ---- 安装 ----

export function installAgentChatMock() {
  if (installed) return
  installed = true
  seed()

  // 休眠面板（连接器授权 / 写作风格 / 文档操作）的万能兜底：EverRoom 各面板对
  // 可选 API 的用法混杂——onEvent/subscribe 取「注销函数」，status/list 走 .then 链。
  // 这里返回「可调用 + 可 then」的句柄兜底，休眠分支不崩溃。
  const callableThenable = (): (() => unknown) => {
    // 返回自身：既可被继续调用（注销句柄），又可 .then 链（status/list 等）。
    const fn = (() => fn) as unknown as () => unknown
    ;(fn as unknown as { then: (cb: (v: unknown) => unknown) => Promise<unknown> }).then = (cb) =>
      Promise.resolve(cb({ items: [], operations: [], status: 'ok' }))
    return fn
  }
  const asyncSurface = new Proxy({}, { get: () => callableThenable() })

  const apiLike: Record<string, unknown> = {
    agent: {
      listSessions: async (pageLabel?: string, _roomId?: string | null) =>
        pageLabel ? state.sessions.filter((s) => s.pageLabel === pageLabel) : [...state.sessions],
      createSession: async (input: { pageLabel?: string; roomId?: string | null; title?: string | null }) => {
        const session: AgentSession = {
          id: `mock-s-${Date.now()}`, roomId: input.roomId ?? null,
          pageLabel: input.pageLabel ?? 'Agent', runtimeId: 'mock-runtime',
          title: input.title ?? null, status: 'idle',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          activeAgentId: 'main',
        }
        state.sessions.push(session)
        state.messages[session.id] = []
        return session
      },
      getSession: async (sessionId: string): Promise<AgentSessionSnapshot> => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) throw new Error(`mock: no session ${sessionId}`)
        return {
          session, participants: [], activeRun: null,
          messages: state.messages[sessionId] ?? [], lastEventSeq: seq,
        }
      },
      getEvents: async (_sessionId: string, runId: string, afterSeq: number) =>
        (state.eventsByRun.get(runId) ?? []).filter((event) => event.seq > afterSeq),
      updateSession: async (sessionId: string, input: { title?: string | null }) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) throw new Error('mock: no session')
        if (input.title !== undefined) session.title = input.title
        return session
      },
      deleteSession: async (sessionId: string) => {
        state.sessions = state.sessions.filter((s) => s.id !== sessionId)
      },
      generateSessionTitle: async (input: { userText: string }) => ({
        title: input.userText.replace(/\s+/g, ' ').slice(0, 16) || '新会话',
      }),
      suggestStarterPrompts: async () => ({
        prompts: ['把这份材料整理成结论要点', '基于记忆续写一节', '找出文中与连接器排期相关的引用'],
      }),
      suggestConversationPrompt: async () => ({ suggestion: '' }),
      startRun: async (sessionId: string, input: StartAgentRunInput): Promise<AgentRun> => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) throw new Error('mock: no session')
        const runId = `mock-run-${Date.now()}`
        const prompt = input.displayPrompt ?? input.prompt
        const run: AgentRun = {
          id: runId, sessionId, agentId: 'main', status: 'running', prompt,
          lastEventSeq: seq, error: null,
          startedAt: new Date().toISOString(), completedAt: null, createdAt: new Date().toISOString(),
        }
        state.eventsByRun.set(runId, [])
        pushMessage(sessionId, {
          id: `${runId}-user`, sessionId, runId, role: 'user', authorAgentId: null,
          content: prompt, createdAt: new Date().toISOString(),
        })
        pushMessage(sessionId, {
          id: `${runId}-asst`, sessionId, runId, role: 'assistant', authorAgentId: 'main',
          content: '', createdAt: new Date().toISOString(),
        })
        session.status = 'running'
        session.title = session.title ?? prompt.slice(0, 16)
        driveRun(sessionId, runId, prompt, session.pageLabel)
        return run
      },
      cancelRun: async (runId: string) => {
        for (const t of timers) clearTimeout(t)
        timers.clear()
        const [sessionId] = [state.eventsByRun.get(runId)?.[0]?.sessionId].filter(Boolean) as string[]
        if (sessionId) {
          const event = mkEvent(sessionId, runId, 'run.cancelled', {})
          state.eventsByRun.set(runId, [...(state.eventsByRun.get(runId) ?? []), event])
          emit(event)
          const session = state.sessions.find((s) => s.id === sessionId)
          if (session) session.status = 'interrupted'
        }
        return { id: runId, sessionId, agentId: 'main', status: 'cancelled' as const, prompt: '', lastEventSeq: seq, error: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString() } as AgentRun
      },
      resolveApproval: async (approvalId: string, decision: string) => {
        const runId = approvalId.replace(/-approval$/, '')
        const sessionId = state.eventsByRun.get(runId)?.[0]?.sessionId
        if (sessionId) {
          const event = mkEvent(sessionId, runId, 'approval.resolved', { approvalId, decision })
          state.eventsByRun.set(runId, [...(state.eventsByRun.get(runId) ?? []), event])
          emit(event)
        }
        return { approvalId, decision }
      },
      getPermissionMode: async () => ({ mode: 'ask_before_write' as const, available: ['ask_before_write', 'accept_edits', 'auto'] as const, channelAgentId: null }),
      setPermissionMode: async (_sessionId: string, mode: string) => ({ mode, applied: true }),
      subscribe: async () => { /* mock 直发，无需订阅握手 */ },
      unsubscribe: async () => { /* noop */ },
      onEvent: (listener: Listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getStatus: async () => ({ status: 'ok', agents: [] }),
      discoverLocalAgents: async () => [],
      checkLocalAgentAdapters: async () => [],
      listSessionLinks: async () => [],
      createSessionLink: async () => { throw new Error('mock: unsupported') },
      markSessionLinkReturned: async () => { throw new Error('mock: unsupported') },
      submitPendingIntent: async () => { throw new Error('mock: unsupported') },
    },
    contextRooms: {
      listRunSubagentInvocations: async () => [],
      listSubagentInvocationEvents: async () => [],
    },
    // 休眠面板（连接器授权 / 写作风格 / 文档操作）的万能兜底：见下方 asyncSurface 注释。
    agentAuth: asyncSurface,
    writingStyle: asyncSurface,
    documents: asyncSurface,
    // LocaleContext 的 detectLocale / setLocale 走 locale 表面
    locale: {
      system: 'zh-CN', current: 'zh-CN',
      getSystem: async () => 'zh-CN',
      set: async () => ({ locale: 'zh-CN' }),
    },
  }

  // EverRoomMac 迁移：preload 注入了真实 window.nxcore（网关桥）时完全不装 mock，
  // Agent 聊天直接吃真实会话/事件流；只有脱离 Electron preload 的环境（如浏览器
  // 直开 agent-dock 页调试）才落到脚本化 mock。
  if (window.nxcore) return
  window.nxcore = apiLike as unknown as NxcoreDesktopApi
}
