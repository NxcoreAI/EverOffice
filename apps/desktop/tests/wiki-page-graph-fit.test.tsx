/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fitViewCalls = { count: 0 }

// node 环境没有 window/canvas/Worker：画布与力导向布局换成轻量替身，
// 只验证「Wiki 页图谱工具条里的自适应按钮 → 画布 fitView」这条接线。
vi.mock('../src/renderer/src/components/graph/PixiForceGraphCanvas', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    PixiForceGraphCanvas: forwardRef(function MockPixiForceGraphCanvas(
      _props: Record<string, unknown>,
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        fitView: () => {
          fitViewCalls.count += 1
        },
      }), [])
      return null
    }),
  }
})

vi.mock('../src/renderer/src/components/graph/useForceGraphLayout', () => ({
  useForceGraphLayout: () => ({
    controller: null,
    positions: null,
    revision: 0,
    resize: vi.fn(),
    cancelAutoFit: vi.fn(),
    drag: vi.fn(),
    release: vi.fn(),
  }),
}))

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))

import { WikiPage } from '../src/renderer/src/components/pages/WikiPage'

function stubKnowledge() {
  const knowledge = {
    listWikis: vi.fn().mockResolvedValue({ items: [{ roomId: 'room-a', status: 'ready', pageCount: 1 }] }),
    listRooms: vi.fn().mockResolvedValue({ items: [{ id: 'room-a', title: 'Room A', kind: '项目' }] }),
    listWikiPages: vi.fn().mockResolvedValue({
      status: 'ready',
      items: [{ path: 'overview.md', title: '概览', description: '', updatedAt: '2026-08-25T00:00:00.000Z' }],
    }),
    readWikiPage: vi.fn().mockResolvedValue({ markdown: '# 概览' }),
    getWikiGraph: vi.fn().mockResolvedValue({
      nodes: [{ id: 'page-a', title: '页 A', path: 'a.md', inLinks: 0 }],
      edges: [],
    }),
  }
  ;(window as unknown as { nxcore?: unknown }).nxcore = { knowledge }
  return knowledge
}

describe('Wiki 页图谱的「适应画布」按钮', () => {
  afterEach(() => {
    fitViewCalls.count = 0
    delete (window as unknown as { nxcore?: unknown }).nxcore
  })

  // 曾经挂在画布右上角的自适应浮层会压住工具条上的「显示全部」；
  // 现在统一收进工具条，一处一颗、互不重叠。
  it('sits in the graph toolbar instead of floating over the canvas', async () => {
    const knowledge = stubKnowledge()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<WikiPage />)
    })

    const graphTab = renderer!.root.findAllByType('button')
      .find((button) => button.props.role === 'tab' && button.children.includes('图谱'))!
    await act(async () => {
      graphTab.props.onClick()
    })

    expect(knowledge.getWikiGraph).toHaveBeenCalledWith('room-a')
    // 浮层版不再出现（此前与「显示全部」重叠的就是它）。
    expect(renderer!.root.findAllByProps({ className: 'context-room-graph-fit' })).toHaveLength(0)

    const modeButton = renderer!.root.findAllByType('button')
      .find((button) => button.props.className === 'wiki-graph-mode')!
    expect(modeButton.children).toEqual(['显示全部'])

    const fitButton = renderer!.root.findByProps({ className: 'wiki-graph-mode wiki-graph-fit' })
    expect(fitButton.props['aria-label']).toBe('自适应图谱：缩放并居中')

    await act(async () => {
      fitButton.props.onClick()
    })
    expect(fitViewCalls.count).toBe(1)

    renderer!.unmount()
  })
})