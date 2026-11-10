/**
 * 侧栏 Markdown 编辑器用的纯文本工具：文件名判定、YAML frontmatter 拆分/拼接、
 * 以及带抖动与串行化的保存队列。
 *
 * 这里刻意不依赖 React / Tiptap / window，全部逻辑可单测：
 * - `splitMarkdownDocument` 只把 frontmatter 从正文里剥出来（原文逐字节保留），
 *   Tiptap 只解析正文，保存时再由 `joinMarkdownDocument` 拼回去；
 * - `MarkdownSaveQueue` 负责 800ms 抖动、在途保存的合并（coalesce）、失败重试与
 *   卸载前 flush，UI 只需要订阅 status。
 */

/* ───────────────────── 文件名判定 ───────────────────── */

/**
 * 文件名是否是 Markdown：`.md` / `.markdown`，大小写不敏感。
 * 容错：带路径（`/a/b/笔记.md`）、带 query/hash（`笔记.md?raw=1`）、
 * Windows 反斜杠路径都会被先规整到 basename。
 */
export function isMarkdownFileName(name: string): boolean {
  if (!name) return false
  let clean = name.trim()
  const queryIndex = clean.search(/[?#]/)
  if (queryIndex >= 0) clean = clean.slice(0, queryIndex)
  clean = clean.replace(/\\/g, '/')
  const slashIndex = clean.lastIndexOf('/')
  if (slashIndex >= 0) clean = clean.slice(slashIndex + 1)
  return /\.(?:md|markdown)$/i.test(clean.trim())
}

/* ───────────────────── frontmatter 拆分 / 拼接 ───────────────────── */

export interface MarkdownDocumentParts {
  /** 含开头与结尾分隔行的 YAML frontmatter（逐字节保留，含换行）；没有时为空串。 */
  frontmatter: string
  /** 正文（frontmatter 之后的所有内容）。 */
  body: string
}

/**
 * 拆分出文件开头的 YAML frontmatter。
 *
 * 约定：frontmatter 必须以 `---\n`（或 CRLF 的 `---\r\n`）开头，并以单独一行
 * `---` 结束；拆分结果满足 `frontmatter + body === text`（逐字节不变）。
 * 没有合法的闭合分隔行时整段视为正文，不做任何截断。
 */
export function splitMarkdownDocument(text: string): MarkdownDocumentParts {
  const source = typeof text === 'string' ? text : ''
  const lfStart = source.startsWith('---\n')
  if (!lfStart && !source.startsWith('---\r\n')) {
    return { frontmatter: '', body: source }
  }

  let cursor = lfStart ? 4 : 5
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor)
    const contentEnd = newline < 0 ? source.length : (newline > cursor && source[newline - 1] === '\r' ? newline - 1 : newline)
    if (source.slice(cursor, contentEnd) === '---') {
      const frontmatterEnd = newline < 0 ? source.length : newline + 1
      return { frontmatter: source.slice(0, frontmatterEnd), body: source.slice(frontmatterEnd) }
    }
    if (newline < 0) break
    cursor = newline + 1
  }
  return { frontmatter: '', body: source }
}

/** `splitMarkdownDocument` 的逆向操作：frontmatter 原样拼回正文前面。 */
export function joinMarkdownDocument(frontmatter: string, body: string): string {
  return `${frontmatter ?? ''}${body ?? ''}`
}

/* ───────────────────── 保存队列 ───────────────────── */

/** 自动保存的抖动窗口（毫秒）。 */
export const MARKDOWN_SAVE_DELAY_MS = 800

export type MarkdownSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface MarkdownSaveQueueOptions {
  /** 真正落盘的保存函数（组件里接 nxcore.files.saveMarkdown）。 */
  save: (markdown: string) => Promise<unknown>
  /** 抖动窗口，缺省 {@link MARKDOWN_SAVE_DELAY_MS}。 */
  delayMs?: number
  /** 状态回调（驱动「保存中… / 已保存 / 保存失败」）。 */
  onStatus?: (status: MarkdownSaveStatus) => void
}

/**
 * Markdown 自动保存队列：
 * - `schedule()` 每次编辑都重置抖动定时器，窗口内只保留最后一版；
 * - 一次保存还在途中时，新的编辑只登记 pending，等这一轮结束后立刻串行再存，
 *   保证落盘顺序与编辑顺序一致，也不会并发写同一版本链；
 * - 失败后保留失败内容，`retry()` 可重试；
 * - `dispose()` 供组件卸载时 fire-and-forget 把最后一版存掉，避免切标签丢字。
 */
export class MarkdownSaveQueue {
  private readonly save: (markdown: string) => Promise<unknown>
  private readonly delayMs: number
  private readonly onStatus?: (status: MarkdownSaveStatus) => void

  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null
  private inFlight: string | null = null
  private lastSaved: string | null = null
  private failed: string | null = null
  private status: MarkdownSaveStatus = 'idle'
  private disposed = false

  constructor(options: MarkdownSaveQueueOptions) {
    this.save = options.save
    this.delayMs = options.delayMs ?? MARKDOWN_SAVE_DELAY_MS
    this.onStatus = options.onStatus
  }

  getStatus(): MarkdownSaveStatus {
    return this.status
  }

  /** 记录一次编辑；抖动窗口内连续调用只保留最后一版。 */
  schedule(markdown: string): void {
    if (this.disposed) return
    this.pending = markdown
    this.failed = null
    this.setStatus('dirty')
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, this.delayMs)
  }

  /** 立即保存最新内容（Cmd/Ctrl+S）。保存进行中时留待本轮结束后串行。 */
  flush(): void {
    if (this.disposed) return
    this.clearTimer()
    this.drain()
  }

  /** 保存失败后重试（用户点「重试」）。 */
  retry(): void {
    if (this.disposed) return
    if (this.pending === null && this.failed !== null) this.pending = this.failed
    this.failed = null
    this.clearTimer()
    this.drain()
  }

  /**
   * 组件卸载：取消抖动并用 fire-and-forget 存掉最后一版。
   * 与最后一次成功保存内容相同（或正在保存中）就不重复写。
   */
  dispose(latestMarkdown?: string | null): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    const candidate = latestMarkdown ?? this.pending
    if (candidate !== null && candidate !== this.lastSaved && candidate !== this.inFlight) {
      this.pending = candidate
    }
    this.drainAfterDispose()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private drain(): void {
    if (this.inFlight !== null) return
    const markdown = this.pending
    if (markdown === null) return
    this.pending = null
    this.inFlight = markdown
    this.setStatus('saving')
    void this.run(markdown)
  }

  private async run(markdown: string): Promise<void> {
    try {
      await this.save(markdown)
      this.lastSaved = markdown
      this.failed = null
      this.inFlight = null
      if (this.disposed) {
        this.drainAfterDispose()
        return
      }
      if (this.pending !== null) {
        // 保存途中又有新编辑：接着存最新一版。
        this.drain()
        return
      }
      this.setStatus('saved')
    } catch {
      this.inFlight = null
      if (this.disposed) return
      this.failed = markdown
      this.setStatus('error')
    }
  }

  /** 卸载后仍然按顺序把 pending 存掉，但不再上报状态。 */
  private drainAfterDispose(): void {
    if (this.inFlight !== null) return
    if (this.pending === null) return
    const markdown = this.pending
    this.pending = null
    if (markdown === this.lastSaved) return
    this.inFlight = markdown
    void this.run(markdown)
  }

  private setStatus(status: MarkdownSaveStatus): void {
    if (this.disposed) return
    this.status = status
    this.onStatus?.(status)
  }
}
