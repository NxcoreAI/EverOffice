// @vitest-environment happy-dom
/**
 * 模型档位端到端接线回归（桌面渲染层 → hook → preload API 契约）：
 * 1) 草稿态选择档位只改默认值，首条消息建会话时显式带上 modelPreference；
 * 2) 已有会话选择档位会 PATCH updateSession（回写 activeAgentId），
 *    触发钮立即显示新档位，不再出现「切换将在新对话中生效」的锁定提示。
 */
import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatDock } from '../src/renderer/src/office-proto/AgentChatDock'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-30T06:00:00.000Z'
const FILE: OfficeFile = {
  id: 'real:file-model-tier',
  name: '模型档位测试.docx',
  kind: 'docx',
  roomId: null,
  updatedLabel: '刚刚',
  sizeLabel: '12 KB',
  memoryCount: 0,
  content: { type: 'md', source: '' },
}

type Tier = 'smart' | 'primary' | 'lite'

function agentIdForTier(tier: Tier | undefined): string {
  if (tier === 'primary') return 'main-direct'
  if (tier === 'lite') return 'main-lite'
  return 'main'
}

function makeSession(over: Partial<AgentSession> & { id: string; pageLabel: string }): AgentSession {
  return {
    workspaceId: 'default',
    roomId: null,
    runtimeId: 'rt-main',
    title: over.title ?? null,
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

function fakeGateway(initial: AgentSession[] = []) {
  const sessions: AgentSession[] = [...initial]
  const snapshotOf = (session: AgentSession): AgentSessionSnapshot => ({
    session,
    participants: [],
    activeRun: null,
    messages: [],
    lastEventSeq: 0,
  })
  return {
    listSessions: vi.fn(async (pageLabel?: string) =>
      pageLabel === undefined ? [...sessions] : sessions.filter((session) => session.pageLabel === pageLabel)),
    createSession: vi.fn(async (input: {
      pageLabel: string
      workspaceId?: string | null
      modelPreference?: Tier
      thinkingLevel?: string | null
    }) => {
      const tier = input.modelPreference ?? 'smart'
      const created = makeSession({
        id: `created-${sessions.length + 1}`,
        pageLabel: input.pageLabel,
        workspaceId: input.workspaceId ?? 'default',
        activeAgentId: agentIdForTier(tier),
        modelPreference: tier,
        thinkingLevel: input.thinkingLevel ?? null,
      })
      sessions.push(created)
      return created
    }),
    getSession: vi.fn(async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      return snapshotOf(session)
    }),
    getEvents: vi.fn(async () => []),
    startRun: vi.fn(async (sessionId: string, input: { prompt: string }) => ({
      id: 'run-1',
      sessionId,
      status: 'accepted' as const,
      prompt: input.prompt,
      lastEventSeq: 0,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: ISO,
    })),
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    setThinkingLevel: vi.fn(async (_sessionId: string, level: string | null) => ({
      thinkingLevel: level,
      applied: true,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    updateSession: vi.fn(async (sessionId: string, input: { title?: string | null; modelPreference?: Tier }) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      if (input.title !== undefined) session.title = input.title
      if (input.modelPreference !== undefined) {
        session.modelPreference = input.modelPreference
        session.activeAgentId = agentIdForTier(input.modelPreference)
      }
      return session
    }),
    deleteSession: vi.fn(async () => undefined),
    generateSessionTitle: vi.fn(async () => ({ title: '新标题' })),
  }
}

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

let gateway: ReturnType<typeof fakeGateway>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  window.localStorage.clear()
  vi.restoreAllMocks()
})

async function renderDock(): Promise<void> {
  await act(async () => {
    root.render(<AgentChatDock file={FILE} onToast={() => undefined} />)
  })
  await flush()
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

/** DSH 式两级菜单：点模型触发钮 → root 面板「模型」行 → 档位选项列表。 */
async function openModelTierPicker(): Promise<HTMLElement[]> {
  const trigger = container.querySelector<HTMLElement>('.agent-model-tier-toggle')
  expect(trigger, '非渠道会话应渲染模型选择触发钮').not.toBeNull()
  await act(async () => {
    trigger!.click()
  })
  await flush(2)
  const modelCell = [...container.querySelectorAll<HTMLElement>('.agent-model-picker[data-pane="root"] .agent-model-cell')]
    .find((cell) => cell.querySelector('.agent-model-cell-label')?.textContent === '模型')
  expect(modelCell, 'root 面板应有「模型」入口行').not.toBeUndefined()
  await act(async () => {
    modelCell!.click()
  })
  return [...container.querySelectorAll<HTMLElement>('.agent-model-picker[data-pane="model"] [role="menuitemradio"]')]
}

function tierOption(options: HTMLElement[], label: string): HTMLElement {
  const option = options.find((item) => item.textContent?.includes(label))
  expect(option, `档位选项应包含 ${label}`).not.toBeUndefined()
  return option!
}

describe('模型档位端到端接线', () => {
  it('草稿态选择档位只改默认值，首条消息建会话时显式带上 modelPreference', async () => {
    gateway = fakeGateway([])
    ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }

    await renderDock()
    const options = await openModelTierPicker()
    await act(async () => {
      tierOption(options, '强模型').click()
    })
    await flush(2)

    // 草稿态没有会话可回写：只持久化「下次新会话默认值」。
    expect(gateway.updateSession).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('nxcore-ce:agent-model-preference:v1')).toBe('primary')

    const textarea = container.querySelector<HTMLTextAreaElement>('.agent-composer-input textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      setTextareaValue(textarea!, '你好')
    })
    await act(async () => {
      container.querySelector<HTMLElement>('.agent-prompt-submit')!.click()
    })
    await flush()

    expect(gateway.createSession).toHaveBeenCalledTimes(1)
    expect(gateway.createSession.mock.calls[0][0]).toMatchObject({
      pageLabel: FILE.id,
      modelPreference: 'primary',
    })
  })

  it('已有会话点「强模型」会 PATCH 回写并立即更新触发钮，不再显示锁定提示', async () => {
    gateway = fakeGateway([
      makeSession({
        id: 'session-1',
        pageLabel: FILE.id,
        title: '已有对话',
        activeAgentId: 'main',
        modelPreference: 'smart',
      }),
    ])
    ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }

    await renderDock()
    const options = await openModelTierPicker()
    // 旧文案已删除：选择器里不应再出现「切换将在新对话中生效」。
    expect(container.textContent).not.toContain('会话开始后档位锁定')
    expect(container.textContent).not.toContain('切换将在新对话中生效')
    await act(async () => {
      tierOption(options, '强模型').click()
    })
    await flush(2)

    expect(gateway.updateSession).toHaveBeenCalledWith('session-1', { modelPreference: 'primary' })
    const trigger = container.querySelector<HTMLElement>('.agent-model-tier-toggle')
    expect(trigger!.textContent).toContain('强模型')
    expect(trigger!.dataset.tier).toBe('primary')
    expect(window.localStorage.getItem('nxcore-ce:agent-model-preference:v1')).toBe('primary')
  })
})