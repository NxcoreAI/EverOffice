import { describe, expect, it } from 'vitest'

import {
  BUBBLE_DEFAULT_WIDTH,
  BUBBLE_MIN_WIDTH,
  CHAT_MIN_WIDTH,
  resolveBubbleDrag,
  resolveBubbleGeometry,
} from '../src/renderer/src/workbench/workspace/bubbleGeometry'

/** 与 bubble.css 的 .wb-bubble margin-right 同步。 */
const DOCK_GAP = 8

describe('resolveBubbleGeometry', () => {
  it('常规停靠态按记忆宽度渲染，不动对话区', () => {
    const geometry = resolveBubbleGeometry({ width: 480, containerWidth: 1190, cover: false })
    expect(geometry.width).toBe(480)
    expect(geometry.covering).toBe(false)
    expect(geometry.full).toBe(false)
  })

  it('未进入 cover 档时收敛在「对话区保底宽度」这条线，而不是旧的 720 硬上限', () => {
    const geometry = resolveBubbleGeometry({ width: 1100, containerWidth: 1190, cover: false })
    expect(geometry.width).toBe(1190 - CHAT_MIN_WIDTH - DOCK_GAP)
    // 旧实现在这里会被 BUBBLE_MAX_WIDTH=720 截断，用户拖不到整页宽度。
    expect(geometry.width).toBeGreaterThan(720)
    expect(geometry.covering).toBe(false)
  })

  it('cover 档可以把面板铺满整个工作区（对话区让位到 0）', () => {
    const geometry = resolveBubbleGeometry({ width: 1190, containerWidth: 1190, cover: true })
    expect(geometry.width).toBe(1190)
    expect(geometry.covering).toBe(true)
    expect(geometry.full).toBe(true)
  })

  it('窗口收窄后 cover 档仍优先铺满，记忆宽度不溢出容器', () => {
    const geometry = resolveBubbleGeometry({ width: 1600, containerWidth: 800, cover: true })
    expect(geometry.width).toBe(800)
    expect(geometry.full).toBe(true)
  })

  it('窗口收窄但未进入 cover 档时保住对话区保底宽度（不 flex 溢出）', () => {
    const geometry = resolveBubbleGeometry({ width: 900, containerWidth: 800, cover: false })
    expect(geometry.width).toBe(800 - CHAT_MIN_WIDTH - DOCK_GAP)
    expect(geometry.covering).toBe(false)
  })

  it('容器窄到放不下「面板最小宽度 + 对话区保底」时优先保住面板最小宽度', () => {
    const geometry = resolveBubbleGeometry({ width: 480, containerWidth: 500, cover: false })
    expect(geometry.width).toBe(BUBBLE_MIN_WIDTH)
  })

  it('容器量不到（0）时保持记忆宽度，交给上层兜底', () => {
    const geometry = resolveBubbleGeometry({ width: 0, containerWidth: 0, cover: false })
    expect(geometry.width).toBe(BUBBLE_DEFAULT_WIDTH)
    expect(geometry.full).toBe(false)
  })

  it('记忆宽度低于下限时抬到最小宽度', () => {
    const geometry = resolveBubbleGeometry({ width: 120, containerWidth: 1190, cover: false })
    expect(geometry.width).toBe(BUBBLE_MIN_WIDTH)
  })
})

describe('resolveBubbleDrag', () => {
  it('向左拖越过对话区保底线时立即进入 cover 档，宽度连续无跳变', () => {
    const drag = resolveBubbleDrag({ startWidth: 480, deltaX: -500, softMax: 942, coverWidth: 1190 })
    expect(drag.width).toBe(980)
    expect(drag.cover).toBe(true)
  })

  it('拖过容器宽度时收敛到铺满宽度', () => {
    const drag = resolveBubbleDrag({ startWidth: 480, deltaX: -5000, softMax: 942, coverWidth: 1190 })
    expect(drag.width).toBe(1190)
    expect(drag.cover).toBe(true)
  })

  it('从铺满态向右拖回线内自动退出 cover 档', () => {
    const drag = resolveBubbleDrag({ startWidth: 1190, deltaX: 400, softMax: 942, coverWidth: 1190 })
    expect(drag.width).toBe(790)
    expect(drag.cover).toBe(false)
  })

  it('拖拽起点用实测宽度：窗口收窄后的第一次拖动不跳', () => {
    // 记忆宽度 1182，但窗口收窄后实际渲染只有 800：从 800 起拖 100px 应是 700，而不是 1082。
    const drag = resolveBubbleDrag({ startWidth: 800, deltaX: 100, softMax: 552, coverWidth: 800 })
    expect(drag.width).toBe(700)
    expect(drag.cover).toBe(true)
  })

  it('宽度不低于最小宽度', () => {
    const drag = resolveBubbleDrag({ startWidth: 400, deltaX: 200, softMax: 942, coverWidth: 1190 })
    expect(drag.width).toBe(BUBBLE_MIN_WIDTH)
    expect(drag.cover).toBe(false)
  })
})
