import { describe, expect, it } from 'vitest'

import { shrinkForPanels } from '../src/renderer/src/components/office-editor/officeViewport'

const host = { x: 220, y: 48, width: 1000, height: 800 }

describe('shrinkForPanels', () => {
  it('宽窗下侧栏占网格列、不在宿主范围内时原样返回', () => {
    const panel = { x: 1220, y: 48, width: 360, height: 800 }
    expect(shrinkForPanels(host, [panel])).toBe(host)
  })

  it('浮层面板压在宿主右侧时裁到面板左边界', () => {
    const panel = { x: 880, y: 48, width: 360, height: 800 }
    expect(shrinkForPanels(host, [panel])).toEqual({ x: 220, y: 48, width: 660, height: 800 })
  })

  it('取最靠左的面板边界（多个浮层叠加）', () => {
    const panels = [
      { x: 900, y: 48, width: 200, height: 800 },
      { x: 800, y: 48, width: 120, height: 800 },
    ]
    expect(shrinkForPanels(host, panels)).toEqual({ x: 220, y: 48, width: 580, height: 800 })
  })

  it('面板从宿主左边界起覆盖时退化为零尺寸隐藏', () => {
    const panel = { x: 220, y: 48, width: 900, height: 800 }
    expect(shrinkForPanels(host, [panel])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('垂直方向不相交、或面板在宿主左侧时不产生影响', () => {
    const above = { x: 880, y: 0, width: 360, height: 48 }
    const leftOfHost = { x: 0, y: 48, width: 220, height: 800 }
    expect(shrinkForPanels(host, [above])).toBe(host)
    expect(shrinkForPanels(host, [leftOfHost])).toBe(host)
  })

  it('零尺寸的面板（未挂载/已隐藏）被忽略', () => {
    expect(shrinkForPanels(host, [{ x: 880, y: 48, width: 0, height: 800 }])).toBe(host)
    expect(shrinkForPanels(host, [{ x: 880, y: 48, width: 360, height: 0 }])).toBe(host)
  })

  it('没有面板时返回同一对象（热路径上不做多余分配）', () => {
    expect(shrinkForPanels(host, [])).toBe(host)
  })
})