// @vitest-environment happy-dom
/**
 * 工作空间工具页回归：
 * 1) 计划看板分列（running / idle / closed+interrupted）与只读语义；
 * 2) 新建空间三步引导——跳过某一步不丢前面已完成步骤的结果（原型 bug 回归）；
 * 3) 智能体启用列表 / 经验便签按空间持久化读取，桥返回空数组或失败时不崩。
 *
 * 与 tests/office-proto-recent-view.test.tsx 同款 happy-dom + 手动 act/createRoot 写法，
 * 不引入 testing-library；只 mock preload 桥 window.nxcore。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import {
  agentNotesStorageKey,
  enabledAgentsStorageKey,
  readEnabledAgents,
} from '../src/renderer/src/workbench/workspace/agentCatalog'
import { AgentsPage } from '../src/renderer/src/workbench/workspace/AgentsPage'
import { PlanPage, groupPlanColumns } from '../src/renderer/src/workbench/workspace/PlanPage'
import { SetupWizard } from '../src/renderer/src/workbench/workspace/SetupWizard'
import type { WorkspacePageProps } from '../src/renderer/src/workbench/workspace/contracts'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-20T08:00:00.000Z'

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

function makeSession(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    workspaceId: 'ws-1',
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'rt-main',
    title: '工作',
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function pageProps(overrides: Partial<WorkspacePageProps> = {}): WorkspacePageProps {
  return {
    tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'plan' } },
    workspace: WORKSPACE,
    sessions: [],
    onOpenSession: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenPage: vi.fn(),
    onNewWork: vi.fn(),
    onToast: vi.fn(),
    ...overrides,
  }
}

function installNxcore(overrides: {
  getStatus?: () => Promise<unknown>
  discoverLocalAgents?: () => Promise<unknown>
  listServers?: () => Promise<unknown>
  pickAndImport?: () => Promise<unknown>
  createSession?: (input: unknown) => Promise<unknown>
  updateSession?: (sessionId: string, input: { title: string }) => Promise<unknown>
} = {}) {
  const api = {
    agent: {
      getStatus: vi.fn(overrides.getStatus ?? (async () => null)),
      discoverLocalAgents: vi.fn(overrides.discoverLocalAgents ?? (async () => [])),
      createSession: vi.fn(overrides.createSession ?? (async () => ({ id: 'sess-new', title: null }))),
      updateSession: vi.fn(overrides.updateSession ?? (async (sessionId: string) => ({ id: sessionId }))),
    },
    mcp: {
      listServers: vi.fn(overrides.listServers ?? (async () => ({ configPath: null, servers: {} }))),
    },
    files: {
      pickAndImport: vi.fn(overrides.pickAndImport ?? (async () => [])),
    },
  }
  ;(window as unknown as { nxcore?: unknown }).nxcore = api
  return api
}

let container: HTMLDivElement
let root: Root | null = null

async function flush(rounds = 8, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function render(element: React.ReactElement) {
  root = createRoot(container)
  act(() => {
    root?.render(element)
  })
}

function bodyText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

function buttonByText(text: string): HTMLButtonElement {
  const normalized = text.replace(/\s+/g, '')
  const buttons = Array.from(document.body.querySelectorAll('button'))
  const found = buttons.find((button) => (button.textContent ?? '').replace(/\s+/g, '').includes(normalized))
  if (!found) throw new Error(`button not found: ${text} · buttons=${buttons.map((button) => button.textContent).join('|')}`)
  return found
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('click target not found')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  vi.restoreAllMocks()
})

/* ───────────────── 计划看板 ───────────────── */

describe('计划看板分列', () => {
  it('按 running / idle / closed+interrupted 归类，并保持输入顺序', () => {
    const sessions = [
      makeSession({ id: 's-run', status: 'running' }),
      makeSession({ id: 's-idle', status: 'idle' }),
      makeSession({ id: 's-closed', status: 'closed' }),
      makeSession({ id: 's-interrupted', status: 'interrupted' }),
      makeSession({ id: 's-idle-2', status: 'idle' }),
    ]
    const groups = groupPlanColumns(sessions)
    expect(groups.running.map((session) => session.id)).toEqual(['s-run'])
    expect(groups.idle.map((session) => session.id)).toEqual(['s-idle', 's-idle-2'])
    expect(groups.done.map((session) => session.id)).toEqual(['s-closed', 's-interrupted'])
  })

  it('渲染三列计数、卡片点开会话，并明确只读', async () => {
    const onOpenSession = vi.fn()
    const onNewWork = vi.fn()
    render(
      <PlanPage
        {...pageProps({
          sessions: [
            makeSession({ id: 's-run', title: '写发布计划', status: 'running', updatedAt: new Date().toISOString() }),
            makeSession({ id: 's-idle', title: '对比供应商', status: 'idle' }),
            makeSession({ id: 's-closed', title: '整理会议纪要', status: 'closed' }),
          ],
          onOpenSession,
          onNewWork,
        })}
      />,
    )

    const counts = Array.from(document.querySelectorAll('.wb-plan-col-count')).map((node) => node.textContent)
    expect(counts).toEqual(['1', '1', '1'])
    expect(bodyText()).toContain('只读')
    expect(bodyText()).toContain('不能拖拽修改')

    await click(document.querySelector('.wb-plan-card'))
    expect(onOpenSession).toHaveBeenCalledWith('s-run')

    const newWork = buttonByText('新建工作')
    await click(newWork)
    expect(onNewWork).toHaveBeenCalledTimes(1)
  })

  it('空看板每列都有友好空态', async () => {
    render(<PlanPage {...pageProps()} />)
    const counts = Array.from(document.querySelectorAll('.wb-plan-col-count')).map((node) => node.textContent)
    expect(counts).toEqual(['0', '0', '0'])
    expect(bodyText()).toContain('暂无进行中的工作')
    expect(bodyText()).toContain('暂无待开始的工作')
    expect(bodyText()).toContain('暂无已结束的工作')
  })
})

/* ───────────────── 三步引导 ───────────────── */

const IMPORT_OUTCOMES = [
  { filename: '需求.docx', fileId: 'f-1', fileVersionId: 'v-1', error: null, skippedReason: null, deduped: false },
  { filename: '坏文件.zip', fileId: null, fileVersionId: null, error: '不支持的格式', skippedReason: null, deduped: false },
]

const DISCOVERED_AGENTS = [
  {
    id: 'claude',
    provider: 'claude',
    displayName: 'Claude Code',
    status: 'verified',
    callable: true,
    version: '1.2.3',
    card: { skills: [{ id: 'review', name: 'Review' }] },
  },
  {
    id: 'codex',
    provider: 'codex',
    displayName: 'Codex',
    status: 'unavailable',
    callable: false,
  },
]

describe('新建空间三步引导', () => {
  it('跳过第 2 步不丢第 1 步已导入的资料，并能继续创建工作', async () => {
    const api = installNxcore({
      pickAndImport: async () => IMPORT_OUTCOMES,
      discoverLocalAgents: async () => DISCOVERED_AGENTS,
      createSession: async () => ({ id: 'sess-new', title: null }),
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    await click(buttonByText('选择文件并导入'))
    await flush()
    expect(bodyText()).toContain('成功 1')
    expect(bodyText()).toContain('失败 1')

    await click(buttonByText('下一步'))
    await flush()
    // 第 2 步：直接跳过（不添加智能体）。
    await click(buttonByText('跳过本步'))
    await flush()

    // 跳到第 3 步后，第 1 步的结果仍在摘要里（关键回归点）。
    expect(bodyText()).toContain('1 份资料')
    expect(api.files.pickAndImport).toHaveBeenCalledTimes(1)

    const titleInput = document.querySelector<HTMLInputElement>('input[aria-label="工作名称"]')
    if (!titleInput) throw new Error('work title input not found')
    await act(async () => {
      setInputValue(titleInput, '整理发布计划')
    })
    // 步骤条里也有一个同名「添加工作」按钮，这里点表单里的操作按钮。
    await click(document.querySelector('.wb-setup-work-form .ui-btn'))
    await flush()

    expect(api.agent.createSession).toHaveBeenCalledWith({ pageLabel: 'Agent', roomId: null, workspaceId: 'ws-1' })
    expect(api.agent.updateSession).toHaveBeenCalledWith('sess-new', { title: '整理发布计划' })
    expect(bodyText()).toContain('已创建')

    await click(buttonByText('完成'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('在最后一步点「跳过本步」：前面已落库的本机偏好不丢（原型 bug 回归）', async () => {
    const api = installNxcore({
      pickAndImport: async () => [IMPORT_OUTCOMES[0]],
      discoverLocalAgents: async () => DISCOVERED_AGENTS,
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    await click(buttonByText('选择文件并导入'))
    await flush()
    await click(buttonByText('下一步'))
    await flush()

    // 第 2 步：选中 Claude Code 并写入本空间启用列表。
    const agentCheckbox = document.querySelector('[role="checkbox"][aria-label^="Claude Code"]')
    await click(agentCheckbox)
    await click(buttonByText('添加到本空间'))
    await flush()
    expect(readEnabledAgents('ws-1').map((agent) => agent.id)).toEqual(['claude'])

    await click(buttonByText('下一步'))
    await flush()
    expect(bodyText()).toContain('1 个智能体')

    // 最后一步直接跳过：onDone 应被调用，而前两步的结果仍在（localStorage + 导入调用）。
    await click(buttonByText('跳过本步'))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(readEnabledAgents('ws-1').map((agent) => agent.id)).toEqual(['claude'])
    expect(api.files.pickAndImport).toHaveBeenCalledTimes(1)
  })

  it('导入失败给出可读错误，且不阻塞跳过完成', async () => {
    installNxcore({
      pickAndImport: async () => { throw new Error('导入通道不可用') },
      discoverLocalAgents: async () => [],
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    await click(buttonByText('选择文件并导入'))
    await flush()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('导入通道不可用')

    await click(buttonByText('跳过本步'))
    await flush()
    await click(buttonByText('跳过本步'))
    await flush()
    await click(buttonByText('跳过本步'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

/* ───────────────── 智能体页 ───────────────── */

const MAIN_AGENT_STATUS = {
  generatedAt: ISO,
  summary: { total: 2, running: 1, idle: 1, error: 0 },
  agents: [
    {
      agentId: 'main',
      name: '主 Agent',
      description: '',
      kind: 'builtin',
      state: 'running',
      activeRunCount: 1,
      workspace: { id: 'agent://main', isolation: 'dedicated', revisionId: null },
      currentRun: null,
      lastRun: null,
      updatedAt: null,
    },
  ],
}

describe('智能体页', () => {
  it('读取按空间持久化的启用列表并渲染状态/渠道/MCP', async () => {
    localStorage.setItem(enabledAgentsStorageKey('ws-1'), JSON.stringify([
      { id: 'claude', displayName: 'Claude Code', provider: 'claude', enabled: true, addedAt: ISO },
    ]))
    installNxcore({
      getStatus: async () => MAIN_AGENT_STATUS,
      discoverLocalAgents: async () => DISCOVERED_AGENTS,
      listServers: async () => ({
        configPath: '/Users/qa/.everroom/mcp.json',
        servers: { 'files-tool': { command: 'npx', args: ['-y', 'files-mcp'] } },
      }),
    })
    render(<AgentsPage {...pageProps()} />)
    await flush()

    expect(bodyText()).toContain('Claude Code')
    expect(bodyText()).toContain('本机偏好')
    expect(bodyText()).toContain('工作台主 Agent')
    expect(bodyText()).toContain('运行中 · 1')
    expect(bodyText()).toContain('files-tool')
    expect(bodyText()).toContain('npx -y files-mcp')

    // 启停开关写回 localStorage（本机偏好按 workspace.id 隔离）。
    const toggle = document.querySelector('[role="switch"][aria-label^="停用"]')
    await click(toggle)
    await flush()
    expect(readEnabledAgents('ws-1')[0]?.enabled).toBe(false)
    const raw = localStorage.getItem(enabledAgentsStorageKey('ws-1'))
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toMatchObject([{ id: 'claude', enabled: false }])
  })

  it('浏览器 mock 形状 {agents:[...]} 也能添加智能体并落库', async () => {
    localStorage.setItem(enabledAgentsStorageKey('ws-1'), JSON.stringify([]))
    installNxcore({
      // 浏览器 mock 返回对象而不是数组，且字段只有 installed。
      discoverLocalAgents: async () => ({
        agents: [
          { id: 'claude-code', displayName: 'Claude Code', provider: 'claude', installed: true },
          { id: 'codex', displayName: 'Codex', provider: 'codex', installed: false },
        ],
      }),
    })
    const props = pageProps()
    render(<AgentsPage {...props} />)
    await flush()

    await click(buttonByText('添加智能体'))
    await flush()
    const checkbox = document.querySelector('[role="checkbox"][aria-label^="Claude Code"]')
    expect(checkbox).toBeTruthy()
    await click(checkbox)
    await click(buttonByText('添加 1 个'))
    await flush()

    expect(readEnabledAgents('ws-1').map((agent) => agent.id)).toEqual(['claude-code'])
    expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('已添加 1 个智能体'))
  })

  it('桥失败/空数组时不崩，并给出可读提示', async () => {
    installNxcore({
      getStatus: async () => { throw new Error('agent bridge down') },
      discoverLocalAgents: async () => [],
      listServers: async () => { throw new Error('mcp bridge down') },
    })
    render(<AgentsPage {...pageProps()} />)
    await flush()

    expect(bodyText()).toContain('智能体')
    expect(bodyText()).toContain('还没有启用任何智能体')
    expect(bodyText()).toContain('还没有配置 MCP 服务')
    expect(bodyText()).toContain('主 Agent 状态暂不可用')
  })

  it('经验便签按空间持久化：添加后写入，重新读取仍在', async () => {
    installNxcore()
    render(<AgentsPage {...pageProps()} />)
    await flush()

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="经验便签内容"]')
    if (!textarea) throw new Error('note textarea not found')
    await act(async () => {
      setInputValue(textarea, '文件名要带日期后缀')
    })
    await click(buttonByText('添加便签'))
    await flush()

    const raw = localStorage.getItem(agentNotesStorageKey('ws-1'))
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toMatchObject([{ text: '文件名要带日期后缀' }])
    expect(bodyText()).toContain('文件名要带日期后缀')
  })
})
