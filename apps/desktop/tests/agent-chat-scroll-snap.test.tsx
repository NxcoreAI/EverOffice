// @vitest-environment happy-dom
/**
 * 回归（用户报告，2026-11-12 二次反馈）：对话区滚动到接近底部时「突然吸附」，
 * 滚动条像被收起来一样慢慢变短；即使修掉追赶带后仍「偶尔出现」——用户明确
 * 不需要任何自动吸附。
 *
 * 残留来源是 onScroll 的 32px 宽带回吸判定：触控板惯性收尾恰好停在距底
 * ≤32px 时（尾部 composer 留白 ≥166px，惯性经常停在里面）会被「补」到底。
 *
 * 最终语义（用户确认）：手势路径上不存在任何「距底 N px 就提前吸附」的判定。
 * 恢复吸底只有四个入口——真正滚到底（≤1px 亚像素容差）、发新消息、点
 * 「回到最新」、切会话/挂载。推到底的滚动由浏览器 clamp 到最大 scrollTop，
 * 天然满足「真到底」，无需预判。
 *
 * 测试 stub 可控几何（scrollTop/scrollHeight/clientHeight + getComputedStyle），
 * 以真实 DOM wheel/scroll 事件驱动 AgentChatView。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatView } from '../src/renderer/src/components/agent/AgentChatView'
import type { DisplayAgentMessage } from '../src/renderer/src/components/agent/useAgentSession'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-12T03:00:00.000Z'
/** 挂载后安装的几何：总高 4000 / 视口 800 → 最大 scrollTop 3200。 */
const TOTAL = 4_000
const VIEW = 800

function userMessage(over: Partial<DisplayAgentMessage> & { id: string; runId: string }): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    role: 'user',
    authorAgentId: null,
    content: '帮我整理会议纪要',
    createdAt: ISO,
    ...over,
  }
}

function assistantMessage(over: Partial<DisplayAgentMessage> & { id: string; runId: string }): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    role: 'assistant',
    authorAgentId: null,
    content: '好的，已经整理完成。这是很长的一段回复。'.repeat(8),
    createdAt: ISO,
    ...over,
  }
}

interface Geometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 覆盖元素的滚动几何读写：set 记回 geometry，读走 stub 值。 */
function installGeometry(el: HTMLElement, geometry: Geometry): void {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = value
    },
  })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  })
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    activeRunId: null,
    agentIdByRun: {},
    agentNamesById: {},
    activityByRun: {},
    composer: null,
    currentSessionId: 'session-1',
    draftHasContent: false,
    error: null,
    loading: false,
    interruptedRunIds: new Set<string>(),
    cancelledRunIds: new Set<string>(),
    onRetryError: () => undefined,
    onRetryPrompt: () => undefined,
    onOpenMention: () => undefined,
    onOpenSessionLink: () => undefined,
    onSelectPrompt: () => undefined,
    pendingNavigationByRun: {},
    reasoningByRun: {},
    resolvingApprovalIds: new Set<string>(),
    runCompletedAtByRun: {},
    runStartedAtByRun: {},
    scopeReady: true,
    sessionLinks: [],
    submitting: false,
    toolCallsByRun: {},
    ...over,
  }
}

let container: HTMLDivElement
let root: Root | null = null
let geometry: Geometry
let conversation: HTMLElement | null = null

async function renderStaticConversation(): Promise<void> {
  const messages: DisplayAgentMessage[] = []
  for (let index = 0; index < 6; index += 1) {
    messages.push(userMessage({ id: `u${index}`, runId: `run-${index}` }))
    messages.push(assistantMessage({ id: `a${index}`, runId: `run-${index}` }))
  }
  await act(async () => {
    root = createRoot(container)
    root.render(<AgentChatView {...baseProps({ messages })} />)
  })
  conversation = container.querySelector<HTMLElement>('.agent-conversation')
  expect(conversation).not.toBeNull()
}

/** 派发一次真实 wheel 事件（deltaY 显式 define，确保合成事件可读）。 */
function wheel(deltaY: number): void {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'deltaY', { value: deltaY })
  Object.defineProperty(event, 'target', { value: conversation })
  conversation!.dispatchEvent(event)
}

/** 模拟原生滚动到某位置（含 scroll 事件）。 */
async function scrollTo(top: number): Promise<void> {
  await act(async () => {
    geometry.scrollTop = top
    conversation!.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

/** 先脱离吸底：wheel 上滑累计 ≥2px 触发 detach。 */
async function detachByWheelUp(): Promise<void> {
  await act(async () => { wheel(-8) })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  window.matchMedia = window.matchMedia ?? ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  // happy-dom 的 getComputedStyle 不一定带 overflowY；isNestedScrollerWheel
  // 需要它判断内层滚动块，这里给个稳定值（外层对话区本身即边界，不受影响）。
  const originalGetComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = originalGetComputedStyle(element)
    return new Proxy(style, {
      get(target, prop: string) {
        if (prop === 'overflowY') return 'auto'
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  conversation = null
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('静态会话：手势路径上不吸附（#scroll-snap 最终语义）', () => {
  it('距底 200px 时一次普通惯性下滚（deltaY=100）不得瞬移贴底', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    await act(async () => { wheel(100) })

    expect(geometry.scrollTop).toBe(3_000)
  })

  it('连续轻滚（deltaY=16）在距底 400px 起不得吸附', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 2_800, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    await act(async () => {
      for (let index = 0; index < 10; index += 1) wheel(16)
    })

    expect(geometry.scrollTop).toBe(2_800)
  })

  it('强甩（deltaY=400）在距底 300px 的静态会话里也不得瞬移', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 2_900, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    await act(async () => { wheel(400) })

    expect(geometry.scrollTop).toBe(2_900)
  })

  it('流式增长期间的下滚手势同样不吸附（用户明确不需要自动吸附）', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    // 流式爆发：内容总高 4000 → 4400，用户追着底部滚。
    geometry.scrollHeight = 4_400
    geometry.scrollTop = 3_300 // 距底 300
    await act(async () => { wheel(400) })
    expect(geometry.scrollTop).toBe(3_300)

    // 继续追到距底 100px：仍不吸附。
    geometry.scrollTop = 3_500
    await act(async () => { wheel(200) })
    expect(geometry.scrollTop).toBe(3_500)
  })
})

describe('真到底才恢复吸底（唯一的手势回吸入口）', () => {
  it('scroll 停在距底 30px（旧 32px 宽带内）不得吸附', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    // 触控板惯性收尾停在距底 30px：这正是「偶尔出现」的轻吸附来源。
    await scrollTo(3_170)

    expect(geometry.scrollTop).toBe(3_170)
  })

  it('scroll 真正到达底部（≤1px）恢复吸底', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    // 原生惯性把手势推到最大 scrollTop（距底 0）。
    await scrollTo(3_200)

    // onScroll 恢复吸底（程序性贴底属预期：之后流式增长会跟随）。
    expect(geometry.scrollTop).toBe(TOTAL)
  })

  it('亚像素容差：距底 0.5px 也算到底', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    // Chromium 分数布局下 scrollTop 可能差零点几像素。
    await scrollTo(3_199.5)

    expect(geometry.scrollTop).toBe(TOTAL)
  })
})

describe('显式动作恢复吸底（保持不变）', () => {
  it('点「回到最新」贴底', async () => {
    await renderStaticConversation()
    geometry = { scrollTop: 3_000, scrollHeight: TOTAL, clientHeight: VIEW }
    installGeometry(conversation!, geometry)
    await detachByWheelUp()

    const jump = container.querySelector<HTMLButtonElement>('.agent-chat-jump-latest')
    expect(jump).not.toBeNull()
    await act(async () => { jump!.click() })

    expect(geometry.scrollTop).toBe(TOTAL)
  })
})
