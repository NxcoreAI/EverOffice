// @vitest-environment happy-dom
/**
 * 回归（用户报告，2026-11-12）：带工具调用的分级答复，点开「查看详情」
 * 首行必现 `[[details]]`。
 *
 * 根因：gateway 只在 message.completed 落库/广播时解析分级标记，delta 流
 * 原样透传；activity 的流式答案（finalAnswer/pendingAnswer）优先取 delta
 * 原文累计（pendingText），标记行随流进入详情差值的首行。视图层再从
 * rawFinalContent 里切出「displayContent 之后的部分」作为详情——那部分正
 * 以标记行开头。修复：展示侧统一 strip（answerTiering.stripAgentAnswerMarker）。
 *
 * 测试走真实 fold 链路（tool.requested → message.delta → message.completed
 * （带 displayContent）→ run.completed）+ AgentChatView 渲染断言。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@nxcore/agent-contract'

import { AgentChatView } from '../src/renderer/src/components/agent/AgentChatView'
import {
  createAgentRunActivityAccumulator,
  foldAgentRunActivityEvents,
  snapshotAgentRunActivity,
} from '../src/renderer/src/components/agent/agentRunActivity'
import type { DisplayAgentMessage } from '../src/renderer/src/components/agent/useAgentSession'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-12T03:00:00.000Z'

let seq = 0
function event(type: AgentEvent['type'], payload: Record<string, unknown> = {}): AgentEvent {
  seq += 1
  return { id: `evt-${seq}`, sessionId: 'session-1', runId: 'run-1', seq, type, occurredAt: ISO, payload }
}

/** 模型真实输出：正文 + 独立标记行 + 详情（delta 流原样累计）。 */
const MODEL_RAW = '已生成《报告.docx》。结论：两家公司无关联。\n\n[[details]]\n报告分七章：\n1. 核心结论\n2. 基本情况'
/** gateway splitAgentAnswer 的输出：content=去标记全文，displayContent=展示层。 */
const GATEWAY_CONTENT = '已生成《报告.docx》。结论：两家公司无关联。\n\n报告分七章：\n1. 核心结论\n2. 基本情况'
const GATEWAY_DISPLAY = '已生成《报告.docx》。结论：两家公司无关联。'

function tieredRunEvents(): AgentEvent[] {
  return [
    event('run.started'),
    event('tool.requested', { toolCallId: 't1', name: 'word_agent_edit', args: {} }),
    event('tool.completed', { toolCallId: 't1' }),
    event('message.started'),
    ...MODEL_RAW.match(/[\s\S]{1,12}/g)!.map((chunk) => event('message.delta', { delta: chunk })),
    event('message.completed', { role: 'assistant', content: GATEWAY_CONTENT, displayContent: GATEWAY_DISPLAY }),
    event('run.completed'),
  ]
}

describe('activity 流式答案的 [[details]] 清洗（fold 链路）', () => {
  it('completed run 的 finalAnswer 不含标记行', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, tieredRunEvents())
    const snapshot = snapshotAgentRunActivity(acc)
    expect(snapshot.hasTools).toBe(true)
    expect(snapshot.completed).toBe(true)
    expect(snapshot.finalAnswer).not.toContain('[[details]]')
    expect(snapshot.finalAnswer).toBe(GATEWAY_CONTENT)
    // 分级展示层照常透出（气泡切 L0+L1）。
    expect(snapshot.finalDisplayContent).toBe(GATEWAY_DISPLAY)
  })

  it('未完成 run 的 pendingAnswer（纯 delta 累计）同样不含标记行', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, tieredRunEvents().filter((item) => item.type !== 'message.completed' && item.type !== 'run.completed'))
    const snapshot = snapshotAgentRunActivity(acc)
    expect(snapshot.completed).toBe(false)
    expect(snapshot.pendingAnswer).not.toContain('[[details]]')
    expect(snapshot.pendingAnswer).toContain('报告分七章')
  })
})

describe('AgentChatView 分级详情首行不再出现 [[details]]', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  function renderChat(messages: DisplayAgentMessage[], activityByRun: Record<string, unknown>): void {
    void act(() => {
      root.render(
        <AgentChatView
          activeRunId={null}
          agentIdByRun={{}}
          agentNamesById={{}}
          activityByRun={activityByRun as never}
          composer={null}
          currentSessionId="session-1"
          draftHasContent={false}
          error={null}
          loading={false}
          messages={messages}
          onRetryError={() => undefined}
          onRetryPrompt={() => undefined}
          onOpenSessionLink={() => undefined}
          onSelectPrompt={() => undefined}
          pendingNavigationByRun={{}}
          reasoningByRun={{}}
          runCompletedAtByRun={{ 'run-1': ISO }}
          runStartedAtByRun={{ 'run-1': ISO }}
          scopeReady
          sessionLinks={[]}
          submitting={false}
          toolCallsByRun={{}}
        />,
      )
    })
  }

  it('带工具活动的 run：气泡只显示展示层，详情首行是真实内容而非 [[details]]', () => {
    // 与真实链路一致：activity 由事件 fold 得来（pendingText 含标记原文），
    // 消息 content 是 gateway 清洗后的全文。
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, tieredRunEvents())
    const activity = snapshotAgentRunActivity(acc)

    const messages: DisplayAgentMessage[] = [
      { id: 'u1', sessionId: 'session-1', runId: 'run-1', role: 'user', authorAgentId: null, content: '帮我核一下这两家公司', createdAt: ISO },
      { id: 'a1', sessionId: 'session-1', runId: 'run-1', role: 'assistant', authorAgentId: null, content: GATEWAY_CONTENT, displayContent: GATEWAY_DISPLAY, createdAt: ISO },
    ]
    renderChat(messages, { 'run-1': activity })

    const details = container.querySelector('details.agent-answer-details') as HTMLDetailsElement | null
    expect(details).not.toBeNull()
    const body = details!.querySelector('.agent-answer-details-body')!
    // 详情文本里绝无标记行；首行直接是真实内容。
    expect(body.textContent).not.toContain('[[details]]')
    expect(body.textContent).toContain('报告分七章')
    // 正文气泡只渲染展示层，不重复渲染全文。
    const bubble = container.querySelector('article.agent-message[data-role="assistant"]')!
    expect(bubble.textContent).toContain('两家公司无关联')
    expect(bubble.querySelector('.agent-markdown')?.textContent).not.toContain('报告分七章')
  })

  it('无 activity 的历史消息（content 仍是含标记的原文）同样被清洗', () => {
    // 云端/旧数据回看：消息 content 未经过 gateway 分级解析（或流式消息
    // 停在 delta 原文），渲染兜底路径也要去标记。
    const messages: DisplayAgentMessage[] = [
      { id: 'u1', sessionId: 'session-1', runId: 'run-1', role: 'user', authorAgentId: null, content: '查一下', createdAt: ISO },
      { id: 'a1', sessionId: 'session-1', runId: 'run-1', role: 'assistant', authorAgentId: null, content: MODEL_RAW, displayContent: GATEWAY_DISPLAY, createdAt: ISO },
    ]
    renderChat(messages, {})

    const details = container.querySelector('details.agent-answer-details') as HTMLDetailsElement | null
    expect(details).not.toBeNull()
    expect(details!.querySelector('.agent-answer-details-body')!.textContent).not.toContain('[[details]]')
  })
})
