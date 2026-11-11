/**
 * 侧栏 Markdown 文件 ⇄ 旧文稿编辑器（Tiptap cloud-document）JSON 的适配层。
 *
 * 旧编辑器（`components/office-editor/editor/TiptapDocumentEditor.tsx`）吃的是
 * 文稿后端的 `TiptapJsonContent`（type: 'doc'）。侧栏打开的是文件库里的真实
 * `.md` / `.markdown`，所以需要一份「不依赖 Editor 实例」的纯转换：
 *
 * - `markdownToDocumentJson(body)`：Markdown 正文 → 文稿 JSON（挂载时用）；
 * - `documentJsonToMarkdown(json)`：文稿 JSON → Markdown 正文（保存时用）。
 *
 * 实现用 `@tiptap/markdown` 的 `MarkdownManager`：它只依赖扩展声明的
 * markdown 解析/序列化规则，不需要 ProseMirror view。扩展集必须与真实编辑器
 * 对齐（StarterKit + 任务列表 + 图片 + 表格），否则解析到 schema 里没有的节点
 * 会整段丢弃——表格消失、`![alt](url)` 只剩 alt 文本，用户改一个字再保存就把
 * 原文件改坏。
 *
 * frontmatter 不参与 Tiptap 解析：调用方先用 `splitMarkdownDocument` 剥出来、
 * 保存时再用 `joinMarkdownDocument` 拼回去（逐字节保留）。
 */
import Image from '@tiptap/extension-image'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { resolveExtensions, type Extensions } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { TiptapJsonContent } from '@nxcore/agent-contract'

/** `@tiptap/markdown` 期望的缩进设置（与旧编辑器一致：两个空格）。 */
const MARKDOWN_INDENTATION = { style: 'space', size: 2 } as const

/**
 * 侧栏 Markdown ⇄ 文稿 JSON 使用的扩展集。
 *
 * 与旧编辑器保持同一套节点/标记能力，差异只在「面向本地文件」的取舍：
 * - `link.openOnClick=false`：侧栏里点链接不能让 Electron 窗口跳走；
 * - `Image.allowBase64=true`：本地 Markdown 笔记里内嵌 data URI 图片很常见，
 *   禁用会在解析时静默丢掉；
 * - `TableKit.table.resizable=false`：侧栏窄面板里列宽手柄没有意义。
 */
export function createMarkdownDocumentExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ allowBase64: true }),
    TableKit.configure({ table: { resizable: false } }),
    Markdown.configure({ indentation: { ...MARKDOWN_INDENTATION } }),
  ]
}

let cachedManager: MarkdownManager | null = null

/**
 * 模块级单例：MarkdownManager 的构造要遍历扩展、建立 tokenizer/registry，
 * 每个文件打开都重建一次太浪费（打开侧栏文件是高频操作）。
 */
function markdownManager(): MarkdownManager {
  if (!cachedManager) {
    cachedManager = new MarkdownManager({
      extensions: resolveExtensions(createMarkdownDocumentExtensions()),
      indentation: { ...MARKDOWN_INDENTATION },
    })
  }
  return cachedManager
}

/**
 * Markdown 正文 → 文稿 JSON。
 *
 * `MarkdownManager.parse` 返回的就是 `{ type: 'doc', content: [...] }`；个别
 * 空串/纯文本输入可能只回一个节点，这里统一包成 doc，保证旧编辑器拿到的形状
 * 与文稿后端一致（`stripDocumentTitle`/`setContent` 都按 doc 处理）。
 */
export function markdownToDocumentJson(body: string): TiptapJsonContent {
  const source = typeof body === 'string' ? body : ''
  const parsed = markdownManager().parse(source) as TiptapJsonContent
  if (parsed && parsed.type === 'doc') return parsed
  if (parsed && typeof parsed.type === 'string') {
    return { type: 'doc', content: [parsed] }
  }
  return { type: 'doc', content: [] }
}

/** 文稿 JSON → Markdown 正文（frontmatter 由调用方拼回）。 */
export function documentJsonToMarkdown(json: TiptapJsonContent): string {
  const markdown = markdownManager().serialize(json)
  return typeof markdown === 'string' ? markdown : ''
}