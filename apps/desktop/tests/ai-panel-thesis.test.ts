import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Word 卡片 AI 面板里的排版工具接线（原产物区弹窗的功能全部搬到这里）。
 * genoffice 侧代码在子模块内，这里钉住对用户可见的关键行为，防止回退。
 */
const docsRoot = resolve(__dirname, '../vendor/genoffice/apps/docs')
const aiTab = readFileSync(resolve(docsRoot, 'src/renderer/components/AiTab.tsx'), 'utf8')
const preload = readFileSync(resolve(docsRoot, 'src/preload/index.ts'), 'utf8')
const docsMain = readFileSync(resolve(docsRoot, 'src/main/docs-main.ts'), 'utf8')
const ipc = readFileSync(resolve(docsRoot, 'src/shared/ipc.ts'), 'utf8')

describe('AI 面板排版工具', () => {
  it('上传模版成功后直接排版当前文档（导入即排版）', () => {
    expect(aiTab).toContain('if (meta.cardId && hasDoc) await reformatWith(meta.cardId, { mode })')
  })

  it('模版解析缺口在面板里显性提示，不静默', () => {
    expect(aiTab).toContain("setError(t('aiThesisPartial'")
  })

  it('排版完成后展示映射报告（守恒/未匹配/待复核）', () => {
    expect(aiTab).toContain('setReport({')
    expect(aiTab).toContain("t('aiThesisReport'")
    expect(aiTab).toContain("t('aiThesisReportUnmatched'")
    expect(aiTab).toContain("t('aiThesisReportReview'")
  })

  it('每个模版行只有一个删除按钮，且阻止冒泡（不触发选中排版）', () => {
    expect(aiTab).toContain('ai-thesis-card-del')
    expect(aiTab).toContain('event.stopPropagation()')
    expect(aiTab).toContain('event.preventDefault()')
    // 单一删除入口：不再有第二个「只删文件」按钮
    expect(aiTab).not.toContain('aiThesisDeleteFileTip')
    const dels = aiTab.match(/deleteTemplate\(row\.id/g) ?? []
    expect(dels).toHaveLength(1)
  })

  it('二次确认在面板内联完成，不用 window.confirm（否则会收起下拉）', () => {
    expect(aiTab).not.toContain('window.confirm(')
    expect(aiTab).toContain('ai-thesis-card-confirm')
    expect(aiTab).toContain("t('aiThesisDeleteConfirmInline')")
    expect(aiTab).toContain("t('aiThesisDeleteOk')")
    expect(aiTab).toContain("t('aiThesisDeleteCancel')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('确定要删除该模板文件吗？')
  })

  it('确认后调后端删除并立刻从列表移除该行', () => {
    expect(aiTab).toContain('await window.desktop.thesisDeleteTemplate(cardId, false)')
    expect(aiTab).toContain('setCards((prev) => (prev ? prev.filter((entry) => entry.id !== cardId) : prev))')
  })

  it('弹窗宽度随视口自适应，且不裁剪内容（裁剪会把右侧删除按钮藏掉）', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const panel = css.slice(css.indexOf('.ai-thesis-panel,'), css.indexOf('.ai-thesis-title {'))
    expect(panel).toContain('width: min(336px, calc(100vw - 24px))')
    expect(panel).toContain('max-width: 100%')
    expect(panel).toContain('box-sizing: border-box')
    // 绝不能在浮层/列表上用 overflow hidden 裁掉按钮
    expect(panel).toContain('overflow: visible')
    expect(panel).not.toContain('overflow-x: hidden')
    const cards = css.slice(css.indexOf('.ai-thesis-cards {'), css.indexOf('.ai-thesis-card {'))
    expect(cards).not.toContain('overflow-x: hidden')
    // 主区自己裁剪，长文件名不会顶飞按钮
    const main = css.slice(css.indexOf('.ai-thesis-card-main {'), css.indexOf('}', css.indexOf('.ai-thesis-card-main {')) + 1)
    expect(main).toContain('overflow: hidden')
    expect(main).toContain('min-width: 0')
  })

  it('卡片行 grid 布局：文件名列可收缩、按钮恒在右侧，确认条绝对覆盖不撑宽行', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const cardFrom = css.indexOf('.ai-thesis-card {')
    const card = css.slice(cardFrom, css.indexOf('}', cardFrom) + 1)
    expect(card).toContain('display: grid')
    expect(card).toContain('grid-template-columns: minmax(0, 1fr) auto auto')
    expect(card).toContain('position: relative')
    // 确认条必须绝对定位（此前无样式，作为行内子元素把整行撑宽 → 横向滚动条 + 内容被挤没）
    const cfFrom = css.indexOf('.ai-thesis-card-confirm {')
    const confirm = css.slice(cfFrom, css.indexOf('}', cfFrom) + 1)
    expect(confirm).toContain('position: absolute')
    expect(confirm).toContain('inset: 0')
    // 确认条内部：文本列可收缩省略，按钮不参与收缩
    const cfText = css.slice(css.indexOf('.ai-thesis-card-confirm-text {'), css.indexOf('}', css.indexOf('.ai-thesis-card-confirm-text {')) + 1)
    expect(cfText).toContain('min-width: 0')
    expect(cfText).toContain('overflow: hidden')
    for (const sel of ['.ai-thesis-card-confirm-cancel,', '.ai-thesis-card-confirm-ok {']) {
      const from = css.indexOf(sel)
      expect(css.slice(from, css.indexOf('}', from) + 1)).toContain('flex: 0 0 auto')
    }
    // 删除按钮钉在行尾
    const delFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del {')
    const del = css.slice(delFrom, css.indexOf('}', delFrom) + 1)
    expect(del).toContain('grid-column: -2 / -1')
    expect(del).toContain('justify-self: end')
  })

  it('删除按钮始终渲染（不依赖是否来自资料库）', () => {
    expect(aiTab).toContain('ai-thesis-card-act is-danger ai-thesis-card-del')
    // 不包在 sourceFileEntryId 条件里
    expect(aiTab).not.toContain('{row.sourceFileEntryId ? (')
  })

  it('删除按钮不被挤压且加大点击区（flex-shrink:0 / 28px / 16px 图标）', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const from = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del {')
    const del = css.slice(from, css.indexOf('}', from) + 1)
    expect(del).toContain('flex-shrink: 0')
    expect(del).toContain('width: 28px')
    expect(del).toContain('height: 28px')
    expect(del).toContain('padding: 0 6px')
    const iconFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del svg {')
    const icon = css.slice(iconFrom, css.indexOf('}', iconFrom) + 1)
    expect(icon).toContain('width: 16px')
    // 行内按钮组同样不压缩
    const actFrom = css.indexOf('.ai-thesis-card-act {')
    expect(css.slice(actFrom, css.indexOf('}', actFrom) + 1)).toContain('flex-shrink: 0')
  })

  it('删除按钮与其它行内按钮同尺寸，浅灰常态 hover 转红', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const selector = '.ai-thesis-card-act.ai-thesis-card-del {'
    const from = css.indexOf(selector)
    const block = css.slice(from, css.indexOf('}', from) + 1)
    expect(block).toContain('width: 28px')
    expect(block).toContain('color: var(--text-muted)')
    expect(block).not.toContain('position: absolute')
    // hover 变红在独立规则里
    const hoverFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del:hover')
    const hoverBlock = css.slice(hoverFrom, css.indexOf('}', hoverFrom) + 1)
    expect(hoverBlock).toContain('var(--danger)')
  })

  it('点删除只切换确认态，不直接删（可取消）', () => {
    expect(aiTab).toContain('setPendingDeleteId((current) => (current === row.id ? null : row.id))')
    expect(aiTab).toContain('setPendingDeleteId(null)')
  })

  it('IPC 与类型齐备：docs:thesis-delete-template + keepCard', () => {
    expect(preload).toContain("invoke('docs:thesis-delete-template', cardId, keepCard === true)")
    expect(docsMain).toContain("ipcMain.handle('docs:thesis-delete-template'")
    expect(docsMain).toContain("kind: 'delete-template'")
    expect(ipc).toContain('thesisDeleteTemplate(')
    expect(ipc).toContain('sourceFileEntryId?: string | null')
  })

  it('重名模版不直接覆盖：先弹「该论文模板已存在」，给替换/取消两个选项', () => {
    expect(aiTab).toContain('setPendingDuplicate({ name: meta.sourceName')
    expect(aiTab).toContain('ai-thesis-dup')
    expect(aiTab).toContain("t('aiThesisDuplicateTitle')")
    expect(aiTab).toContain("t('aiThesisDuplicateReplace')")
    expect(aiTab).toContain("t('aiThesisDuplicateCancel')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('该论文模板已存在')
    expect(zh).toContain('替换原文件')
    expect(zh).toContain('取消上传')
    // 确认替换后带 overwrite 复用主进程暂存的文件，不再弹选择框
    expect(aiTab).toContain('void uploadTemplate(true)')
    // 提示框在面板内完成，不使用 window.confirm（会收起下拉）
    expect(aiTab).not.toContain('window.confirm(')
  })

  it('宿主侧同名判定：大小写/空白不敏感，替换直接解析暂存文件', () => {
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toContain('pendingTemplatePick')
    expect(main).toContain("card.sourceName.trim().toLowerCase() === sourceName.trim().toLowerCase()")
    // overwrite 路径：删掉暂存后立刻解析，不再弹选择框
    expect(main).toContain('if (options?.overwrite) {')
  })

  it('排版走任务化：提交作业 + 轮询进度 + 10 分钟硬超时', () => {
    expect(aiTab).toContain('thesisReformatJob')
    expect(aiTab).toContain('thesisReformatJobStatus')
    expect(aiTab).toContain('TIMEOUT_MS = 10 * 60 * 1000')
    expect(aiTab).toContain('aiThesisTimeout')
    expect(aiTab).toContain('ai-thesis-progress')
    // 阶段文案
    expect(aiTab).toContain("t('aiThesisPhaseParsing')")
    expect(aiTab).toContain("t('aiThesisPhaseMapping')")
    expect(aiTab).toContain("t('aiThesisPhaseRendering')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('处理超时（已等 10 分钟）')
    // 不再使用同步长请求路径
    expect(aiTab).not.toContain('await window.desktop.thesisReformat(cardId)')
  })

  it('目录融合模式可选：严格（按模板目录筛选）/ 融合（全部保留）', () => {
    expect(aiTab).toContain("useState<'strict' | 'blend'>('blend')")
    expect(aiTab).toContain('aiThesisModeStrict')
    expect(aiTab).toContain('aiThesisModeBlend')
    // 模式随排版请求透传
    expect(aiTab).toContain('reformatWith(row.id, { mode })')
    expect(aiTab).toContain('reformatWith(meta.cardId, { mode })'); // 上传后自动排版
  })

  it('删除结果如实反馈：文件没删掉要提示而不是假装成功', () => {
    expect(aiTab).toContain("setError(t('aiThesisDeleteFileFailed'))")
  })
})

describe('删除模版文件「删干净」的底层保证', () => {
  it('网关删文件时级联清 Room 成员引用（否则列表残留）', () => {
    const service = readFileSync(resolve(__dirname, '../../gateway/src/modules/files/service.ts'), 'utf8')
    const matches = service.match(/delete\(roomSourceMemberships\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2) // deleteCatalogEntry + deleteFile 两条路径
    expect(service).toContain('sourceKind, "file"')
  })
})
