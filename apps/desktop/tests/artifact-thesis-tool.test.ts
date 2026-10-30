import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 产物区「排版工具」入口的静态契约（组件级交互受 Radix 菜单 + IPC 约束，
 * 这里只钉住最容易改坏、且用户直接可见的接线：菜单项存在、只对 docx 放行、
 * 对话框拿到 roomId/fileId、IPC 选项透传到主进程）。
 */
const pane = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/context-room/ported/components/detail-panels/ArtifactLibraryPane.tsx'),
  'utf8',
)
const preload = readFileSync(resolve(__dirname, '../src/preload/index.ts'), 'utf8')

describe('排版入口已迁到 Word 卡片的 AI 面板（产物区菜单移除）', () => {
  it('产物区三点菜单不再有排版工具项，也不再挂弹窗', () => {
    expect(pane).not.toContain("t('contextRoom:artifactLibrary.thesisTool')")
    expect(pane).not.toContain('<ThesisReformatDialog')
    expect(pane).not.toContain('thesisTarget')
  })

  it('模版直传仍支持 wordOnly（AI 面板上传走同一 IPC）', () => {
    expect(preload).toContain("invoke('thesis-format:parse:pick', roomId, options)")
  })

  it('彻底删除模版的 IPC 存在，且先删文件再删卡', () => {
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toContain("deleteTemplate: 'thesis-format:template:delete'")
    const handlerIndex = main.indexOf('THESIS_FORMAT_CHANNELS.deleteTemplate')
    expect(handlerIndex).toBeGreaterThan(0)
    // 先 files.delete(模版文件) 再 removeCard
    expect(main.indexOf('files.delete(card.sourceFileEntryId)')).toBeLessThan(main.indexOf('bridge.removeCard(roomId, cardId)', handlerIndex))
  })
})
