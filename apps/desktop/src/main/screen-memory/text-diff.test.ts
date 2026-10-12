import { describe, expect, it } from 'vitest'

import { diffKeyframeText, isVolatileLine, lineSimilarity } from './text-diff'

describe('isVolatileLine', () => {
  it('识别时钟与日期样式行', () => {
    expect(isVolatileLine('14:23')).toBe(true)
    expect(isVolatileLine('14:23:45')).toBe(true)
    expect(isVolatileLine('2026-10-12')).toBe(true)
    expect(isVolatileLine('2026-10-12 14:30')).toBe(true)
    expect(isVolatileLine('2026.10.12')).toBe(true)
    expect(isVolatileLine('下午 3:05')).toBe(true)
    expect(isVolatileLine('9:41 AM')).toBe(true)
    expect(isVolatileLine('')).toBe(true)
    expect(isVolatileLine('本地屏幕记忆方案评审')).toBe(false)
  })
})

describe('lineSimilarity', () => {
  it('归一化空白与大小写后相同视为一致', () => {
    expect(lineSimilarity('Hello World', 'hello  world')).toBe(1)
  })

  it('单字符差异接近 1，完全不同接近 0', () => {
    expect(lineSimilarity('订单号 SO-20260001', '订单号 SO-20260002')).toBeGreaterThan(0.9)
    expect(lineSimilarity(' completely different content ', '毫不相关的另一行文字')).toBeLessThan(0.2)
  })
})

describe('diffKeyframeText', () => {
  it('仅时钟跳字不构成变化', () => {
    const previous = ['会议纪要', '14:23']
    const next = ['会议纪要', '14:24']
    const decision = diffKeyframeText(previous, next)
    expect(decision.changed).toBe(false)
    expect(decision.newLines).toEqual([])
  })

  it('新增稳定行构成变化并返回该行', () => {
    const decision = diffKeyframeText(['第一行'], ['第一行', '第二行新增内容'])
    expect(decision.changed).toBe(true)
    expect(decision.newLines).toEqual(['第二行新增内容'])
  })

  it('微小文字变化（单字更新）构成变化', () => {
    const previous = ['金额 ¥1,250']
    const next = ['金额 ¥1,850']
    const decision = diffKeyframeText(previous, next)
    expect(decision.changed).toBe(true)
  })

  it('与旧行高相似的行被吸收，不算新增', () => {
    const decision = diffKeyframeText(['网关侧新增并发上限配置（owner: lzp）'], ['网关侧新增并发上限配置（owner: Izp）'])
    expect(decision.changed).toBe(false)
  })
})
