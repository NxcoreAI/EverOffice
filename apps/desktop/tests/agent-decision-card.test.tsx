// @vitest-environment happy-dom
/**
 * AgentDecisionCard 回归：演示文稿计划确认卡带计划云文档时的展示。
 *
 * 1) 有 document 时给「打开计划云文档」入口，点击派发 open-cloud-document；
 * 2) 卡片到达即自动打开一次计划文档（同一 approvalId 重挂载不重复打开）；
 * 3) 完整步骤折叠在 <details> 里，不再把十几步摊在卡片上；
 * 4) 没有 document 的普通计划卡保持原样（步骤平铺、无文档入口）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { AgentDecisionCard } from '../src/renderer/src/components/agent/AgentDecisionCard'
import type { PendingShellApproval } from '../src/renderer/src/components/agent/agentShellApprovals'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLAN_DOC = { id: 'doc-plan-1', title: '产品介绍演示文稿制作计划' }

const ISO = '2026-11-11T10:43:00.000Z'

let approvalSeq = 0

function approval(card: NonNullable<PendingShellApproval['card']>): PendingShellApproval {
  approvalSeq += 1
  return {
    approvalId: `approval-plan-${approvalSeq}`,
    runId: 'run-plan-1',
    toolName: 'agent_confirm',
    command: card.title,
    kind: 'card',
    requestedAt: ISO,
    card,
  }
}

let container: HTMLDivElement
let root: Root | null = null
const opened: Array<{ documentId: string; title: string }> = []

function listener(event: Event): void {
  opened.push((event as CustomEvent<{ documentId: string; title: string }>).detail)
}

function render(element: React.ReactElement): void {
  root = createRoot(container)
  act(() => {
    root?.render(<LocaleProvider>{element}</LocaleProvider>)
  })
}

function bodyText(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  opened.length = 0
  window.addEventListener('everroom:open-cloud-document', listener)
})

afterEach(async () => {
  window.removeEventListener('everroom:open-cloud-document', listener)
  if (root) {
    const mounted = root
    await act(async () => {
      mounted.unmount()
    })
    root = null
  }
  container.remove()
})

describe('AgentDecisionCard · 计划云文档', () => {
  it('给文档入口、自动打开一次，步骤折叠在 details 里', async () => {
    render(
      <AgentDecisionCard
        approval={approval({
          kind: 'confirm',
          title: '将生成 12 页《AI Native》演示文稿',
          plan: ['读取材料', '定页面结构', '写脚本', '生成 pptx'],
          palette: ['#0e1b2c', '#1f7a8c', '#f2a65a'],
          fonts: { heading: '黑体', body: '黑体' },
          document: PLAN_DOC,
        })}
        busy={false}
        onResolve={vi.fn()}
      />,
    )
    await act(async () => {})

    // 卡片到达即自动打开计划文档一次
    expect(opened).toEqual([{ documentId: PLAN_DOC.id, title: PLAN_DOC.title }])

    const button = container.querySelector('.agent-decision-card-document') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.textContent).toContain(PLAN_DOC.title)
    await act(async () => {
      button.click()
    })
    expect(opened).toHaveLength(2)
    expect(opened[1]).toEqual({ documentId: PLAN_DOC.id, title: PLAN_DOC.title })

    const details = container.querySelector('details.agent-decision-card-steps') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('4')
    expect(bodyText()).toContain('请确认计划')
  })

  it('同一 approvalId 重挂载不再自动打开（回放/重渲染不重复抢焦点）', async () => {
    const cardApproval = approval({
      kind: 'confirm',
      title: '将生成 4 页演示文稿',
      plan: ['读取材料'],
      document: PLAN_DOC,
    })
    render(<AgentDecisionCard approval={cardApproval} busy={false} onResolve={vi.fn()} />)
    await act(async () => {})
    expect(opened).toHaveLength(1)

    await act(async () => {
      root?.unmount()
    })
    root = createRoot(container)
    act(() => {
      root?.render(
        <LocaleProvider>
          <AgentDecisionCard approval={cardApproval} busy={false} onResolve={vi.fn()} />
        </LocaleProvider>,
      )
    })
    await act(async () => {})
    expect(opened).toHaveLength(1)
  })

  it('普通计划卡（无 document）不出现文档入口，步骤平铺', () => {
    render(
      <AgentDecisionCard
        approval={approval({
          kind: 'confirm',
          title: '批量改写 10 篇文档',
          plan: ['逐篇改写', '核对引用'],
        })}
        busy={false}
        onResolve={vi.fn()}
      />,
    )
    expect(container.querySelector('.agent-decision-card-document')).toBeNull()
    expect(container.querySelector('details.agent-decision-card-steps')).toBeNull()
    expect(container.querySelector('ol.agent-decision-card-plan')).not.toBeNull()
    expect(opened).toHaveLength(0)
  })
})
