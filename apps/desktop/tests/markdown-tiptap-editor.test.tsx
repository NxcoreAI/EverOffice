// @vitest-environment happy-dom
/**
 * 侧栏 Markdown Tiptap 编辑器（office-proto/MarkdownTiptapEditor.tsx）回归。
 *
 * 覆盖：真实 .md 文件读取 → Tiptap 挂载 → 标题文本渲染；初始加载不触发保存；
 * 编辑后 800ms 自动保存（保存内容保留 YAML frontmatter、写入 fileId/originalName/
 * workspaceId）；Cmd+S 立即保存；加载失败可重试；保存失败显示重试并可恢复。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { Editor as TiptapEditor } from '@tiptap/react'

import {
  clearPendingMarkdownFor,
  createMarkdownEditorExtensions,
  MarkdownTiptapEditor,
  pendingMarkdownFor,
} from '../src/renderer/src/office-proto/MarkdownTiptapEditor'
import { EditorView } from '../src/renderer/src/office-proto/EditorView'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'
import type { FileCatalogDto } from '../src/shared/ingest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILE_ID = 'file-md-1'
const FRONTMATTER = '---\ntitle: 产品调研笔记\ntags: [调研, 连接器]\n---\n'
const BODY = '# 产品调研笔记\n\n三条链路并存的现状已经确认。\n\n- [ ] 映射表三处同值收口\n'

function fakeCatalog(overrides: Partial<FileCatalogDto> = {}): FileCatalogDto {
  return {
    id: FILE_ID,
    originalName: '产品调研笔记.md',
    displayName: null,
    sharedTitle: '产品调研笔记',
    sourceKind: 'manual-upload',
    sourceLabel: '本地导入',
    relativePath: null,
    provider: null,
    bytes: 1024,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: 'hash-1',
    currentVersionId: 'version-1',
    parsed: false,
    workspaceId: 'ws-1',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  }
}

function fakeFile(overrides: Partial<FileCatalogDto> = {}): OfficeFile {
  const catalog = fakeCatalog(overrides)
  return {
    id: `real:${catalog.id}`,
    name: catalog.originalName,
    kind: 'md',
    roomId: null,
    updatedLabel: '刚刚',
    sizeLabel: '1 KB',
    content: { type: 'md', source: '' },
    realCatalog: catalog,
  }
}

let container: HTMLDivElement
let root: Root
const onToast = vi.fn()
let readText: ReturnType<typeof vi.fn>
let saveMarkdown: ReturnType<typeof vi.fn>
let savedNxcore: unknown

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
  })
  // 编辑器在 effect 里创建；再空转一轮让 useSyncExternalStore 的重渲染落地。
  await act(async () => {})
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  readText = vi.fn().mockResolvedValue({ text: `${FRONTMATTER}${BODY}` })
  saveMarkdown = vi.fn().mockResolvedValue({
    fileEntryId: FILE_ID,
    fileVersionId: 'version-2',
    contentHash: 'hash-2',
    originalName: '产品调研笔记.md',
  })
  savedNxcore = (window as unknown as { nxcore?: unknown }).nxcore
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    files: { readText, saveMarkdown },
  }
  onToast.mockClear()
})

afterEach(async () => {
  clearPendingMarkdownFor(FILE_ID)
  await act(async () => { root.unmount() })
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  ;(window as unknown as { nxcore?: unknown }).nxcore = savedNxcore
})

describe('MarkdownTiptapEditor', () => {
  it('读取真实 .md 文本并用 Tiptap 渲染；初始加载不触发保存', async () => {
    await render(<MarkdownTiptapEditor file={fakeFile()} onToast={onToast} />)

    expect(readText).toHaveBeenCalledWith(FILE_ID)
    expect(container.querySelector('.wb-md-tiptap-content')).not.toBeNull()
    expect(text('.wb-md-tiptap-content')).toContain('产品调研笔记')
    expect(text('.wb-md-tiptap-content')).toContain('三条链路并存的现状已经确认')
    expect(container.querySelector('.wb-md-tiptap-content h1')).not.toBeNull()

    await advance(1_000)
    expect(saveMarkdown).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('编辑后 800ms 自动保存；保存内容保留 frontmatter，并带上 catalog 元信息', async () => {
    let editor: Editor | null = null
    await render(
      <MarkdownTiptapEditor
        file={fakeFile()}
        onToast={onToast}
        onEditorReady={(instance) => { editor = instance }}
      />,
    )
    expect(editor).not.toBeNull()

    // 通过编辑器命令改正文（等价于用户输入，会触发 onUpdate）。
    await act(async () => {
      (editor as unknown as Editor).commands.setContent('# 标题\n\n追加段落：今天是周一。\n', {
        contentType: 'markdown',
        emitUpdate: true,
      })
    })
    expect(saveMarkdown).not.toHaveBeenCalled()
    expect(text('.wb-md-status')).toContain('未保存')

    await advance(1_000)

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    const payload = saveMarkdown.mock.calls[0][0] as {
      fileId: string
      markdown: string
      originalName: string
      workspaceId: string
    }
    expect(payload.fileId).toBe(FILE_ID)
    expect(payload.originalName).toBe('产品调研笔记.md')
    expect(payload.workspaceId).toBe('ws-1')
    expect(payload.markdown).toContain('追加段落：今天是周一')
    expect(payload.markdown.startsWith('---\ntitle: 产品调研笔记\ntags: [调研, 连接器]\n---\n')).toBe(true)
    expect(text('.wb-md-status')).toContain('已保存')
  })

  it('Cmd+S 立即保存，不再等 800ms 抖动', async () => {
    let editor: Editor | null = null
    await render(
      <MarkdownTiptapEditor
        file={fakeFile()}
        onToast={onToast}
        onEditorReady={(instance) => { editor = instance }}
      />,
    )
    const instance = editor as unknown as Editor
    await act(async () => {
      instance.commands.setContent('# 标题\n\n快捷键保存的内容\n', {
        contentType: 'markdown',
        emitUpdate: true,
      })
    })
    expect(saveMarkdown).not.toHaveBeenCalled()

    await act(async () => {
      instance.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }),
      )
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    expect((saveMarkdown.mock.calls[0][0] as { markdown: string }).markdown).toContain('快捷键保存的内容')
    expect(text('.wb-md-status')).toContain('已保存')

    await advance(1_000)
    expect(saveMarkdown).toHaveBeenCalledTimes(1)
  })

  it('切走未落盘就重开时恢复内存里的最新内容，不读服务端旧版本', async () => {
    // 保存一直悬着：模拟「卸载时保存还没回来、用户马上重开」的竞态。
    saveMarkdown.mockReturnValue(new Promise(() => {}))
    let editor: Editor | null = null
    const element = (
      <MarkdownTiptapEditor
        file={fakeFile()}
        onToast={onToast}
        onEditorReady={(instance) => { editor = instance }}
      />
    )
    await render(element)
    await act(async () => {
      (editor as unknown as Editor).commands.setContent('# 标题\n\n重开前刚写的内容\n', {
        contentType: 'markdown',
        emitUpdate: true,
      })
    })
    expect(pendingMarkdownFor(FILE_ID)).toContain('重开前刚写的内容')

    // 不推进 800ms 抖动就切走（卸载只做 fire-and-forget flush）。
    await act(async () => { root.unmount() })
    expect(readText).toHaveBeenCalledTimes(1)

    root = createRoot(container)
    await render(element)

    // 第二次打开走内存缓存：服务端此刻仍是旧版本也不影响。
    expect(readText).toHaveBeenCalledTimes(1)
    expect(text('.wb-md-tiptap-content')).toContain('重开前刚写的内容')
  })

  it('读取失败显示内联错误 + 重试，重试成功后进入编辑态（onToast 只弹一次）', async () => {
    readText.mockRejectedValueOnce(new Error('IPC 读取失败'))
    await render(<MarkdownTiptapEditor file={fakeFile()} onToast={onToast} />)

    expect(text('.wb-md-state.is-error')).toContain('Markdown 加载失败')
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.wb-md-tiptap-content')).toBeNull()

    readText.mockResolvedValueOnce({ text: `${FRONTMATTER}${BODY}` })
    const retryButton = container.querySelector<HTMLButtonElement>('.wb-md-state-action')
    expect(retryButton).not.toBeNull()
    await act(async () => { retryButton!.click() })
    await act(async () => {})

    expect(readText).toHaveBeenCalledTimes(2)
    expect(text('.wb-md-tiptap-content')).toContain('产品调研笔记')
    // 同一挂载周期内不重复 toast。
    expect(onToast).toHaveBeenCalledTimes(1)
  })

  it('保存失败显示「保存失败 + 重试」，点重试后恢复已保存', async () => {
    let editor: Editor | null = null
    saveMarkdown.mockRejectedValueOnce(new Error('write failed'))
    await render(
      <MarkdownTiptapEditor
        file={fakeFile()}
        onToast={onToast}
        onEditorReady={(instance) => { editor = instance }}
      />,
    )
    const instance = editor as unknown as Editor
    await act(async () => {
      instance.commands.setContent('# 标题\n\n失败后重试的正文\n', {
        contentType: 'markdown',
        emitUpdate: true,
      })
    })
    await advance(1_000)

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    expect(text('.wb-md-status')).toContain('保存失败')
    const retryButton = container.querySelector<HTMLButtonElement>('.wb-md-status-retry')
    expect(retryButton).not.toBeNull()
    await act(async () => { retryButton!.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(saveMarkdown).toHaveBeenCalledTimes(2)
    expect(text('.wb-md-status')).toContain('已保存')
  })

  it('缺少 realCatalog 时给出不可用提示，不读取文件', async () => {
    const noCatalog: OfficeFile = {
      id: 'mock-md',
      name: 'mock.md',
      kind: 'md',
      roomId: null,
      updatedLabel: '刚刚',
      sizeLabel: '—',
      content: { type: 'md', source: '# mock' },
    }
    await render(<MarkdownTiptapEditor file={noCatalog} onToast={onToast} />)
    expect(text('.wb-md-state')).toContain('无法在侧栏编辑')
    expect(readText).not.toHaveBeenCalled()
  })
})

describe('EditorView 路由', () => {
  it('真实 .md 文件改走 Tiptap 编辑器而不是 GenOffice 原生预览', async () => {
    await render(<EditorView file={fakeFile()} onToast={onToast} hideSideDock />)

    expect(readText).toHaveBeenCalledWith(FILE_ID)
    expect(container.querySelector('.wb-md-tiptap-content')).not.toBeNull()
    expect(container.querySelector('.op-native-col')).toBeNull()
    expect(text('.wb-md-tiptap-content')).toContain('产品调研笔记')
  })
})

describe('Markdown 往返保真', () => {
  it('保留表格与图片（未注册节点时 markdown 解析会整段丢弃）', () => {
    // 没有 TableKit / Image 时：表格被整段丢掉、图片只剩 alt 文本，用户改一个字
    // 再保存就把原文件改坏。这里锁住「解析 → 序列化」的保真行为。
    const markdown = [
      '# 标题',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '![图](https://example.com/img.png)',
      '',
    ].join('\n')
    const editor = new TiptapEditor({
      extensions: createMarkdownEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
      immediatelyRender: false,
    })
    try {
      const serialized = editor.getMarkdown()
      expect(serialized).toContain('| 列 A |')
      expect(serialized).toContain('| 1')
      expect(serialized).toContain('![图](https://example.com/img.png)')
    } finally {
      editor.destroy()
    }
  })
})
