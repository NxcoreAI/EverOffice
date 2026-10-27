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

  it('删除模版有两种：连卡删干净 / 只删文件保留格式卡', () => {
    expect(aiTab).toContain('deleteTemplate(row.id, row.sourceName, true)')
    expect(aiTab).toContain('deleteTemplate(row.id, row.sourceName, false)')
    expect(aiTab).toContain('window.confirm(')
    // 只删文件的按钮仅在模版来自资料区时出现
    expect(aiTab).toContain('{row.sourceFileEntryId ? (')
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
