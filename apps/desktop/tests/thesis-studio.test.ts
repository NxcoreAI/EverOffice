import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 智能排版工作台（第一期：设计系统 + 外壳 + 拖拽上传 + 列表 + 大纲抽屉）。
 * 组件行为靠人工验收，这里钉住最容易回退的结构性约定。
 */
const studio = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/thesis-studio/ThesisStudio.tsx'),
  'utf8',
)
const css = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/thesis-studio/thesis-studio.css'),
  'utf8',
)
const page = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/context-room/ContextRoomPage.tsx'),
  'utf8',
)

describe('智能排版工作台 · 外壳与入口', () => {
  it('Room 页有入口按钮，点击打开工作台', () => {
    expect(page).toContain('thesis-studio-launcher')
    expect(page).toContain('<ThesisStudio roomId={activeRoomId}')
    expect(page).toContain('智能排版')
  })

  it('三栏：模版库 / 待排版文档 / 规则与进度', () => {
    expect(studio).toContain('ts-col-templates')
    expect(studio).toContain('ts-col-docs')
    expect(studio).toContain('ts-col-rules')
  })
})

describe('智能排版工作台 · 视觉规范', () => {
  it('indigo 主色 + 柔和红危险色 + 深浅色主题变量', () => {
    expect(css).toContain('--ts-primary: #6366f1')
    expect(css).toContain('--ts-danger: #ef4444')
    expect(css).toContain(".thesis-studio[data-theme='dark']")
    expect(studio).toContain("data-theme={dark ? 'dark' : 'light'}")
    expect(studio).toContain("localStorage.getItem('thesis-studio:dark')")
  })

  it('拖拽高亮、卡片悬浮上浮、骨架屏（不是干瘪转圈）', () => {
    expect(css).toContain(".ts-dropzone[data-dragging]")
    expect(css).toContain('.ts-card:hover')
    expect(css).toContain('translateY(-1px)')
    expect(css).toContain('ts-shimmer')
    expect(studio).toContain('ts-skeleton')
  })
})

describe('智能排版工作台 · 功能要点', () => {
  it('拖拽上传只收 docx，字节直传解析（不落盘）', () => {
    expect(studio).toContain('/\\.docx$/i.test(file.name)')
    expect(studio).toContain('api.parseUpload(roomId, file.name, bytes)')
  })

  it('模版缺口显性提示、失败走人话翻译', () => {
    expect(studio).toContain('模版部分内容未解析')
    expect(studio).toContain('describeThesisError')
  })

  it('删除模版为行内确认，删除的是文件+卡', () => {
    expect(studio).toContain('ts-confirm')
    expect(studio).toContain('确定要删除该模板文件吗？')
    expect(studio).toContain('api.deleteTemplate(roomId, cardId)')
  })

  it('大纲预览抽屉展示槽位骨架', () => {
    expect(studio).toContain('ts-drawer')
    expect(studio).toContain('slotOutlineOf')
    expect(studio).toContain('模版章节骨架（槽位）')
  })

  it('四阶段进度 + 结果下载/重新排版', () => {
    expect(studio).toContain("label: '解析模板结构'")
    expect(studio).toContain("label: '映射内容段落'")
    expect(studio).toContain("label: '渲染样式'")
    expect(studio).toContain('下载 Word')
    expect(studio).toContain('重新排版')
  })

  it('规则面板接后端：模式/固定元素/标题映射全部下发', () => {
    expect(studio).toContain('headingMapping: headingMap')
    expect(studio).toContain('keepLogo')
    expect(studio).toContain('keepHeaderFooter')
    expect(studio).toContain("mode,")
    // 标题层级映射三档选择器
    expect(studio).toContain('ts-select-row')
    expect(studio).toContain('模板一级标题')
    // 不再声称"待后端接入"
    expect(studio).not.toContain('待后端接入后生效')
  })
})
