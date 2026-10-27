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
const dialog = readFileSync(
  resolve(__dirname, '../src/renderer/src/components/context-room/ported/components/detail-panels/ThesisReformatDialog.tsx'),
  'utf8',
)
const preload = readFileSync(resolve(__dirname, '../src/preload/index.ts'), 'utf8')

describe('产物区排版工具接线', () => {
  it('三点菜单里有排版工具项，且只对 .docx 产物显示', () => {
    expect(pane).toContain("t('contextRoom:artifactLibrary.thesisTool')")
    expect(pane).toContain('office && /\\.docx$/i.test(office.originalName)')
  })

  it('对话框以选中产物的 fileId 为排版目标，并传 roomId', () => {
    expect(pane).toContain('<ThesisReformatDialog')
    expect(pane).toContain('roomId={room.id}')
    expect(pane).toContain('target={thesisTarget}')
    expect(pane).toContain('setThesisTarget({ fileId: office.fileId, name: resource.name })')
  })

  it('模版上传限定 Word，并透传 wordOnly 到 IPC', () => {
    expect(dialog).toContain('pickAndSet(roomId, { wordOnly: true })')
    expect(preload).toContain("invoke('thesis-format:parse:pick', roomId, options)")
  })

  it('导入模版后直接开排（贴合「导入即排版」的预期）', () => {
    expect(dialog).toContain('await reformat(meta.cardId)')
  })

  it('长任务期间禁止关闭，且阶段文案可见', () => {
    expect(dialog).toContain('if (!next && busy) return;')
    expect(dialog).toContain("t('contextRoom:thesisFormat.phaseParsing')")
    expect(dialog).toContain("t('contextRoom:thesisFormat.phaseReformatting')")
  })

  it('成功后排空产物清单缓存，让新文件立刻出现', () => {
    expect(dialog).toContain("window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))")
  })
})