/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fitViewCalls = { count: 0 }

vi.mock('../src/renderer/src/components/context-room/ported/components/RoomGraphCanvas', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    RoomGraphCanvas: forwardRef(function MockRoomGraphCanvas(
      _props: Record<string, unknown>,
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        fitView: async () => {
          fitViewCalls.count += 1
        },
      }), [])
      return null
    }),
  }
})

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  // 面板只消费 refreshFromBackend（创建后重拉推荐池）；测试无需真实 Provider。
  useContextRoomState: () => ({
    state: null,
    setState: () => {},
    backendReady: true,
    refreshFromBackend: async () => null,
  }),
}))

import { createContextRoomFixture } from './context-room-fixture'
import { HomeView } from '../src/renderer/src/components/context-room/ported/components/HomeView'

const handlers = {
  onRenameRoom: vi.fn(),
  onDeleteRoom: vi.fn(),
  onRestoreRoom: vi.fn(),
  onOpenDetail: vi.fn(),
  onShowAll: vi.fn(),
  onFocusAgent: vi.fn(),
  onRefreshRooms: vi.fn().mockResolvedValue(undefined),
}

type KnowledgeStub = { getRoomGraph: ReturnType<typeof vi.fn>; getRoomRelations: ReturnType<typeof vi.fn> }

/** 只挂 nxcore.knowledge：happy-dom 的其余 window 能力（定时器/事件）要保留。 */
function stubKnowledge(knowledge: KnowledgeStub) {
  ;(window as unknown as { nxcore?: unknown }).nxcore = { knowledge }
}

function stubRoomGraph(edges: unknown[]) {
  stubKnowledge({
    getRoomRelations: vi.fn(),
    getRoomGraph: vi.fn().mockResolvedValue({
      revision: 1,
      generatedAt: '2026-08-25T00:00:00.000Z',
      indexing: { status: 'ready', pendingSources: 0 },
      nodes: [
        { id: 'room-a', title: 'Room A', kind: '项目', origin: 'user', updatedAt: '2026-08-25T00:00:00.000Z' },
        { id: 'room-b', title: 'Room B', kind: '主题', origin: 'user', updatedAt: '2026-08-25T00:00:00.000Z' },
      ],
      edges,
    }),
  })
}

function renderHome() {
  return TestRenderer.create(
    <HomeView
      rooms={[createContextRoomFixture('room-a', 'Room A'), createContextRoomFixture('room-b', 'Room B')]}
      deletedRooms={[]}
      {...handlers}
    />,
  )
}

describe('首页 Room 关系图谱的自适应按钮', () => {
  afterEach(() => {
    fitViewCalls.count = 0
    delete (window as unknown as { nxcore?: unknown }).nxcore
  })

  // 首页画布可自由缩放平移：缩到最小或拖走后全图看不见，浮层按钮必须常驻并可点。
  it('keeps an always-visible fit control that re-fits the whole graph', async () => {
    stubRoomGraph([])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderHome()
    })

    const fitButton = renderer!.root.findByProps({ className: 'context-room-graph-fit' })
    expect(fitButton.props['aria-label']).toBe('自适应图谱：缩放并居中')

    await act(async () => {
      fitButton.props.onClick()
    })

    expect(fitViewCalls.count).toBe(1)
    renderer!.unmount()
  })

  it('does not offer the fit control before the graph has loaded', async () => {
    stubKnowledge({
      getRoomRelations: vi.fn(),
      // 永不 resolve：停在加载态，画布还没渲染。
      getRoomGraph: vi.fn(() => new Promise(() => {})),
    })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderHome()
    })

    expect(renderer!.root.findAllByProps({ className: 'context-room-graph-fit' })).toHaveLength(0)
    renderer!.unmount()
  })
})
