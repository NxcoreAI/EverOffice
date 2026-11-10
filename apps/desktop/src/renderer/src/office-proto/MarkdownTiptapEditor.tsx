import {
  AlertTriangle,
  Bold,
  Check,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Quote,
  Redo2,
  RefreshCw,
  Strikethrough,
  Undo2,
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor, type Extensions } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extensions'

import type { OfficeFile } from './data'
import {
  joinMarkdownDocument,
  MarkdownSaveQueue,
  splitMarkdownDocument,
  type MarkdownDocumentParts,
  type MarkdownSaveStatus,
} from './markdownFileText'

import './markdownTiptapEditor.css'

/**
 * 工作空间侧栏（气泡窗）里真实 `.md` / `.markdown` 文件的 WYSIWYG 编辑器。
 *
 * 数据流：
 * 1. `nxcore.files.readText(fileId)` 读原始文本；
 * 2. `splitMarkdownDocument` 剥出 YAML frontmatter（逐字节保留，Tiptap 不解析它），
 *    正文交给 `@tiptap/markdown`（`contentType: 'markdown'`）；
 * 3. 编辑后 `editor.getMarkdown()` 序列化正文，再与 frontmatter 拼回，
 *    交给 `nxcore.files.saveMarkdown` 落成同一 fileEntry 的新版本；
 * 4. 自动保存走 800ms 抖动 + 在途合并，切标签/卸载时 fire-and-forget flush。
 */
/**
 * 编辑器扩展集（导出给单测直接构造 Editor 用）。
 *
 * 图片与表格节点必须显式注册：`@tiptap/markdown` 解析到 schema 里没有的节点时
 * 会整段丢弃——没有 TableKit 时表格消失，没有 Image 时 `![alt](url)` 只剩 alt
 * 文本，用户随便改一个字再保存就把原文件内容改坏了。
 */
export function createMarkdownEditorExtensions(): Extensions {
  return [
    // openOnClick=false：侧栏里点链接不能让 Electron 窗口跳走（用户在改稿，不是在浏览网页）。
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 保留内嵌 data URI 图片：本地 Markdown 笔记里很常见，禁用会把这些图片静默丢掉。
    Image.configure({ allowBase64: true }),
    // resizable=false：侧栏窄面板里列宽手柄没有意义，还会干扰表格内的选区操作。
    TableKit.configure({ table: { resizable: false } }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }),
    Placeholder.configure({ placeholder: '开始输入 Markdown…' }),
  ]
}

/**
 * 尚未确认落盘的编辑内容（fileId → markdown）。
 *
 * 竞态：切标签会让气泡窗卸载编辑器，卸载时的保存是 fire-and-forget；用户如果很快
 * 再打开同一个文件，`readText` 可能先于保存返回旧内容，接着自动保存又把旧内容写回
 * 新版本——编辑看起来「闪一下就丢了」。这里缓存最后一版编辑内容，重开时优先展示，
 * 保存成功后才清掉（失败则保留，用户还能继续编辑并重试）。
 */
const pendingMarkdownByFile = new Map<string, string>()

/** 测试/调试用：读取某文件尚未确认落盘的编辑内容。 */
export function pendingMarkdownFor(fileId: string): string | null {
  return pendingMarkdownByFile.get(fileId) ?? null
}

/** 测试/调试用：清空未落盘缓存（正常路径由保存成功回调清理）。 */
export function clearPendingMarkdownFor(fileId: string): void {
  pendingMarkdownByFile.delete(fileId)
}

export interface MarkdownTiptapEditorProps {
  file: OfficeFile
  onToast: (message: string) => void
  /** 可选：编辑器实例就绪回调（测试/宿主需要直接驱动命令时使用）。 */
  onEditorReady?: (editor: Editor) => void
}

export function MarkdownTiptapEditor({ file, onToast, onEditorReady }: MarkdownTiptapEditorProps) {
  const catalog = file.realCatalog
  if (!catalog) {
    return (
      <div className="wb-md-state">
        <AlertTriangle size={18} />
        <p>该文件缺少文件库信息，暂时无法在侧栏编辑。</p>
      </div>
    )
  }
  return <MarkdownTiptapFile file={file} onToast={onToast} onEditorReady={onEditorReady} />
}

/* ───────────────── 读取 / 错误 / 编辑三态 ───────────────── */

function MarkdownTiptapFile({
  file, onToast, onEditorReady,
}: MarkdownTiptapEditorProps) {
  const catalog = file.realCatalog!
  const fileId = catalog.id
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [parts, setParts] = useState<MarkdownDocumentParts | null>(null)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const toastedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError('')

    const load = async (): Promise<void> => {
      // 未确认落盘的编辑优先：切标签会卸载编辑器、保存是 fire-and-forget，用户很快
      // 再打开同一个文件时服务端可能还停在旧版本。先恢复内存里的最新内容，避免
      // 「读到旧内容 → 自动保存又把旧内容写回去」把编辑覆盖掉。
      const cached = pendingMarkdownByFile.get(fileId)
      if (cached != null) {
        if (cancelled) return
        setParts(splitMarkdownDocument(cached))
        setPhase('ready')
        return
      }
      try {
        const files = window.nxcore?.files
        if (typeof files?.readText !== 'function') throw new Error('文件服务尚未就绪')
        const result = await files.readText(fileId)
        if (cancelled) return
        setParts(splitMarkdownDocument(result?.text ?? ''))
        setPhase('ready')
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error && cause.message ? cause.message : '未知错误'
        setError(message)
        setPhase('error')
        if (!toastedRef.current) {
          toastedRef.current = true
          onToastRef.current('Markdown 文件读取失败，请重试。')
        }
      }
    }

    void load()
    return () => { cancelled = true }
  }, [fileId, reloadKey])

  if (phase === 'loading') {
    return (
      <div className="wb-md-state" role="status">
        <Loader2 size={18} className="wb-md-spin" />
        <p>正在读取 Markdown…</p>
      </div>
    )
  }

  if (phase === 'error' || !parts) {
    return (
      <div className="wb-md-state is-error" role="alert">
        <AlertTriangle size={18} />
        <p>Markdown 加载失败{error ? `：${error}` : ''}</p>
        <button
          type="button"
          className="wb-md-state-action"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={13} />
          重试
        </button>
      </div>
    )
  }

  return (
    <MarkdownTiptapSurface
      file={file}
      frontmatter={parts.frontmatter}
      body={parts.body}
      onEditorReady={onEditorReady}
    />
  )
}

/* ───────────────── 编辑器主体 ───────────────── */

function MarkdownTiptapSurface({
  file, frontmatter, body, onEditorReady,
}: {
  file: OfficeFile
  frontmatter: string
  body: string
  onEditorReady?: (editor: Editor) => void
}) {
  const [status, setStatus] = useState<MarkdownSaveStatus>('idle')
  // 工具条的 pressed / undo-redo 可用性要跟着事务刷新（这段代码只在用户输入时开销很小）。
  const [, bumpTransaction] = useState(0)

  const catalogRef = useRef(file.realCatalog!)
  catalogRef.current = file.realCatalog!
  const frontmatterRef = useRef(frontmatter)
  frontmatterRef.current = frontmatter
  const latestMarkdownRef = useRef<string | null>(null)
  const onEditorReadyRef = useRef(onEditorReady)
  onEditorReadyRef.current = onEditorReady

  // 队列只建一次（组件按 file.id 重新挂载）；save 闭包从 ref 读当前 catalog。
  const queueRef = useRef<MarkdownSaveQueue | null>(null)
  if (queueRef.current === null) {
    queueRef.current = new MarkdownSaveQueue({
      save: async (markdown) => {
        const files = window.nxcore?.files
        if (typeof files?.saveMarkdown !== 'function') throw new Error('文件服务尚未就绪')
        const catalog = catalogRef.current
        await files.saveMarkdown({
          fileId: catalog.id,
          markdown,
          originalName: catalog.originalName,
          workspaceId: catalog.workspaceId,
        })
        // 落盘成功、且此后没有更新的编辑，才清掉未落盘缓存：重开时重新以服务端为准。
        if (pendingMarkdownByFile.get(catalog.id) === markdown) pendingMarkdownByFile.delete(catalog.id)
      },
      onStatus: (next) => setStatus(next),
    })
  }

  const editor = useEditor({
    extensions: createMarkdownEditorExtensions(),
    content: body,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'wb-md-tiptap-content',
        spellcheck: 'true',
        'aria-label': 'Markdown 编辑器',
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault()
          queueRef.current?.flush()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: instance }) => {
      const markdown = joinMarkdownDocument(frontmatterRef.current, instance.getMarkdown())
      latestMarkdownRef.current = markdown
      // 记一笔「未确认落盘」内容：卸载时保存是 fire-and-forget，重开要能恢复它。
      pendingMarkdownByFile.set(catalogRef.current.id, markdown)
      queueRef.current?.schedule(markdown)
    },
    onTransaction: () => bumpTransaction((value) => value + 1),
  }, [])

  // 编辑器实例就绪后交给宿主/测试（可选）。
  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor)
  }, [editor])

  // Cmd/Ctrl+S：焦点不在正文时也要能立即保存。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        queueRef.current?.flush()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 卸载（切文件/关标签/收起气泡窗）时把最后一版 fire-and-forget 存掉，避免丢字。
  useEffect(() => () => {
    queueRef.current?.dispose(latestMarkdownRef.current)
  }, [])

  return (
    <div className="wb-md-root">
      <MarkdownToolbar editor={editor} />
      <div className="wb-md-scroll">
        <div className="wb-md-page">
          <EditorContent editor={editor} className="wb-md-editor" />
        </div>
      </div>
      <MarkdownStatusBar status={status} onRetry={() => queueRef.current?.retry()} />
    </div>
  )
}

/* ───────────────── 工具条 ───────────────── */

interface ToolItem {
  key: string
  label: string
  icon: React.ReactNode
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

function MarkdownToolbar({ editor }: { editor: Editor | null }) {
  const run = (callback: (current: Editor) => void) => () => {
    if (editor) callback(editor)
  }
  const chain = (command: (current: Editor) => boolean) => run((current) => { void command(current) })

  const items: ToolItem[] = [
    {
      key: 'bold',
      label: '加粗',
      icon: <Bold size={14} />,
      active: editor?.isActive('bold') ?? false,
      onClick: chain((current) => current.chain().focus().toggleBold().run()),
    },
    {
      key: 'italic',
      label: '斜体',
      icon: <Italic size={14} />,
      active: editor?.isActive('italic') ?? false,
      onClick: chain((current) => current.chain().focus().toggleItalic().run()),
    },
    {
      key: 'strike',
      label: '删除线',
      icon: <Strikethrough size={14} />,
      active: editor?.isActive('strike') ?? false,
      onClick: chain((current) => current.chain().focus().toggleStrike().run()),
    },
    {
      key: 'code',
      label: '行内代码',
      icon: <Code size={14} />,
      active: editor?.isActive('code') ?? false,
      onClick: chain((current) => current.chain().focus().toggleCode().run()),
    },
    {
      key: 'h1',
      label: '一级标题',
      icon: <Heading1 size={15} />,
      active: editor?.isActive('heading', { level: 1 }) ?? false,
      onClick: chain((current) => current.chain().focus().toggleHeading({ level: 1 }).run()),
    },
    {
      key: 'h2',
      label: '二级标题',
      icon: <Heading2 size={15} />,
      active: editor?.isActive('heading', { level: 2 }) ?? false,
      onClick: chain((current) => current.chain().focus().toggleHeading({ level: 2 }).run()),
    },
    {
      key: 'bulletList',
      label: '无序列表',
      icon: <List size={15} />,
      active: editor?.isActive('bulletList') ?? false,
      onClick: chain((current) => current.chain().focus().toggleBulletList().run()),
    },
    {
      key: 'orderedList',
      label: '有序列表',
      icon: <ListOrdered size={15} />,
      active: editor?.isActive('orderedList') ?? false,
      onClick: chain((current) => current.chain().focus().toggleOrderedList().run()),
    },
    {
      key: 'blockquote',
      label: '引用',
      icon: <Quote size={15} />,
      active: editor?.isActive('blockquote') ?? false,
      onClick: chain((current) => current.chain().focus().toggleBlockquote().run()),
    },
  ]

  const canUndo = editor?.can().undo() ?? false
  const canRedo = editor?.can().redo() ?? false

  return (
    <div className="wb-md-toolbar" role="toolbar" aria-label="Markdown 编辑工具">
      {items.map((item, index) => {
        const needsGap = index === 4 || index === 6 || index === 8
        return (
          <React.Fragment key={item.key}>
            {needsGap ? <span className="wb-md-tool-sep" aria-hidden="true" /> : null}
            <button
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-pressed={item.active}
              className={`wb-md-tool${item.active ? ' is-active' : ''}`}
              disabled={!editor}
              onMouseDown={(event) => event.preventDefault()}
              onClick={item.onClick}
            >
              {item.icon}
            </button>
          </React.Fragment>
        )
      })}
      <span className="wb-md-tool-sep" aria-hidden="true" />
      <button
        type="button"
        title="撤销"
        aria-label="撤销"
        className="wb-md-tool"
        disabled={!editor || !canUndo}
        onMouseDown={(event) => event.preventDefault()}
        onClick={run((current) => { current.chain().focus().undo().run() })}
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        title="重做"
        aria-label="重做"
        className="wb-md-tool"
        disabled={!editor || !canRedo}
        onMouseDown={(event) => event.preventDefault()}
        onClick={run((current) => { current.chain().focus().redo().run() })}
      >
        <Redo2 size={14} />
      </button>
    </div>
  )
}

/* ───────────────── 状态条 ───────────────── */

function MarkdownStatusBar({ status, onRetry }: { status: MarkdownSaveStatus; onRetry: () => void }) {
  return (
    <div className="wb-md-status" role="status" aria-live="polite">
      {status === 'dirty' ? <span>未保存</span> : null}
      {status === 'saving' ? (
        <>
          <Loader2 size={12} className="wb-md-spin" />
          <span>保存中…</span>
        </>
      ) : null}
      {status === 'saved' ? (
        <>
          <Check size={12} />
          <span>已保存</span>
        </>
      ) : null}
      {status === 'error' ? (
        <>
          <AlertTriangle size={12} className="wb-md-status-error-icon" />
          <span>保存失败</span>
          <button type="button" className="wb-md-status-retry" onClick={onRetry}>重试</button>
        </>
      ) : null}
      {status === 'idle' ? <span className="wb-md-status-idle">⌘S 立即保存</span> : null}
    </div>
  )
}