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
    expect(aiTab).toContain('if (meta.cardId && hasDoc) await reformatWith(meta.cardId)')
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
    const dels = aiTab.match(/deleteTemplate\(row\.id, row\.sourceName/g) ?? []
    expect(dels).toHaveLength(1)
  })

  it('二次确认文案是「确定要删除该模板文件吗？」', () => {
    expect(aiTab).toContain("window.confirm(t('aiThesisDeleteConfirm'")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('确定要删除该模板文件吗？')
  })

  it('确认后调后端删除并立刻从列表移除该行', () => {
    expect(aiTab).toContain('await window.desktop.thesisDeleteTemplate(cardId, false)')
    expect(aiTab).toContain('setCards((prev) => (prev ? prev.filter((entry) => entry.id !== cardId) : prev))')
  })

  it('删除按钮小巧、浅灰常态 hover 转红', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const block = css.slice(css.indexOf('.ai-thesis-card-act.ai-thesis-card-del {'))
    expect(block).toContain('width: 20px')
    expect(block).toContain('color: var(--text-muted)')
    expect(block).toContain('color: var(--danger)')
    expect(block).toContain('position: absolute')
  })

  it('IPC 与类型齐备：docs:thesis-delete-template + keepCard', () => {
    expect(preload).toContain("invoke('docs:thesis-delete-template', cardId, keepCard === true)")
    expect(docsMain).toContain("ipcMain.handle('docs:thesis-delete-template'")
    expect(docsMain).toContain("kind: 'delete-template'")
    expect(ipc).toContain('thesisDeleteTemplate(')
    expect(ipc).toContain('sourceFileEntryId?: string | null')
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
