/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const homeGraphProps: Array<{ autoFitOnIdleMs?: number }> = []

vi.mock('../src/renderer/src/components/context-room/ported/components/RoomGraphCanvas', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    RoomGraphCanvas: forwardRef(function MockRoomGraphCanvas(
      props: { autoFitOnIdleMs?: number },
      _ref,
    ) {
      homeGraphProps.push(props)
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
    homeGraphProps.length = 0
    delete (window as unknown as { nxcore?: unknown }).nxcore
  })

  // 首页画布不再有「适应画布」浮层按钮：改成鼠标离开图谱满 5 秒自动缩放居中。
  it('drives the graph by idle auto-fit instead of a fit button', async () => {
    stubRoomGraph([])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderHome()
    })

    expect(homeGraphProps.at(-1)!.autoFitOnIdleMs).toBe(5000)
    expect(renderer!.root.findAllByProps({ className: 'context-room-graph-fit' })).toHaveLength(0)
    renderer!.unmount()
  })

  it('renders no graph (and no fit control) before the graph has loaded', async () => {
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
