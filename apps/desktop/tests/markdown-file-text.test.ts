/**
 * 侧栏 Markdown 文件的纯逻辑回归：
 * 1) `.md` / `.markdown` 文件名判定（大小写、路径、query 容错）；
 * 2) YAML frontmatter 拆分/拼接（有/无 frontmatter、CRLF、行尾无换行）。
 */
import { describe, expect, it } from 'vitest'

import {
  isMarkdownFileName,
  joinMarkdownDocument,
  splitMarkdownDocument,
} from '../src/renderer/src/office-proto/markdownFileText'

describe('isMarkdownFileName', () => {
  it('识别 .md / .markdown（大小写不敏感）', () => {
    expect(isMarkdownFileName('产品调研笔记.md')).toBe(true)
    expect(isMarkdownFileName('README.MD')).toBe(true)
    expect(isMarkdownFileName('notes.markdown')).toBe(true)
    expect(isMarkdownFileName('Notes.MarkDown')).toBe(true)
  })

  it('剥离路径与 query/hash 后再判定', () => {
    expect(isMarkdownFileName('/Users/me/Documents/笔记.md')).toBe(true)
    expect(isMarkdownFileName('wiki/2026/weekly.md?raw=1')).toBe(true)
    expect(isMarkdownFileName('notes.md#待办')).toBe(true)
    expect(isMarkdownFileName('docs\\md\\spec.markdown')).toBe(true)
  })

  it('非 Markdown 文件名不误判', () => {
    expect(isMarkdownFileName('会议纪要.docx')).toBe(false)
    expect(isMarkdownFileName('note.md.bak')).toBe(false)
    expect(isMarkdownFileName('markdown')).toBe(false)
    expect(isMarkdownFileName('notes.txt')).toBe(false)
    expect(isMarkdownFileName('')).toBe(false)
    expect(isMarkdownFileName('   ')).toBe(false)
  })
})

describe('splitMarkdownDocument / joinMarkdownDocument', () => {
  it('没有 frontmatter 时整段都是正文', () => {
    const text = '# 标题\n\n普通正文，含分隔线：\n\n---\n\n继续。'
    expect(splitMarkdownDocument(text)).toEqual({ frontmatter: '', body: text })
    expect(joinMarkdownDocument('', text)).toBe(text)
  })

  it('拆分 YAML frontmatter 并逐字节保留（LF）', () => {
    const text = '---\ntitle: 周报\ntags: [a, b]\n---\n# 标题\n\n正文。'
    const parts = splitMarkdownDocument(text)
    expect(parts.frontmatter).toBe('---\ntitle: 周报\ntags: [a, b]\n---\n')
    expect(parts.body).toBe('# 标题\n\n正文。')
    expect(joinMarkdownDocument(parts.frontmatter, parts.body)).toBe(text)
  })

  it('CRLF 文档同样拆分且 round-trip 不变', () => {
    const text = '---\r\ntitle: x\r\n---\r\n# 标题\r\n\r\n正文。'
    const parts = splitMarkdownDocument(text)
    expect(parts.frontmatter).toBe('---\r\ntitle: x\r\n---\r\n')
    expect(parts.body).toBe('# 标题\r\n\r\n正文。')
    expect(joinMarkdownDocument(parts.frontmatter, parts.body)).toBe(text)
  })

  it('闭合分隔行在文件末尾（无尾随换行）也算 frontmatter', () => {
    const parts = splitMarkdownDocument('---\ntitle: x\n---')
    expect(parts.frontmatter).toBe('---\ntitle: x\n---')
    expect(parts.body).toBe('')
  })

  it('没有闭合分隔行的 --- 不当成 frontmatter', () => {
    const text = '---\n不是 YAML frontmatter'
    expect(splitMarkdownDocument(text)).toEqual({ frontmatter: '', body: text })
  })

  it('空字符串安全', () => {
    expect(splitMarkdownDocument('')).toEqual({ frontmatter: '', body: '' })
    expect(joinMarkdownDocument('', '')).toBe('')
  })
})
