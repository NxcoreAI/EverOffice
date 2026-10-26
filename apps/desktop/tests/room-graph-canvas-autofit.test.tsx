/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createContextRoomFixture } from './context-room-fixture'

const fitViewCalls: number[] = []
const animateFitCalls: number[] = []
let cancelCalls = 0
const canvasProps: Array<Record<string, (value?: unknown) => void>> = []
/** true = 模拟老画布（没有 animateFitView），验证退回瞬时对准。 */
let canvasWithoutAnimate = false

// node 环境没有 canvas/Worker：画布与力导向布局都换成探针，只验证「无操作自动复位」接线。
vi.mock('@/components/graph', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    PixiForceGraphCanvas: forwardRef(function MockPixiForceGraphCanvas(
      props: Record<string, (value?: unknown) => void>,
      ref,
    ) {
      canvasProps.push(props)
      useImperativeHandle(ref, () => ({
        fitView: () => {
          fitViewCalls.push(Date.now())
        },
        ...(canvasWithoutAnimate
          ? {}
          : {
              animateFitView: (options?: { durationMs?: number }) => { animateFitCalls.push(options?.durationMs ?? 0) },
              cancelFitAnimation: () => { cancelCalls += 1 },
            }),
      }), [])
      return null
    }),
    PixiForceGraphCanvasNode: undefined,
    PixiForceGraphEdge: undefined,
    useForceGraphLayout: () => ({
      controller: null,
      positions: null,
      revision: 0,
      resize: vi.fn(),
      cancelAutoFit: vi.fn(),
      drag: vi.fn(),
      release: vi.fn(),
    }),
  }
})

import { RoomGraphCanvas } from '../src/renderer/src/components/context-room/ported/components/RoomGraphCanvas'

const ROOMS = [
  createContextRoomFixture('room-a', 'Room A'),
  createContextRoomFixture('room-b', 'Room B'),
]

function renderCanvas(autoFitOnIdleMs?: number) {
  return TestRenderer.create(
    <RoomGraphCanvas
      compact
      rooms={ROOMS}
      relations={[]}
      selectedId={null}
      autoFitOnIdleMs={autoFitOnIdleMs}
      onOpenRoom={vi.fn()}
      onSelectRoom={vi.fn()}
    />,
  )
}

function shell(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ className: 'context-room-graph-shell nx-graph-shell' })
}

/** 组件只读 clientX/clientY，这里造一个最小指针事件。 */
function pointer(x: number, y: number) {
  return { clientX: x, clientY: y } as unknown as React.PointerEvent<HTMLDivElement>
}

/** 进入画布 → 按住拖 40px（= 改动视口）→ 松手。 */
async function pan(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => { shell(renderer).props.onPointerEnter() })
  await act(async () => { shell(renderer).props.onPointerDown(pointer(100, 100)) })
  await act(async () => { shell(renderer).props.onPointerMove(pointer(140, 130)) })
  await act(async () => { shell(renderer).props.onPointerUp(pointer(140, 130)) })
}

describe('RoomGraphCanvas 离开画布自动复位', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fitViewCalls.length = 0
    animateFitCalls.length = 0
    canvasProps.length = 0
    canvasWithoutAnimate = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllTimers()
  })

  it('未武装（没改过视口）时，离开画布也不复位', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    // 只是悬停+轻微移动（3px 死区内），没改视口
    await act(async () => { shell(renderer).props.onPointerEnter() })
    await act(async () => { shell(renderer).props.onPointerDown(pointer(100, 100)) })
    await act(async () => { shell(renderer).props.onPointerMove(pointer(101, 100)) })
    await act(async () => { shell(renderer).props.onPointerUp(pointer(101, 100)) })
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(animateFitCalls).toHaveLength(0)
    expect(fitViewCalls).toHaveLength(0)
  })

  it('鼠标在画布内：改过视口也不动，图谱保持静止', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await pan(renderer)  // 拖拽 40px = 改过视口（已武装）
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(animateFitCalls).toHaveLength(0)
    expect(fitViewCalls).toHaveLength(0)
  })

  it('离开画布满 5s 才弹回（1s 补间）', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await pan(renderer)
    await act(async () => { shell(renderer).props.onPointerLeave() })

    await act(async () => { vi.advanceTimersByTime(4_999) })
    expect(animateFitCalls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(animateFitCalls).toEqual([1000])
  })

  it('离开后 5s 内回到画布：取消待触发的复位', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await pan(renderer)
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(2_000) })
    await act(async () => { shell(renderer).props.onPointerEnter() })
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(animateFitCalls).toHaveLength(0)
    expect(fitViewCalls).toHaveLength(0)
  })

  it('复位后再次改视口：再次离开才会再复位（一次性武装）', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await pan(renderer)
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(5_000) })
    expect(animateFitCalls).toEqual([1000])

    // 复位后没再改视口 → 再离开也不复位
    await act(async () => { shell(renderer).props.onPointerEnter() })
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(animateFitCalls).toEqual([1000])

    // 再拖一次 → 再离开 → 再复位
    await act(async () => { shell(renderer).props.onPointerEnter() })
    await pan(renderer)
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(5_000) })
    expect(animateFitCalls).toEqual([1000, 1000])
  })

  it('滚轮缩放也武装；autoFitOnIdleMs=0 时功能关闭', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await act(async () => { shell(renderer).props.onWheel() })
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(5_000) })
    expect(animateFitCalls).toEqual([1000])

    // 关闭：不传 autoFitOnIdleMs
    animateFitCalls.length = 0
    let off!: TestRenderer.ReactTestRenderer
    await act(async () => { off = renderCanvas(undefined) })
    await act(async () => { shell(off).props.onWheel() })
    await act(async () => { shell(off).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(animateFitCalls).toHaveLength(0)
    expect(fitViewCalls).toHaveLength(0)
  })

  it('老画布没有 animateFitView：退回瞬时对准，别静默不动作。', async () => {
    canvasWithoutAnimate = true
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderCanvas(5000) })
    await pan(renderer)
    await act(async () => { shell(renderer).props.onPointerLeave() })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(animateFitCalls).toHaveLength(0)
    expect(fitViewCalls).toHaveLength(1)
  })

  it('用户手势立刻取消正在播放的复位补间', async () => {
    const renderer = renderCanvas(5_000)
    animateFitCalls.length = 0
    cancelCalls = 0
    const canvas = canvasProps[canvasProps.length - 1] as unknown as {
      animateFitView?: (options?: { durationMs?: number }) => void
    }

    // 模拟补间在播（画布句柄被上层调用过），此时用户按下鼠标
    await act(async () => { canvas.animateFitView?.({ durationMs: 1000 }) })
    expect(cancelCalls).toBe(0)

    await act(async () => { shell(renderer).props.onPointerDown(pointer(100, 100)) })
    expect(cancelCalls).toBe(1)

    // 滚轮同样取消
    await act(async () => { canvas.animateFitView?.({ durationMs: 1000 }) })
    cancelCalls = 0
    await act(async () => { shell(renderer).props.onWheel() })
    expect(cancelCalls).toBe(1)
  })
})
