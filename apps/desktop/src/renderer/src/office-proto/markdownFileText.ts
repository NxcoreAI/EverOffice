/**
 * 侧栏 Markdown 编辑器用的纯文本工具：文件名判定、YAML frontmatter 拆分/拼接。
 *
 * 这里刻意不依赖 React / Tiptap / window，全部逻辑可单测：
 * - `splitMarkdownDocument` 只把 frontmatter 从正文里剥出来（原文逐字节保留），
 *   旧文稿编辑器只解析正文，保存时再由 `joinMarkdownDocument` 拼回去。
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
