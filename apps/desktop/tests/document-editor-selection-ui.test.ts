/**
 * 云文档选区 UI 回归（静态断言）：
 *
 * 1) 正文 contenteditable 不能被工作台全局 `.wb-root :focus-visible` 的焦点环套住
 *    （点进云文档正文时整块可编辑区出现一圈系统蓝框）。全局规则与旧 `outline: 0`
 *    特异性相同、且工作台样式在 bundle 里排在编辑器样式之后，所以必须在编辑器内
 *    用更高特异性的 `:focus-visible` 规则显式复位，文字测试防回退。
 * 2) 选区「评论」入口的词条中英齐全（与其他 Office 的批注条同一套文案）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import zhContextRoom from '../src/renderer/src/i18n/locales/zh-CN/contextRoom.json'
import enContextRoom from '../src/renderer/src/i18n/locales/en-US/contextRoom.json'

const editorCss = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/office-editor/editor/TiptapDocumentEditor.css'),
  'utf8',
)
const bubbleToolbarSource = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/office-editor/editor/TiptapBubbleToolbar.tsx'),
  'utf8',
)
const editorSource = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/office-editor/editor/TiptapDocumentEditor.tsx'),
  'utf8',
)

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('云文档编辑器焦点环', () => {
  it('正文 contenteditable 用 :focus-visible 高特异性复位 outline（不再出现蓝框）', () => {
    const body = ruleBody(editorCss, '.context-room-tiptap-scroll .tiptap:focus-visible')
    expect(body).toContain('outline: 0')
    expect(body).toContain('outline-offset: 0')
    // 旧的非 focus-visible 复位仍在（与 :focus 一起声明，键盘/鼠标焦点都覆盖）。
    expect(editorCss).toContain('.context-room-tiptap-scroll .tiptap:focus,')
  })

  it('正文里的 input/textarea（选区评论、链接、AI 改写）同样不继承全局焦点环', () => {
    const body = ruleBody(editorCss, '.context-room-tiptap-editor input:focus-visible')
    expect(body).toContain('outline: 0')
    expect(body).toContain('outline-offset: 0')
    // 选择器特异性高于 `.wb-root :focus-visible`（0,2,1 vs 0,2,0），与样式顺序无关。
    expect(editorCss).toContain('.context-room-tiptap-editor textarea:focus-visible')
    // 气泡工具条自身也钉一条（浮层 DOM 的挂载祖先不保证一定是编辑器根）。
    const bubbleBody = ruleBody(editorCss, '.context-room-tiptap-bubble input:focus-visible')
    expect(bubbleBody).toContain('outline: 0')
  })
})

describe('云文档选区评论词条', () => {
  const keys = [
    'tiptapBubbleToolbar.commentEntry',
    'tiptapBubbleToolbar.commentQueue',
    'tiptapBubbleToolbar.commentQueueFailed',
    'tiptapBubbleToolbar.commentQueuePlaceholder',
    'tiptapBubbleToolbar.commentQueued',
    'tiptapBubbleToolbar.commentQueuedHint',
  ] as const

  it('中英词条齐全且非空', () => {
    for (const key of keys) {
      expect(zhContextRoom[key as keyof typeof zhContextRoom]).toBeTruthy()
      expect(enContextRoom[key as keyof typeof enContextRoom]).toBeTruthy()
    }
  })
})

describe('选区批注浮层定位', () => {
  it('浮层内容换宽度（工具条 → 输入表单）后主动派发 updatePosition，避免 ↑/✕ 被右缘裁掉', () => {
    // floating-ui 只在选区 / 滚动 / 窗口 resize 时更新；表单比工具条宽，靠右选区
    // 打开时会按旧锚点向右溢出滚动容器。必须显式让插件重算位置（shift 收回可视区）。
    expect(bubbleToolbarSource).toContain("setMeta(bubbleMenuKey, 'updatePosition')")
    expect(bubbleToolbarSource).toContain('requestAnimationFrame')
    expect(bubbleToolbarSource).toContain('pluginKey={bubbleMenuKey}')
  })
})

describe('选区批注浮层不撑开正文滚动条', () => {
  it('浮层挂到编辑器根（滚动容器之外），不参与正文 scrollWidth，避免整页宽度抖动', () => {
    // 挂在滚动容器里时，绝对定位浮层靠右会撑出横向滚动条 → content 宽度变化 →
    // cqw 版心与 textarea 重排，表现为整个标签页宽度抖动。
    expect(bubbleToolbarSource).toContain('appendTo={appendTo}')
    expect(editorSource).toContain('ref={editorRootRef}')
    expect(editorSource).toContain('appendTo={() => editorRootRef.current ?? document.body}')
    // 移到容器外以后正文滚动不再带走浮层，需要自己监听滚动重算位置。
    expect(bubbleToolbarSource).toContain("closest('.context-room-tiptap-scroll')")
    expect(bubbleToolbarSource).toContain("addEventListener('scroll', onScroll")
  })
})
