import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { MessageSquarePlus } from 'lucide-react'
import { PluginKey, TextSelection } from '@tiptap/pm/state'
import {
  ArrowUp,
  Bold,
  Code2,
  Italic,
  Link2,
  Maximize2,
  Replace,
  RotateCcw,
  Sparkles,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Underline,
  Unlink2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from '@/i18n/LocaleContext'

import { showToast } from '@/state/toast'
import { EditorIconButton } from './EditorIconButton'
import { DOCUMENT_IMAGE_ACCEPT, storeDocumentImageFile } from './documentImageAssets'
import { blockIndexTargetFromClipboardText } from './blockIndexLink'
import { handleBlockIndexPaste } from './BlockIndexMark'
import {
  clearSelectionRewritePromptDecoration,
  showSelectionRewritePromptDecoration,
} from './TiptapSelectionRewrite'
import { documentsApi } from '@/components/office-editor/documentApi'

function normalizeLink(value: string): string | null {
  const link = value.trim()
  if (!link || /^(javascript|data):/i.test(link)) return null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(link)) return `mailto:${link}`
  return /^[a-z][a-z\d+.-]*:/i.test(link) ? link : `https://${link}`
}

/**
 * 云文档选区批注：和其他 Office（Word/Excel/PPT 嵌入版）同一个语义——
 * 选中的原文 + 用户原话交给宿主工作空间的「待发送批注」队列，出现在对话输入框
 * 上方，和 Agent 一起发送；不写文稿评论表、也不做内联改写。
 */
export interface SelectionNoteInput {
  /** 用户敲的原话（不含定位包装）。 */
  instruction: string
  /** 选区原文快照，供对话侧批注卡片显示原文。 */
  excerpt: string
  /** 选区所在块的稳定 block id（云文档按 blockId 定位），非块内选区时为 null。 */
  blockId: string | null
}

const IMAGE_PREVIEW_MIN_SCALE = 0.25
const IMAGE_PREVIEW_MAX_SCALE = 4
const IMAGE_PREVIEW_SCALE_STEP = 0.25

function clampImagePreviewScale(scale: number): number {
  return Math.min(IMAGE_PREVIEW_MAX_SCALE, Math.max(IMAGE_PREVIEW_MIN_SCALE, scale))
}

export function TiptapBubbleToolbar({
  editor,
  documentId,
  sourceRoomId,
  onAskAi,
  onAddSelectionNote,
  appendTo,
}: {
  editor: Editor
  documentId: string
  sourceRoomId: string
  onAskAi: (instruction: string) => void
  /** 传入后选区入口切成「评论」：写入宿主对话侧的待发送批注队列（与 Word/Excel 一致）。
   *  不传则保留旧的「Ask AI 内联改写 + 写文稿评论表」入口。 */
  onAddSelectionNote?: (note: SelectionNoteInput) => void
  /**
   * 浮层挂载点（默认编辑器 contenteditable 的父节点 = 正文滚动容器内部）。
   *
   * 传编辑器根节点把浮层移出滚动容器：绝对定位的浮层一旦挂在滚动容器里，选区靠
   * 右缘时会把它撑进 scrollWidth，横向滚动条反复出现/消失，滚动容器的 content 宽度
   * 随之变化 → 版心（64cqw）与 textarea 一起重排，看起来就是整页/标签宽度在抖。
   * 移出滚动容器后浮层不再参与正文的 overflow 计算。
   */
  appendTo?: () => HTMLElement
}) {
  const { t } = useLocale()
  const noteMode = Boolean(onAddSelectionNote)
  const [linkOpen, setLinkOpen] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const commentSelectionRef = useRef<{ from: number; to: number; blockId: string | null; quotedText: string } | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSubmitting, setNoteSubmitting] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [askAiOpen, setAskAiOpen] = useState(false)
  const [askAiInstruction, setAskAiInstruction] = useState('')
  const [imageAltOpen, setImageAltOpen] = useState(false)
  const [imageAltValue, setImageAltValue] = useState('')
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null)
  const [imagePreviewScale, setImagePreviewScale] = useState(1)
  const [imagePreviewSize, setImagePreviewSize] = useState<{ width: number; height: number } | null>(null)
  const askAiFormRef = useRef<HTMLFormElement>(null)
  const noteFormRef = useRef<HTMLFormElement>(null)
  // 浮层插件显式 key：内容从格式条换成输入表单时宽度会变，需要主动要求重算位置。
  const bubbleMenuKey = useMemo(() => new PluginKey('contextRoomTiptapBubbleMenu'), [])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imagePositionRef = useRef<number | null>(null)
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      const selection = currentEditor.state.selection

      return {
        askAiDisabled: !(selection instanceof TextSelection) ||
          selection.empty,
        boldActive: currentEditor.isActive('bold'),
        codeActive: currentEditor.isActive('code'),
        italicActive: currentEditor.isActive('italic'),
        imageActive: currentEditor.isActive('image'),
        imageHeight: currentEditor.getAttributes('image').height as number | null | undefined,
        imageSrc: currentEditor.getAttributes('image').src as string | null | undefined,
        imageWidth: currentEditor.getAttributes('image').width as number | null | undefined,
        linkActive: currentEditor.isActive('link'),
        strikeActive: currentEditor.isActive('strike'),
        underlineActive: currentEditor.isActive('underline'),
      }
    },
  })

  const openLink = () => {
    setLinkValue(editor.getAttributes('link').href ?? '')
    setLinkOpen((open) => !open)
  }

  const applyLink = () => {
    const raw = linkValue.trim()
    // 块/记忆链接不落文字链接——挂成索引 chip（复用粘贴路径的校验与 toast）。
    if (blockIndexTargetFromClipboardText(raw)) {
      handleBlockIndexPaste(
        editor.view,
        { clipboardData: { getData: (type: string) => (type === 'text/plain' ? raw : '') } },
        { sourceRoomId },
      )
      setLinkOpen(false)
      return
    }
    const href = normalizeLink(linkValue)
    if (!href) return
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setLinkOpen(false)
  }

  const closeAskAi = () => {
    clearSelectionRewritePromptDecoration(editor)
    setAskAiOpen(false)
  }

  /** 选区快照：原文摘录 + 所在块稳定 id（评论/批注两种入口共用）。 */
  const captureSelection = () => {
    const { from, to, $from } = editor.state.selection
    // 捕获选区所在块的稳定块 id（data-block-id），锚定优先走块而不是文本匹配。
    let blockId: string | null = null
    for (let depth = $from.depth; depth >= 1; depth -= 1) {
      const candidate = $from.node(depth)?.attrs?.id
      if (typeof candidate === 'string' && candidate.trim()) {
        blockId = candidate.trim()
        break
      }
    }
    commentSelectionRef.current = {
      from,
      to,
      blockId,
      quotedText: editor.state.doc.textBetween(from, to, ' ').slice(0, 500),
    }
    return commentSelectionRef.current
  }

  const openSelectionNote = () => {
    if (!onAddSelectionNote) return
    captureSelection()
    setLinkOpen(false)
    setAskAiOpen(false)
    setCommentOpen(false)
    setNoteDraft('')
    setNoteOpen(true)
  }

  const submitSelectionNote = () => {
    if (!onAddSelectionNote || noteSubmitting) return
    const selection = commentSelectionRef.current
    const body = noteDraft.trim()
    if (!selection || !body) return
    setNoteSubmitting(true)
    try {
      onAddSelectionNote({
        instruction: body,
        excerpt: selection.quotedText,
        blockId: selection.blockId,
      })
      setNoteOpen(false)
      setNoteDraft('')
      showToast({
        title: t('contextRoom:tiptapBubbleToolbar.commentQueued'),
        message: t('contextRoom:tiptapBubbleToolbar.commentQueuedHint'),
      })
    } catch (error) {
      showToast({
        title: t('contextRoom:tiptapBubbleToolbar.commentQueueFailed'),
        message: error instanceof Error ? error.message : t('contextRoom:tiptapBubbleToolbar.tryAgainLater'),
      })
    } finally {
      setNoteSubmitting(false)
    }
  }

  const updateSelectedImage = (attrs: Record<string, unknown>) => {
    const position = imagePositionRef.current
    const chain = editor.chain().focus()
    if (position !== null) chain.setNodeSelection(position)
    chain.updateAttributes('image', attrs).run()
  }

  const replaceImage = async (file: File) => {
    const documents = documentsApi()
    if (!documents) throw new Error(t('contextRoom:tiptapBubbleToolbar.theLocalImageServiceIsUnavailable'))
    const stored = await storeDocumentImageFile(file, documentId, documents.storeImage)
    updateSelectedImage({
      src: stored.src,
      alt: file.name.replace(/\.[^.]+$/, ''),
      width: null,
      height: null,
    })
  }

  const applyImageAlt = () => {
    updateSelectedImage({ alt: imageAltValue.trim() || null })
    setImageAltOpen(false)
  }

  const closeImagePreview = () => {
    setImagePreview(null)
    setImagePreviewScale(1)
    setImagePreviewSize(null)
  }

  const changeImagePreviewScale = (delta: number) => {
    setImagePreviewScale((scale) => clampImagePreviewScale(scale + delta))
  }

  const submitAskAi = () => {
    onAskAi(askAiInstruction)
    setAskAiInstruction('')
    setAskAiOpen(false)
  }

  useEffect(() => () => {
    clearSelectionRewritePromptDecoration(editor)
  }, [editor])

  useEffect(() => {
    const closeEditorsOnSelectionChange = () => {
      setLinkOpen(false)
      setImageAltOpen(false)
      // 选区变了，之前捕获的批注快照就不再代表用户眼前选中的文本：收起评论输入。
      setNoteOpen(false)
    }
    editor.on('selectionUpdate', closeEditorsOnSelectionChange)
    return () => {
      editor.off('selectionUpdate', closeEditorsOnSelectionChange)
    }
  }, [editor])

  /**
   * 浮层内容变宽后重算位置。
   *
   * 工具条（B/I/U/S…）只有约 250px，点「评论 / Ask AI / 链接」后换成 340px 的输入
   * 表单，但 floating-ui 不会因为浮层自身尺寸变化而重算位置（插件只在选区/滚动/
   * 窗口 resize 时更新）。选区靠编辑器右缘时，表单按旧锚点左右展开就会溢出滚动
   * 容器，发送（↑）与取消（✕）按钮被裁掉。这里在表单打开后的下一帧派发一次
   * 'updatePosition'，让 shift 把浮层重新收进可视区。
   */
  useEffect(() => {
    if (!askAiOpen && !noteOpen && !linkOpen && !imageAltOpen && !commentOpen) return
    const frame = window.requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(bubbleMenuKey, 'updatePosition'))
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [askAiOpen, noteOpen, linkOpen, imageAltOpen, commentOpen, bubbleMenuKey, editor])

  /**
   * 浮层移到滚动容器外以后，正文滚动不会再把它一起带走（之前它是滚动内容的子节点，
   * 视觉上贴着选区滚动）。这里监听正文滚动、按帧要求重算位置，保持浮层始终贴住选区。
   */
  useEffect(() => {
    const scrollParent = editor.view.dom.closest('.context-room-tiptap-scroll')
    if (!(scrollParent instanceof HTMLElement)) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (editor.isDestroyed) return
        editor.view.dispatch(editor.state.tr.setMeta(bubbleMenuKey, 'updatePosition'))
      })
    }
    scrollParent.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollParent.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [bubbleMenuKey, editor])

  useEffect(() => {
    if (!askAiOpen && !noteOpen) return
    const closeForOutsidePointer = (event: PointerEvent) => {
      if (askAiFormRef.current?.contains(event.target as globalThis.Node)) return
      if (noteFormRef.current?.contains(event.target as globalThis.Node)) return
      clearSelectionRewritePromptDecoration(editor)
      setAskAiOpen(false)
      setNoteOpen(false)
    }
    document.addEventListener('pointerdown', closeForOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeForOutsidePointer)
  }, [askAiOpen, noteOpen, editor])

  useEffect(() => {
    if (!imagePreview) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeImagePreview()
      if (event.key === '+' || event.key === '=') changeImagePreviewScale(IMAGE_PREVIEW_SCALE_STEP)
      if (event.key === '-') changeImagePreviewScale(-IMAGE_PREVIEW_SCALE_STEP)
      if (event.key === '0') setImagePreviewScale(1)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [imagePreview])

  return (
    <>
      <BubbleMenu
        editor={editor}
        className="context-room-tiptap-bubble"
        pluginKey={bubbleMenuKey}
        appendTo={appendTo}
        shouldShow={({ editor: currentEditor }) => currentEditor.isActive('image') || (
          !currentEditor.state.selection.empty && !currentEditor.isActive('table')
        )}
      >
      <input
        ref={imageInputRef}
        type="file"
        accept={DOCUMENT_IMAGE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.currentTarget.value = ''
          if (!file) return
          void replaceImage(file).catch((error: unknown) => {
            showToast({
              title: t('contextRoom:tiptapBubbleToolbar.unableToReplaceImage'),
              message: error instanceof Error ? error.message : t('contextRoom:tiptapBubbleToolbar.tryAgainLater'),
            })
          })
        }}
      />
      {!toolbarState.imageActive && noteMode && noteOpen ? (
        <form
          ref={noteFormRef}
          className="context-room-tiptap-bubble-ai context-room-tiptap-bubble-note"
          onSubmit={(event) => { event.preventDefault(); submitSelectionNote() }}
        >
          <MessageSquarePlus aria-hidden="true" />
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.commentInput')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.commentQueuePlaceholder')}
            value={noteDraft}
            maxLength={4000}
            onChange={(event) => setNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setNoteOpen(false)
              }
            }}
          />
          <button
            type="submit"
            disabled={noteSubmitting || !noteDraft.trim()}
            aria-label={t('contextRoom:tiptapBubbleToolbar.commentQueue')}
            title={t('contextRoom:tiptapBubbleToolbar.commentQueue')}
          ><ArrowUp /></button>
          <button
            type="button"
            aria-label={t('contextRoom:tiptapBubbleToolbar.close')}
            title={t('contextRoom:tiptapBubbleToolbar.close')}
            onClick={() => setNoteOpen(false)}
          ><X /></button>
        </form>
      ) : !commentOpen || toolbarState.imageActive ? toolbarState.imageActive ? imageAltOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyImageAlt() }}>
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.imageAltText')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.altText')}
            value={imageAltValue}
            onChange={(event) => setImageAltValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setImageAltOpen(false)
              }
            }}
          />
          <button type="submit">{t('contextRoom:tiptapBubbleToolbar.apply')}</button>
        </form>
      ) : (
        <>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.replaceImage')}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              imageInputRef.current?.click()
            }}
          ><Replace /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.altText')}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              setImageAltValue(String(editor.getAttributes('image').alt ?? ''))
              setImageAltOpen(true)
            }}
          ><TextCursorInput /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.openLargePreview')}
            disabled={!toolbarState.imageSrc}
            onClick={() => {
              const attributes = editor.getAttributes('image')
              if (typeof attributes.src !== 'string' || !attributes.src) return
              setImagePreviewScale(1)
              setImagePreviewSize(null)
              setImagePreview({
                src: attributes.src,
                alt: typeof attributes.alt === 'string' ? attributes.alt : '',
              })
            }}
          ><Maximize2 /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.restoreOriginalSize')}
            disabled={toolbarState.imageWidth == null && toolbarState.imageHeight == null}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              updateSelectedImage({ width: null, height: null })
            }}
          ><RotateCcw /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.deleteImage')}
            onClick={() => editor.chain().focus().deleteSelection().run()}
          ><Trash2 /></EditorIconButton>
        </>
      ) : askAiOpen ? (
        <form ref={askAiFormRef} className="context-room-tiptap-bubble-ai" onSubmit={(event) => { event.preventDefault(); submitAskAi() }}>
          <Sparkles aria-hidden="true" />
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.rewriteInstructions')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.howShouldThisBeRewritten')}
            value={askAiInstruction}
            onChange={(event) => setAskAiInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeAskAi()
              }
            }}
          />
          <button type="submit" aria-label={t('contextRoom:tiptapBubbleToolbar.startRewriting')} title={t('contextRoom:tiptapBubbleToolbar.startRewriting')}><ArrowUp /></button>
          <button type="button" aria-label={t('contextRoom:tiptapBubbleToolbar.close')} title={t('contextRoom:tiptapBubbleToolbar.close')} onClick={closeAskAi}><X /></button>
        </form>
      ) : linkOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyLink() }}>
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.linkUrl')}
            placeholder="https://"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
          />
          <button type="submit">{t('contextRoom:tiptapBubbleToolbar.apply')}</button>
          </form>
      ) : (
        <>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.bold')} active={toolbarState.boldActive} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.italic')} active={toolbarState.italicActive} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.underline')} active={toolbarState.underlineActive} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.strikethrough')} active={toolbarState.strikeActive} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.inlineCode')} active={toolbarState.codeActive} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.addLink')} active={toolbarState.linkActive} onClick={openLink}><Link2 /></EditorIconButton>
          {toolbarState.linkActive ? (
            <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.removeLink')} onClick={() => editor.chain().focus().unsetLink().run()}><Unlink2 /></EditorIconButton>
          ) : null}
          <span className="context-room-tiptap-bubble-divider" />
          {noteMode ? (
            <button
              type="button"
              className="context-room-tiptap-ask-ai context-room-tiptap-selection-note"
              aria-label={t('contextRoom:tiptapBubbleToolbar.commentEntry')}
              title={toolbarState.askAiDisabled
                ? t('contextRoom:tiptapBubbleToolbar.selectSomeText')
                : t('contextRoom:tiptapBubbleToolbar.commentEntry')}
              disabled={toolbarState.askAiDisabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={openSelectionNote}
            >
              <MessageSquarePlus aria-hidden="true" />
              <span>{t('contextRoom:tiptapBubbleToolbar.commentEntry')}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="context-room-tiptap-ask-ai"
                aria-label="Ask AI"
                title={toolbarState.askAiDisabled ? t('contextRoom:tiptapBubbleToolbar.selectSomeText') : 'Ask AI'}
                disabled={toolbarState.askAiDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!showSelectionRewritePromptDecoration(editor)) return
                  setLinkOpen(false)
                  setAskAiOpen(true)
                }}
              >
                <Sparkles aria-hidden="true" />
                <span>Ask AI</span>
              </button>
              <span className="context-room-tiptap-bubble-divider" />
              <EditorIconButton
                label={t('contextRoom:tiptapBubbleToolbar.addComment')}
                onClick={() => {
                  captureSelection()
                  setLinkOpen(false)
                  setAskAiOpen(false)
                  setCommentDraft('')
                  setCommentOpen(true)
                }}
              ><MessageSquarePlus aria-hidden="true" /></EditorIconButton>
            </>
          )}
        </>
      ) : null}
      {!noteMode && commentOpen && !toolbarState.imageActive ? (
        <form
          className="context-room-tiptap-bubble-comment"
          onSubmit={(event) => {
            event.preventDefault()
            const selection = commentSelectionRef.current
            const body = commentDraft.trim()
            if (!selection || !body || commentSubmitting) return
            setCommentSubmitting(true)
            void documentsApi()?.createDocumentComment(documentId, {
              body,
              blockId: selection.blockId,
              quotedText: selection.quotedText || null,
            })
              .then(() => {
                setCommentOpen(false)
                setCommentDraft('')
                window.dispatchEvent(new CustomEvent('everroom:document-comments-changed', { detail: { documentId } }))
                showToast({ title: t('contextRoom:tiptapBubbleToolbar.commentAdded') })
              })
              .catch((error: unknown) => {
                showToast({
                  title: t('contextRoom:tiptapBubbleToolbar.commentFailed'),
                  message: error instanceof Error ? error.message : undefined,
                })
              })
              .finally(() => setCommentSubmitting(false))
          }}
        >
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.commentInput')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.commentPlaceholder')}
            value={commentDraft}
            maxLength={4000}
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setCommentOpen(false)
              }
            }}
          />
          <button type="submit" disabled={commentSubmitting || !commentDraft.trim()}>
            {t('contextRoom:tiptapBubbleToolbar.commentSubmit')}
          </button>
        </form>
      ) : null}
      </BubbleMenu>
      {imagePreview && typeof document !== 'undefined' ? createPortal(
        <div
          className="context-room-document-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={t('contextRoom:tiptapBubbleToolbar.imagePreview')}
          data-scale={imagePreviewScale}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeImagePreview()
          }}
        >
          <button
            type="button"
            className="context-room-document-image-preview-close"
            aria-label={t('contextRoom:tiptapBubbleToolbar.closeImagePreview')}
            title={t('contextRoom:tiptapBubbleToolbar.close')}
            autoFocus
            onClick={closeImagePreview}
          >
            <X aria-hidden="true" />
          </button>
          <div
            className="context-room-document-image-preview-viewport"
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return
              event.preventDefault()
              changeImagePreviewScale(event.deltaY < 0
                ? IMAGE_PREVIEW_SCALE_STEP
                : -IMAGE_PREVIEW_SCALE_STEP)
            }}
          >
            <div className="context-room-document-image-preview-canvas">
              <img
                src={imagePreview.src}
                alt={imagePreview.alt}
                draggable={false}
                style={imagePreviewSize ? {
                  width: imagePreviewSize.width * imagePreviewScale,
                  height: imagePreviewSize.height * imagePreviewScale,
                  maxWidth: 'none',
                  maxHeight: 'none',
                } : undefined}
                onLoad={(event) => {
                  if (imagePreviewSize) return
                  const { width, height } = event.currentTarget.getBoundingClientRect()
                  if (width > 0 && height > 0) setImagePreviewSize({ width, height })
                }}
              />
            </div>
          </div>
          <div className="context-room-document-image-preview-controls" aria-label={t('contextRoom:tiptapBubbleToolbar.previewZoom')}>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.zoomOutImage')}
              title={t('contextRoom:tiptapBubbleToolbar.zoomOut')}
              disabled={imagePreviewScale <= IMAGE_PREVIEW_MIN_SCALE}
              onClick={() => changeImagePreviewScale(-IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomOut aria-hidden="true" /></button>
            <output aria-live="polite">{Math.round(imagePreviewScale * 100)}%</output>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.zoomInImage')}
              title={t('contextRoom:tiptapBubbleToolbar.zoomIn')}
              disabled={imagePreviewScale >= IMAGE_PREVIEW_MAX_SCALE}
              onClick={() => changeImagePreviewScale(IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomIn aria-hidden="true" /></button>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.fitToView')}
              title={t('contextRoom:tiptapBubbleToolbar.fitToView')}
              disabled={imagePreviewScale === 1}
              onClick={() => setImagePreviewScale(1)}
            ><RotateCcw aria-hidden="true" /></button>
          </div>
          {imagePreview.alt ? <span>{imagePreview.alt}</span> : null}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
