import { describe, expect, it } from 'vitest'

import { stripAgentAnswerMarker } from '../src/renderer/src/components/agent/answerTiering'

describe('stripAgentAnswerMarker（展示侧 [[details]] 清洗）', () => {
  it('无标记原样返回（同一引用，零分配）', () => {
    const raw = '已生成《报告.docx》。\n\n结论一句话。'
    expect(stripAgentAnswerMarker(raw)).toBe(raw)
  })

  it('去掉第一个独立成行的标记行，前后接一个空行（与落库 content 同形）', () => {
    const raw = '结论：两家公司无关联。\n\n[[details]]\n报告分七章：\n1. 核心结论'
    expect(stripAgentAnswerMarker(raw)).toBe('结论：两家公司无关联。\n\n报告分七章：\n1. 核心结论')
  })

  it('容忍标记行前后空白与 CRLF', () => {
    const raw = '正文一句。\r\n  [[details]]  \r\n细节 A。'
    expect(stripAgentAnswerMarker(raw)).toBe('正文一句。\n\n细节 A。')
  })

  it('标记后为空：只留正文，不残留空段', () => {
    const raw = '只有正文。\n[[details]]\n'
    expect(stripAgentAnswerMarker(raw)).toBe('只有正文。')
  })

  it('只处理第一个标记：第二个标记行是详情正文，保留', () => {
    const raw = '正文。\n[[details]]\n详情一。\n[[details]]\n详情二。'
    expect(stripAgentAnswerMarker(raw)).toBe('正文。\n\n详情一。\n[[details]]\n详情二。')
  })

  it('行内出现的标记词（不独立成行）不动', () => {
    const raw = '参见 [[details]] 说明。'
    expect(stripAgentAnswerMarker(raw)).toBe(raw)
  })

  it('空串安全', () => {
    expect(stripAgentAnswerMarker('')).toBe('')
  })
})
