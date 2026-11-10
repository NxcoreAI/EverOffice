// @vitest-environment happy-dom
/**
 * 「本轮产生的文件」卡条组件测试（AgentChatView 集成）。
 *
 * 锁定这些事：
 * ① 生成类工具（office_create 等）转终态后，文件卡出现在 assistant 正文下方；
 * ② 点击文件卡调用 files.openOriginal（可编辑打开）；
 * ③ slides_draft 的成品不出卡（SlidesProgressCard 专属车道，避免重复）；
 * ④ 卡片右侧的「用外部应用打开」分体控件：默认应用主按钮、关联应用下拉
 *    （默认项标注默认）、文件定位，以及无关联列表时整体隐藏。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatView } from '../src/renderer/src/components/agent/AgentChatView'
import type { DisplayAgentMessage } from '../src/renderer/src/components/agent/useAgentSession'
import type { DisplayAgentToolCall } from '../src/renderer/src/components/agent/agentRunActivity'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-04T06:00:00.000Z'

function assistantMessage(runId: string): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    runId,
    role: 'assistant',
    authorAgentId: null,
    content: '报告已生成，请查收。',
    createdAt: ISO,
  }
}

function userMessage(runId: string): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    runId,
    role: 'user',
    authorAgentId: null,
    content: '帮我生成一份报告',
    createdAt: ISO,
  }
}

function completedTool(over: Partial<DisplayAgentToolCall> & { id: string; name: string }): DisplayAgentToolCall {
  return {
    runId: 'run-1',
    args: {},
    status: 'completed',
    startedAt: ISO,
    completedAt: ISO,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root | null = null
let openOriginal: ReturnType<typeof vi.fn>
let listApplications: ReturnType<typeof vi.fn>
let openWithApplication: ReturnType<typeof vi.fn>
let revealFile: ReturnType<typeof vi.fn>

const PNG_ICON = 'data:image/png;base64,AAAA'
const ASSOCIATED_APPS = [
  { id: '/Applications/WorkBuddy.app', name: 'WorkBuddy.app', default: true, icon: PNG_ICON },
  { id: '/Applications/WPS Office.app', name: 'WPS Office.app', default: false, icon: PNG_ICON },
]

async function flush(rounds = 6, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
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
    runCompletedAtByRun: { 'run-1': ISO },
    runStartedAtByRun: { 'run-1': ISO },
    scopeReady: true,
    sessionLinks: [],
    submitting: false,
    toolCallsByRun: {},
    ...over,
  }
}

async function renderView(over: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<AgentChatView {...baseProps(over)} />)
  })
}

function turnFileButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.agent-turn-file')]
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  openOriginal = vi.fn(() => Promise.resolve({ openedWith: 'in-app' }))
  listApplications = vi.fn(() => Promise.resolve([]))
  openWithApplication = vi.fn(() => Promise.resolve({ openedWith: 'external' }))
  revealFile = vi.fn(() => Promise.resolve())
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    clipboard: { writeText: () => undefined },
    files: { openOriginal, listApplications, openWithApplication, reveal: revealFile },
  }
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
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

describe('AgentTurnFilesCard in AgentChatView', () => {
  it('renders a file card below the assistant message for office_create results', async () => {
    const tool = completedTool({
      id: 'tool-1',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-1', originalName: '季度报告.docx', format: 'docx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    const buttons = turnFileButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toContain('季度报告.docx')
    // 卡片在 assistant 正文下方（同一 turn 容器内、正文之后）。
    const turn = container.querySelector('.agent-assistant-turn')
    expect(turn).not.toBeNull()
    expect(turn!.querySelector('.agent-message')!.compareDocumentPosition(buttons[0]!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders an md file card for markdown_create results', async () => {
    const tool = completedTool({
      id: 'tool-1b',
      name: 'markdown_create',
      result: JSON.stringify({ fileEntryId: 'fe-9', originalName: '会议纪要.md', format: 'md' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    const buttons = turnFileButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toContain('会议纪要.md')
  })

  it('opens the file editable via files.openOriginal on click', async () => {
    const tool = completedTool({
      id: 'tool-2',
      name: 'sheets_create',
      result: JSON.stringify({ fileEntryId: 'fe-2', originalName: '预算.xlsx', format: 'xlsx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await act(async () => {
      turnFileButtons()[0]!.click()
    })
    expect(openOriginal).toHaveBeenCalledWith('fe-2', '预算.xlsx', undefined, { editable: true })
  })

  it('does not render cards for slides_draft artifacts', async () => {
    const tool = completedTool({
      id: 'tool-3',
      name: 'slides_draft',
      result: JSON.stringify({ status: 'completed', fileEntryId: 'fe-3', fileName: '发布会.pptx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    expect(turnFileButtons()).toHaveLength(0)
  })

  it('renders the system-default application control and opens with it on click', async () => {
    listApplications.mockImplementation(() => Promise.resolve(ASSOCIATED_APPS))
    const tool = completedTool({
      id: 'tool-5',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-5', originalName: '合同.docx', format: 'docx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await flush()

    expect(listApplications).toHaveBeenCalledWith('fe-5')
    const primary = container.querySelector<HTMLButtonElement>('.file-open-with-primary')
    expect(primary).not.toBeNull()
    expect(primary!.title).toContain('WorkBuddy.app')
    await act(async () => {
      primary!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openWithApplication).toHaveBeenCalledWith('fe-5')
  })

  it('lists associated applications in the dropdown and opens an explicit app', async () => {
    listApplications.mockImplementation(() => Promise.resolve(ASSOCIATED_APPS))
    const tool = completedTool({
      id: 'tool-6',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-6', originalName: '方案.docx', format: 'docx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await flush()

    const more = container.querySelector<HTMLButtonElement>('.file-open-with-more')
    expect(more).not.toBeNull()
    await act(async () => {
      more!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flush()

    const items = [...document.body.querySelectorAll('[role="menuitem"]')]
      .map((element) => element.textContent ?? '')
    // 默认应用标注「（默认）」；文件定位固定排在最后。
    expect(items[0]).toContain('WorkBuddy.app')
    expect(items[0]).toContain('默认')
    expect(items[1]).toContain('WPS Office.app')
    expect(items.at(-1)).toContain('在访达中显示')

    const target = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((element) => (element.textContent ?? '').includes('WPS Office.app'))
    await act(async () => {
      target!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(openWithApplication).toHaveBeenCalledWith('fe-6', '/Applications/WPS Office.app')
  })

  it('offers file reveal from the dropdown footer', async () => {
    listApplications.mockImplementation(() => Promise.resolve(ASSOCIATED_APPS))
    const tool = completedTool({
      id: 'tool-7',
      name: 'markdown_create',
      result: JSON.stringify({ fileEntryId: 'fe-7', originalName: '纪要.md', format: 'md' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await flush()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.file-open-with-more')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flush()
    const revealItem = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((element) => (element.textContent ?? '').includes('在访达中显示'))
    await act(async () => {
      revealItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(revealFile).toHaveBeenCalledWith('fe-7')
  })

  it('collapses to a single button when only one application is associated', async () => {
    listApplications.mockImplementation(() => Promise.resolve([ASSOCIATED_APPS[0]]))
    const tool = completedTool({
      id: 'tool-8',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-8', originalName: '周报.docx', format: 'docx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await flush()

    expect(container.querySelector('.file-open-with-primary')).not.toBeNull()
    expect(container.querySelector('.file-open-with-more')).toBeNull()
  })

  it('hides the external application control when the platform has no associations', async () => {
    const tool = completedTool({
      id: 'tool-9',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-9', originalName: '附件.xlsx', format: 'xlsx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await flush()
    expect(container.querySelector('.agent-turn-file')).not.toBeNull()
    expect(container.querySelector('.file-open-with')).toBeNull()
  })

  it('renders nothing when the run has no file-producing tools', async () => {
    const tool = completedTool({
      id: 'tool-4',
      name: 'web_search',
      result: JSON.stringify({ results: [] }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    expect(turnFileButtons()).toHaveLength(0)
  })
})
