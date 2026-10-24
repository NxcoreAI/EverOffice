import { describe, expect, it } from 'vitest'

import { isEditableOfficeDocument } from '../src/renderer/src/lib/officeEditing'

describe('which Office files open editable', () => {
  it('opens OOXML documents editable', () => {
    for (const name of ['报告.docx', '预算.XLSX', '宏.xlsm', '汇报.pptx']) {
      expect(isEditableOfficeDocument(name)).toBe(true)
    }
  })

  it('keeps legacy formats read-only (they open a converted working copy)', () => {
    for (const name of ['旧.doc', '旧.xls', '旧.ppt', '扫描.pdf', 'notes.txt', 'no-extension']) {
      expect(isEditableOfficeDocument(name)).toBe(false)
    }
  })
})
