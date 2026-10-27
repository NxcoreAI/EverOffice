import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/react'
import { FileText, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { parseMarkdownDocument } from '@/components/office-editor/editor/markdownImport'
import { useLocale } from '@/i18n/LocaleContext'

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  TaskList,
  TaskItem.configure({ nested: true }),
]

/** 只读预览的空白文档：拿到 markdown 前先渲染空文档，避免编辑器反复销毁重建。 */
const EMPTY_DOCUMENT = parseMarkdownDocument('')

/**
 * 通过预加载 API 读取工作区文稿的 markdown 正文（草稿列表只带 documentId，没有正文）。
 * 独立导出便于在无 DOM 的测试环境里直接覆盖读取语义。
 */
export async function readAgentDraftMarkdown(documentId: string): Promise<string> {
  const readMarkdown = window.nxcore?.documents?.readMarkdown
  if (typeof readMarkdown !== 'function') throw new Error('documents.readMarkdown is unavailable')
  const result = await readMarkdown(documentId)
  return result.markdown
}

/**
 * Agent 草稿（幻灯片内容稿等）的只读预览弹窗。
 *
 * 渲染方式与 sources 的 MarkdownPreviewDialog 保持一致：Tiptap 只读 + parseMarkdownDocument，
 * 关闭后回到对话，不再把用户挡在「不在当前 Room」的 toast 死路上。
 */
export function AgentDraftPreviewDialog({
  documentId,
  onClose,
}: {
  documentId: string
  onClose: () => void
}) {
  const { t } = useLocale()
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)
    setFailed(false)
    void readAgentDraftMarkdown(documentId)
      .then((text) => {
        if (!cancelled) setMarkdown(text)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [documentId])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const editor = useEditor({
    extensions,
    content: EMPTY_DOCUMENT,
    editable: false,
    editorProps: { attributes: { class: 'markdown-preview-document' } },
  })

  useEffect(() => {
    if (!editor || markdown === null) return
    editor.commands.setContent(parseMarkdownDocument(markdown), { emitUpdate: false })
  }, [editor, markdown])

  const body = (() => {
    if (failed) {
      return (
        <div className="evidence-viewer-state" role="alert">
          <FileText aria-hidden="true" />
          {t('surface:agentChat.SLIDES_OPEN_FAILED')}
        </div>
      )
    }
    if (markdown === null) {
      return (
        <div className="evidence-viewer-state" role="status">
          <FileText aria-hidden="true" />
          {t('surface:agentChat.slidesDraftNoRoomNotice')}
        </div>
      )
    }
    return editor
      ? <EditorContent editor={editor} />
      : <div className="evidence-viewer-state"><FileText aria-hidden="true" />{t('surface:markdownPreviewDialog.preparingPreview')}</div>
  })()

  return (
    <div
      className="evidence-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section
        className="evidence-dialog markdown-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-draft-preview-title"
      >
        <header className="evidence-dialog-head">
          <div>
            <span>{t('surface:agentChat.slidesOpenDraft')}</span>
            <h2 id="agent-draft-preview-title">{documentId}</h2>
          </div>
          <span className="evidence-dialog-actions">
            <button
              type="button"
              className="icon-button"
              title={t('surface:markdownPreviewDialog.close')}
              aria-label={t('surface:markdownPreviewDialog.closeMarkdownPreview')}
              onClick={onClose}
            >
              <X aria-hidden="true" strokeWidth={1.8} />
            </button>
          </span>
        </header>
        <div className="markdown-preview-body">{body}</div>
      </section>
    </div>
  )
}
