import TestRenderer from 'react-test-renderer'
import { describe, expect, it } from 'vitest'

import {
  readThesisCardView,
  ThesisFullPaper,
  ThesisMiniPaper,
} from '../src/renderer/src/components/context-room/ported/components/detail-panels/ThesisCardPreview'

describe('readThesisCardView', () => {
  it('falls back to Chinese thesis defaults for an empty card', () => {
    const view = readThesisCardView({})
    expect(view.widthMm).toBe(210)
    expect(view.heightMm).toBe(297)
    expect(view.eastAsia).toBe('宋体')
    expect(view.baseSizePt).toBe(12)
    expect(view.lineSpacingMultiple).toBe(1.25)
    expect(view.h1.sizePt).toBe(16)
    expect(view.h1.bold).toBe(true)
  })

  it('reads card facts and resolves Chinese size names', () => {
    const view = readThesisCardView({
      page: { widthMm: 185, heightMm: 260, marginLeftMm: 27.5 },
      base: { font: { eastAsia: '楷体', ascii: 'Times New Roman', size: '小四' } },
      headings: [{ level: 1, font: { eastAsia: '黑体', size: '小二', bold: true }, align: 'center' }],
      cover: { schoolName: '嘉应学院', degreeLine: '本科毕业论文（设计）', fields: [{ label: '题    目', key: 'title' }] },
      header: { enabled: true, template: '{title}', underline: true },
    })
    expect(view.widthMm).toBe(185)
    expect(view.marginLeftMm).toBe(27.5)
    expect(view.eastAsia).toBe('楷体')
    expect(view.baseSizePt).toBe(12)
    expect(view.h1.sizePt).toBe(18)
    expect(view.schoolName).toBe('嘉应学院')
    expect(view.coverFields).toEqual(['题    目'])
    expect(view.headerTemplate).toBe('{title}')
    expect(view.headerUnderline).toBe(true)
  })
})

describe('ThesisCardPreview rendering', () => {
  it('renders mini and full papers without crashing on defaults', () => {
    const view = readThesisCardView({})
    expect(() => TestRenderer.create(<ThesisMiniPaper card={view} />)).not.toThrow()
    expect(() => TestRenderer.create(<ThesisFullPaper card={view} />)).not.toThrow()
  })
})
