/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatusSnapshot } from '@nxcore/agent-contract'

import { AgentStatusPage } from '../src/renderer/src/components/pages/AgentStatusPage'

function snapshotWith(state: 'idle' | 'running' | 'error'): AgentStatusSnapshot {
  return {
    generatedAt: '2026-08-25T01:03:00.000Z',
    summary: {
      total: 1,
      running: state === 'running' ? 1 : 0,
      idle: state === 'idle' ? 1 : 0,
      error: state === 'error' ? 1 : 0,
    },
    agents: [{
      agentId: 'main',
      name: '主 Agent',
      description: '整理资料',
      kind: 'builtin',
      // 失败之后再拿到的快照：状态已经回海（idle），失败只留在 lastRun。
      state,
      activeRunCount: state === 'running' ? 1 : 0,
      workspace: { id: 'agent://main', isolation: 'dedicated', revisionId: null },
      currentRun: state === 'running'
        ? { id: 'run-2', task: '整理今天的会议记录', pageLabel: '办公室', status: 'running', startedAt: '2026-08-25T01:04:00.000Z', completedAt: null }
        : null,
      lastRun: {
        id: 'run-1',
        task: '整理今天的会议记录',
        pageLabel: '办公室',
        status: state === 'running' ? 'running' : 'failed',
        startedAt: '2026-08-25T01:00:00.000Z',
        completedAt: state === 'running' ? null : '2026-08-25T01:02:00.000Z',
      },
      updatedAt: '2026-08-25T01:02:00.000Z',
    }],
  }
}

function stubAgentStatus(snapshot: AgentStatusSnapshot) {
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    agent: { getStatus: vi.fn().mockResolvedValue(snapshot) },
  }
}

async function renderPage() {
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<AgentStatusPage />)
  })
  return renderer!
}

describe('办公室：运行失败后鹈鹕回海', () => {
  afterEach(() => {
    delete (window as unknown as { nxcore?: unknown }).nxcore
    vi.unstubAllGlobals()
  })

  it('失败的 agent 待在海里游泳，不再停在路肩', async () => {
    stubAgentStatus(snapshotWith('idle'))
    const renderer = await renderPage()

    const [rider] = renderer.root.findAllByProps({ className: 'coast-rider' })
    expect(rider!.props['data-state']).toBe('idle')
    expect(rider!.props['data-mode']).toBe('swimming')
    expect(String(rider!.props['data-lane'])).toMatch(/^sea-/)
    // 初始状态：海面两排深度之一。
    expect(['sea-front', 'sea-back']).toContain(rider!.props['data-lane'])
    renderer.unmount()
  })

  it('最近活动那条记录仍然显示失败', async () => {
    stubAgentStatus(snapshotWith('idle'))
    const renderer = await renderPage()

    const activity = renderer.root.findByProps({ className: 'agent-recent-activity' })
    const [mark] = activity.findAllByType('i')
    expect(mark!.props['data-state']).toBe('error')
    expect(activity.findAllByType('em').map((node) => node.children)).toEqual([['失败']])
    renderer.unmount()
  })

  it('运行中照旧骑在公路上', async () => {
    stubAgentStatus(snapshotWith('running'))
    const renderer = await renderPage()

    const [rider] = renderer.root.findAllByProps({ className: 'coast-rider' })
    expect(rider!.props['data-state']).toBe('running')
    expect(rider!.props['data-mode']).toBe('riding')
    renderer.unmount()
  })
})
