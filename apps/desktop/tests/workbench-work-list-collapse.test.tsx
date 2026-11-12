// @vitest-environment happy-dom
/**
 * 工作空间侧栏「工作」列表折叠回归：
 * 1) 默认只显示排序后的前 6 条（运行中优先、最新在前），计数仍显示总数，
 *    底部出现「显示全部」；不足 6 条时没有开关；
 * 2) 点「显示全部」展开全部并变为「收起」，点「收起」回到 6 条；
 * 3) 草稿行不占折叠名额（新工作草稿置顶显示，列表仍显示前 6 条会话）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import { WorkspaceSidebar } from '../src/renderer/src/workbench/shell/WorkspaceSidebar'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import type { WorkspaceTab } from '../src/renderer/src/workbench/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-02T08:00:00.000Z'

const WORKSPACE: AgentWorkspace = {
  id: 'ws-1',
  name: '连接器项目',
  description: null,
  goals: [],
  path: null,
  kind: 'custom',
  createdAt: ISO,
  updatedAt: ISO,
  lastOpenedAt: ISO,
}

const TAB: WorkspaceTab = {
  id: 'ws:ws-1',
  kind: 'workspace',
  workspaceId: 'ws-1',
  view: { kind: 'page', page: 'overview' },
}

function session(over: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    workspaceId: 'ws-1',
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'rt-main',
    title: over.id,
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

/** 8 条会话：s-1 最新（11-08），s-8 最旧（11-01）。 */
function eightSessions(): AgentSession[] {
  return Array.from({ length: 8 }, (_, index) => session({
    id: `s-${index + 1}`,
    updatedAt: `2026-11-${String(8 - index).padStart(2, '0')}T08:00:00.000Z`,
  }))
}

let container: HTMLDivElement
let root: Root | null = null

async function flush(rounds = 6, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

async function renderSidebar(tab: WorkspaceTab = TAB): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<WorkspaceSidebar tab={tab} />)
  })
  await flush()
}

function rowTitles(): string[] {
  return [...container.querySelectorAll('.wb-ws-work-row .wb-ws-work-title')]
    .map((element) => (element as HTMLElement).textContent ?? '')
    .filter((text) => text !== '新工作') // 草稿行单独断言
}

function toggleButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.wb-ws-work-toggle')
}

async function clickToggle(): Promise<void> {
  const button = toggleButton()
  if (!button) throw new Error('折叠开关未渲染')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useWorkbenchStore.setState({
    workspaces: [WORKSPACE],
    sessions: [],
    tabs: [TAB],
    activeTabId: TAB.id,
  })
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('侧栏工作列表折叠', () => {
  it('默认只显示前 6 条（最新优先），计数为总数，出现「显示全部」', async () => {
    useWorkbenchStore.setState({ sessions: eightSessions() })
    await renderSidebar()

    expect(rowTitles()).toEqual(['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'])
    expect(container.querySelector('.wb-ws-work-count')?.textContent).toBe('8')
    expect(toggleButton()?.textContent).toBe('显示全部 8 条')
  })

  it('运行中的会话置顶并计入前 6 条', async () => {
    // s-8 最旧但在跑：排序后应排第一，把较旧的 s-6 挤出折叠窗口。
    const sessions = eightSessions()
    sessions[7] = session({ id: 's-8', status: 'running', updatedAt: '2026-10-01T08:00:00.000Z' })
    useWorkbenchStore.setState({ sessions })
    await renderSidebar()

    expect(rowTitles()).toEqual(['s-8', 's-1', 's-2', 's-3', 's-4', 's-5'])
  })

  it('点「显示全部」展开全部，再点「收起」回到 6 条', async () => {
    useWorkbenchStore.setState({ sessions: eightSessions() })
    await renderSidebar()

    await clickToggle()
    expect(rowTitles()).toHaveLength(8)
    expect(toggleButton()?.textContent).toBe('收起')

    await clickToggle()
    expect(rowTitles()).toEqual(['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'])
    expect(toggleButton()?.textContent).toBe('显示全部 8 条')
  })

  it('不足 6 条时不出现折叠开关', async () => {
    useWorkbenchStore.setState({
      sessions: [
        session({ id: 'a', updatedAt: '2026-11-03T08:00:00.000Z' }),
        session({ id: 'b', updatedAt: '2026-11-02T08:00:00.000Z' }),
      ],
    })
    await renderSidebar()

    expect(rowTitles()).toEqual(['a', 'b'])
    expect(toggleButton()).toBeNull()
  })

  it('草稿行不占折叠名额：新工作草稿置顶，会话仍显示前 6 条', async () => {
    useWorkbenchStore.setState({ sessions: eightSessions() })
    await renderSidebar({ ...TAB, view: { kind: 'draft' } })

    const draftRow = container.querySelector('.wb-ws-work-row.is-draft .wb-ws-work-title')
    expect(draftRow?.textContent).toBe('新工作')
    expect(rowTitles()).toEqual(['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'])
  })

  it('打开折叠窗口外的旧工作：列表自动展开让当前会话可见', async () => {
    useWorkbenchStore.setState({ sessions: eightSessions() })
    // s-8 最旧，折叠时排在窗口外；从概览/命令面板点开会落到 session 视图。
    await renderSidebar({ ...TAB, view: { kind: 'session', sessionId: 's-8' } })

    expect(rowTitles()).toHaveLength(8)
    expect(rowTitles()).toContain('s-8')
    expect(toggleButton()?.textContent).toBe('收起')
  })
})
