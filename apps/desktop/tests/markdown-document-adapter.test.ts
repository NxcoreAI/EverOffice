// @vitest-environment happy-dom
/**
 * Markdown ⇄ 旧文稿编辑器 JSON 适配层（`office-proto/markdownDocumentAdapter.ts`）回归。
 *
 * 锁住三件事：
 * 1) 解析保真：标题/段落/链接/表格/图片/任务列表都要进文稿 JSON——扩展没注册时
 *    `@tiptap/markdown` 会把整段丢掉，用户改一个字再保存就把原文件改坏；
 * 2) 序列化保真：上面这些节点再写回 Markdown 时不丢（表格、图片、任务勾选态）；
 * 3) frontmatter 逐字节保留：Tiptap 只解析正文，拆/拼由 `markdownFileText` 负责。
 */
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import {
  createMarkdownDocumentExtensions,
  documentJsonToMarkdown,
  markdownToDocumentJson,
} from '../src/renderer/src/office-proto/markdownDocumentAdapter'
import {
  joinMarkdownDocument,
  splitMarkdownDocument,
} from '../src/renderer/src/office-proto/markdownFileText'

const SAMPLE_MARKDOWN = [
  '# 产品调研笔记',
  '',
  '三条链路并存的现状已经确认，目标是**统一执行面**。',
  '',
  '参考 [连接器架构评审](https://example.com/review)。',
  '',
  '| 链路 | 状态 |',
  '| --- | --- |',
  '| Gmail | 双链路 |',
  '',
  '![架构图](https://example.com/arch.png)',
  '',
  '- [ ] 映射表三处同值收口',
  '- [x] 双链路现状盘点',
  '',
].join('\n')

function walk(node: TiptapJsonContent | undefined, visit: (node: TiptapJsonContent) => void): void {
  if (!node) return
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

function collect(json: TiptapJsonContent): TiptapJsonContent[] {
  const nodes: TiptapJsonContent[] = []
  walk(json, (node) => nodes.push(node))
  return nodes
}

function nodesOfType(json: TiptapJsonContent, type: string): TiptapJsonContent[] {
  return collect(json).filter((node) => node.type === type)
}

describe('markdownToDocumentJson', () => {
  it('解析出 doc 根节点', () => {
    const json = markdownToDocumentJson('正文')
    expect(json.type).toBe('doc')
    expect(Array.isArray(json.content)).toBe(true)
  })

  it('标题、段落、链接、表格、图片、任务列表全部进文稿 JSON', () => {
    const json = markdownToDocumentJson(SAMPLE_MARKDOWN)

    expect(nodesOfType(json, 'heading')[0]?.attrs?.level).toBe(1)
    expect(nodesOfType(json, 'paragraph').length).toBeGreaterThan(0)

    // 链接是 mark：内联文本上挂 link 标记，href 必须保留。
    const links = collect(json)
      .flatMap((node) => node.marks ?? [])
      .filter((mark) => mark.type === 'link')
    expect(links[0]?.attrs?.href).toBe('https://example.com/review')

    // 表格：table / tableRow / tableCell 一个都不能少。
    expect(nodesOfType(json, 'table')).toHaveLength(1)
    expect(nodesOfType(json, 'tableRow').length).toBeGreaterThanOrEqual(2)
    expect(nodesOfType(json, 'tableCell').length).toBeGreaterThanOrEqual(2)

    // 图片：src 原样保留。
    expect(nodesOfType(json, 'image')[0]?.attrs?.src).toBe('https://example.com/arch.png')

    // 任务列表：勾选态落在 attrs.checked。
    const items = nodesOfType(json, 'taskItem')
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.attrs?.checked)).toEqual([false, true])
  })

  it('保留内嵌 data URI 图片（本地 Markdown 笔记常见写法）', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const json = markdownToDocumentJson(`![内嵌图](${dataUri})`)
    expect(nodesOfType(json, 'image')[0]?.attrs?.src).toBe(dataUri)
  })

  it('空正文得到空 doc', () => {
    expect(markdownToDocumentJson('')).toEqual({ type: 'doc', content: [] })
  })
})

describe('documentJsonToMarkdown', () => {
  it('表格、图片、链接、任务列表写回 Markdown 时不丢', () => {
    const markdown = documentJsonToMarkdown(markdownToDocumentJson(SAMPLE_MARKDOWN))

    expect(markdown).toContain('# 产品调研笔记')
    // 序列化器会按列宽补齐空格（`| 链路    | 状态  |`），这里按结构而不是
    // 逐字节空格断言，避免把「对齐填充」当成回归。
    expect(markdown).toMatch(/\| 链路\s+\| 状态\s+\|/)
    expect(markdown).toMatch(/\| Gmail\s+\|/)
    expect(markdown).toContain('![架构图](https://example.com/arch.png)')
    expect(markdown).toContain('[连接器架构评审](https://example.com/review)')
    expect(markdown).toContain('- [ ] 映射表三处同值收口')
    expect(markdown).toContain('- [x] 双链路现状盘点')
  })

  it('解析 → 序列化 → 再解析 → 再序列化 稳定（不会越存越坏）', () => {
    const once = documentJsonToMarkdown(markdownToDocumentJson(SAMPLE_MARKDOWN))
    const twice = documentJsonToMarkdown(markdownToDocumentJson(once))
    expect(twice).toBe(once)
  })

  it('空文稿序列化为空串', () => {
    expect(documentJsonToMarkdown({ type: 'doc', content: [] })).toBe('')
  })

  it('扩展集覆盖旧编辑器同款节点（StarterKit + 任务列表 + 图片 + 表格 + Markdown）', () => {
    const names = createMarkdownDocumentExtensions().map((extension) => extension.name)
    expect(names).toContain('starterKit')
    expect(names).toContain('taskList')
    expect(names).toContain('taskItem')
    expect(names).toContain('image')
    expect(names).toContain('tableKit')
    expect(names).toContain('markdown')
  })
})

describe('frontmatter 拆分 / 拼接', () => {
  it('有 frontmatter 时逐字节保留，正文单独走 Tiptap', () => {
    const frontmatter = '---\ntitle: 产品调研笔记\ntags: [调研, 连接器]\n---\n'
    const body = '# 产品调研笔记\n\n三条链路并存。\n'
    const parts = splitMarkdownDocument(`${frontmatter}${body}`)
    expect(parts.frontmatter).toBe(frontmatter)
    expect(parts.body).toBe(body)

    const savedBody = documentJsonToMarkdown(markdownToDocumentJson(parts.body))
    const saved = joinMarkdownDocument(parts.frontmatter, savedBody)
    expect(saved.startsWith(frontmatter)).toBe(true)
    expect(saved).toContain('# 产品调研笔记')
    expect(saved).toContain('三条链路并存')
  })

  it('CRLF frontmatter 也逐字节保留（不被序列化改写）', () => {
    const frontmatter = '---\r\ntitle: 笔记\r\ntags: [a, b]\r\n---\r\n'
    const body = '# 正文\r\n\r\n段落。\r\n'
    const parts = splitMarkdownDocument(`${frontmatter}${body}`)
    expect(parts.frontmatter).toBe(frontmatter)
    const saved = joinMarkdownDocument(parts.frontmatter, documentJsonToMarkdown(markdownToDocumentJson(parts.body)))
    expect(saved.startsWith(frontmatter)).toBe(true)
    expect(saved).toContain('# 正文')
  })

  it('没有 frontmatter 时整段都是正文', () => {
    const parts = splitMarkdownDocument('# 标题\n\n正文\n')
    expect(parts.frontmatter).toBe('')
    expect(parts.body).toBe('# 标题\n\n正文\n')
  })
})