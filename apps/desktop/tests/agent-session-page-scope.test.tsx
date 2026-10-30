// @vitest-environment happy-dom
/**
 * 回归：文件标签右侧 Agent 停靠栏的会话必须「读写的分区键一致」。
 *
 * 停靠栏以 `useAgentSession(file.name)` 列出会话，网关 `GET /v1/agent/sessions`
 * 对 pageLabel 做**精确匹配**（apps/gateway/src/modules/agent/service.ts:1125）。
 * 若 `createSession` 里写死 pageLabel: 'Agent'，停靠栏新建的会话就没有一个能被
 * 自己列出来：首次打开下拉为空，离开标签再回来（组件重挂 → 重新 listSessions）
 * 会话从下拉里消失，形成「对话记录找不到」。
 *
 * 这里用一个与网关同语义的假网关（pageLabel 精确过滤）驱动真实 hook，断言
 * 「停靠栏模式（不传 workspaceId）下创建会话用当前页面做 pageLabel，且重挂后
 * 能从列表里恢复并选中」。
 */
import type {
  AgentSession,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentSession } from '../src/renderer/src/components/agent/useAgentSession'

// React 18 的 act() 需要显式声明测试环境。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STORED_SESSION_KEY = 'nxcore-ce:agent-session:v2'
const FILE_PAGE_LABEL = '周报：连接器统一排期.docx'
const OTHER_PAGE_LABEL = 'Agent'
const ISO = '2026-10-30T06:00:00.000Z'

type SessionInput = { pageLabel: string; workspaceId?: string | null }

function makeSession(over: Partial<AgentSession> & { id: string; pageLabel: string }): AgentSession {
  return {
    workspaceId: null,
    roomId: null,
    runtimeId: 'rt-main',
    title: over.title ?? null,
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

/**
 * 与 gateway service.listSessions 同语义的最小假网关：
 * pageLabel 精确匹配、创建时把输入原样落库。偏离真实实现会让回归测试说谎。
 */
function fakeGateway(initial: AgentSession[] = []) {
  const sessions: AgentSession[] = [...initial]
  let seq = sessions.length

  const snapshotOf = (session: AgentSession): AgentSessionSnapshot => ({
    session,
    participants: [],
    activeRun: null,
    messages: [],
    lastEventSeq: 0,
  })

  const api = {
    listSessions: vi.fn(async (pageLabel?: string) =>
      pageLabel === undefined ? [...sessions] : sessions.filter((session) => session.pageLabel === pageLabel)),
    createSession: vi.fn(async (input: SessionInput) => {
      seq += 1
      const created = makeSession({
        id: `created-${seq}`,
        pageLabel: input.pageLabel,
        workspaceId: input.workspaceId ?? null,
        title: null,
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
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    updateSession: vi.fn(async (sessionId: string, input: { title?: string | null }) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      if (input.title !== undefined) session.title = input.title
      return session
    }),
  }

  return { api, sessions }
}

type Hook = ReturnType<typeof useAgentSession>

/** 最小宿主：把 hook 的实时值暴露给测试，不掺任何 UI。 */
function harness(pageLabel: string) {
  let current: Hook | null = null
  function Probe({ label }: { label: string }) {
    current = useAgentSession(label, null, [])
    return <div data-testid="probe" />
  }
  return {
    Probe,
    get hook(): Hook {
      if (!current) throw new Error('probe not mounted')
      return current
    },
  }
}

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

let container: HTMLDivElement
let root: Root
let gateway: ReturnType<typeof fakeGateway>

beforeEach(() => {
  gateway = fakeGateway()
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway.api }
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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

describe('文件停靠栏会话分区键', () => {
  it('停靠栏新建会话时用当前文件（pageLabel）落库，而不是写死 Agent', async () => {
    const probe = harness(FILE_PAGE_LABEL)
    await act(async () => {
      root.render(<probe.Probe label={FILE_PAGE_LABEL} />)
    })
    await flush()

    expect(gateway.api.listSessions).toHaveBeenCalledWith(FILE_PAGE_LABEL)
    expect(probe.hook.sessions).toHaveLength(0)

    await act(async () => {
      await probe.hook.createSession()
    })
    await flush()

    // 核心断言：写进网关的分区键必须与停靠栏读取时用的键一致。
    expect(gateway.api.createSession).toHaveBeenCalledTimes(1)
    expect(gateway.api.createSession.mock.calls[0]![0].pageLabel).toBe(FILE_PAGE_LABEL)
    expect(gateway.sessions).toHaveLength(1)
    expect(probe.hook.sessions).toHaveLength(1)
  })

  it('离开文件标签再回来（组件重挂）后能从下拉恢复该文件的对话记录', async () => {
    const first = harness(FILE_PAGE_LABEL)
    await act(async () => {
      root.render(<first.Probe label={FILE_PAGE_LABEL} />)
    })
    await flush()
    await act(async () => {
      await first.hook.createSession()
    })
    await flush()
    const createdId = first.hook.sessionId
    expect(createdId).not.toBeNull()

    // 模拟切到别的标签：文件标签宿主卸载（FileTabHost 只在激活时挂载）。
    await act(async () => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<first.Probe label={FILE_PAGE_LABEL} />)
    })
    await flush()

    // 重新挂载后必须列得出、并选回同一条会话（旧实现这里列表为空、停在「新对话」）。
    expect(first.hook.sessions.map((session) => session.id)).toContain(createdId)
    expect(first.hook.sessionId).toBe(createdId)
  })

  it('全局记忆里的会话不属于当前文件时，回落到本文件最近的对话', async () => {
    gateway = fakeGateway([
      makeSession({ id: 'file-session', pageLabel: FILE_PAGE_LABEL, title: '本文件的对话' }),
      makeSession({ id: 'other-session', pageLabel: OTHER_PAGE_LABEL, title: '别处的对话' }),
    ])
    ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway.api }
    // 上一次使用时记住的是另一个分区（如工作台）的会话。
    window.localStorage.setItem(STORED_SESSION_KEY, JSON.stringify('other-session'))

    const probe = harness(FILE_PAGE_LABEL)
    await act(async () => {
      root.render(<probe.Probe label={FILE_PAGE_LABEL} />)
    })
    await flush()

    expect(probe.hook.sessions.map((session) => session.id)).toEqual(['file-session'])
    expect(probe.hook.sessionId).toBe('file-session')
  })
})
