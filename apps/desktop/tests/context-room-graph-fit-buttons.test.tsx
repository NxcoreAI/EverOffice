/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fitViewCalls = { count: 0 }

// node 环境没有 window/canvas/Worker：pixi 画布与力导向布局都换成轻量替身，
// 只验证「自适应按钮 → 画布 fitView」这条接线。
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

import { EntityFactGraphCanvas } from '../src/renderer/src/components/context-room/ported/components/EntityFactGraphCanvas'
import { LinkGraphCanvas } from '../src/renderer/src/components/context-room/ported/components/LinkGraphCanvas'
import { WikiGraphCanvas } from '../src/renderer/src/components/context-room/ported/components/WikiGraphCanvas'

/** 关系板块下的三张力导向图谱都应带一颗常驻的自适应按钮。 */
describe('关系板块各图谱的自适应按钮', () => {
  afterEach(() => {
    fitViewCalls.count = 0
  })

  async function renderAndFit(element: React.ReactElement) {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(element)
    })
    const fitButton = renderer!.root.findByProps({ className: 'context-room-graph-fit' })
    expect(fitButton.props['aria-label']).toBe('自适应图谱：缩放并居中')
    await act(async () => {
      fitButton.props.onClick()
    })
    expect(fitViewCalls.count).toBe(1)
    renderer!.unmount()
  }

  it('实体与事实图谱可自适应缩放居中', async () => {
    await renderAndFit(
      <EntityFactGraphCanvas
        data={{
          rootId: 'root',
          nodes: [
            { id: 'root', kind: 'entity', label: 'Room 本身', description: '', entityType: '主题' },
            { id: 'fact-1', kind: 'fact', label: '一条事实', description: '' },
          ],
          edges: [{ id: 'edge-1', relation: 'about', source: 'fact-1', target: 'root' }],
        }}
        selectedId="root"
        onSelect={vi.fn()}
      />,
    )
  })

  it('内容建联图谱可自适应缩放居中', async () => {
    await renderAndFit(
      <LinkGraphCanvas
        data={{
          rootId: 'root',
          nodes: [
            { id: 'root', kind: 'root', documentId: null, memoryId: null, parentDocumentId: null, blockId: null, label: '本 Room', description: '', stale: false },
          ],
          edges: [],
          totals: { documents: 0, memories: 0, links: 0, dangling: 0 },
        }}
        selectedId="root"
        onSelect={vi.fn()}
      />,
    )
  })

  it('Wiki 图谱可自适应缩放居中', async () => {
    await renderAndFit(
      <WikiGraphCanvas
        graph={{
          nodes: [{ id: 'page-a', title: '页 A', path: 'a.md', inLinks: 0 }],
          edges: [],
        }}
        selectedPath={null}
        onSelectPage={vi.fn()}
      />,
    )
  })
})