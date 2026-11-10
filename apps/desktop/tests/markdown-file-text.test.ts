/**
 * 侧栏 Markdown 编辑器的纯逻辑回归：
 * 1) `.md` / `.markdown` 文件名判定（大小写、路径、query 容错）；
 * 2) YAML frontmatter 拆分/拼接（有/无 frontmatter、CRLF、行尾无换行）；
 * 3) MarkdownSaveQueue：800ms 抖动、在途合并、失败重试、卸载 flush。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isMarkdownFileName,
  joinMarkdownDocument,
  MARKDOWN_SAVE_DELAY_MS,
  MarkdownSaveQueue,
  splitMarkdownDocument,
  type MarkdownSaveStatus,
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

/* ───────────── 保存队列 ───────────── */

type SaveMock = ReturnType<typeof vi.fn<(markdown: string) => Promise<unknown>>>

function makeQueue(save: SaveMock) {
  const statuses: MarkdownSaveStatus[] = []
  const queue = new MarkdownSaveQueue({
    save,
    delayMs: MARKDOWN_SAVE_DELAY_MS,
    onStatus: (status) => statuses.push(status),
  })
  return { queue, statuses }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('MarkdownSaveQueue', () => {
  it('抖动窗口内多次编辑只保存最后一版', async () => {
    const save = vi.fn<(markdown: string) => Promise<unknown>>().mockResolvedValue(undefined)
    const { queue, statuses } = makeQueue(save)

    queue.schedule('a')
    queue.schedule('ab')
    queue.schedule('abc')
    expect(save).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('dirty')

    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('abc')
    expect(statuses.at(-1)).toBe('saved')

    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('保存在途时的新编辑会等本轮结束后串行再存最新版', async () => {
    const resolvers: Array<() => void> = []
    const save = vi.fn<(markdown: string) => Promise<unknown>>().mockImplementation(
      () => new Promise<void>((resolve) => { resolvers.push(resolve) }),
    )
    const { queue } = makeQueue(save)

    queue.schedule('one')
    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith('one')

    queue.schedule('two')
    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)

    resolvers[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('two')

    resolvers[1]()
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.getStatus()).toBe('saved')
  })

  it('flush 立即保存并取消抖动定时器', async () => {
    const save = vi.fn<(markdown: string) => Promise<unknown>>().mockResolvedValue(undefined)
    const { queue } = makeQueue(save)

    queue.schedule('draft')
    queue.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('draft')

    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('失败后进入 error，retry 重试同一版内容', async () => {
    const save = vi.fn<(markdown: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined)
    const { queue, statuses } = makeQueue(save)

    queue.schedule('body')
    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(statuses.at(-1)).toBe('error')

    queue.retry()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('body')
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.getStatus()).toBe('saved')
  })

  it('dispose 会把还没到抖动时间的最后一版 fire-and-forget 存掉', async () => {
    const save = vi.fn<(markdown: string) => Promise<unknown>>().mockResolvedValue(undefined)
    const { queue, statuses } = makeQueue(save)

    queue.schedule('last words')
    queue.dispose('last words')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('last words')

    await vi.advanceTimersByTimeAsync(0)
    // 卸载后不再上报状态。
    expect(statuses).not.toContain('saving')
    expect(statuses).not.toContain('saved')
  })

  it('dispose 时内容与已保存一致则不重复写', async () => {
    const save = vi.fn<(markdown: string) => Promise<unknown>>().mockResolvedValue(undefined)
    const { queue } = makeQueue(save)

    queue.schedule('saved text')
    await vi.advanceTimersByTimeAsync(MARKDOWN_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)

    queue.dispose('saved text')
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
