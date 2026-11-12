// @vitest-environment happy-dom
/**
 * 侧栏 Markdown 文件 → 旧文稿编辑器宿主（`office-proto/SidebarDocumentEditor.tsx`）
 * 回归。
 *
 * 覆盖：
 * 1) 真实 .md 文件读取 → 旧文稿编辑器（Tiptap cloud-document）挂载 → 正文渲染；
 * 2) 初始加载不触发保存（不是「打开即写」）；
 * 3) 保存桥：注册给旧编辑器的 `documentsApi().save` 落成 `files.saveMarkdown`
 *    （frontmatter 保留、同一 fileEntry），标题改动 best-effort rename，版本自增；
 * 4) 已下线的文稿后端能力按降级矩阵返回空结果 / 明确拒绝（评论、版本、速览、
 *    文稿操作、外部导出），不会在挂载期抛未处理 rejection；
 * 5) 卸载后注销 shim，不给下一个文件留脏全局。
 *
 * 注：本仓库没有 @testing-library/react，统一用 react-dom/client + act +
 * 原生 DOM 断言（与 tests/agent-answer-details.test.tsx 同款）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import {
  documentsApi,
  externalDocumentsApi,
  registerDocumentsApi,
  registerExternalDocumentsApi,
} from '../src/renderer/src/components/office-editor/documentApi'
import {
  removeDocumentDraft,
  writeDocumentDraft,
} from '../src/renderer/src/components/office-editor/editor/documentDraftStorage'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'
import { EditorView } from '../src/renderer/src/office-proto/EditorView'
import { SidebarDocumentEditor } from '../src/renderer/src/office-proto/SidebarDocumentEditor'
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
let root: Root | null = null
const onToast = vi.fn()
let readText: ReturnType<typeof vi.fn>
let saveMarkdown: ReturnType<typeof vi.fn>
let rename: ReturnType<typeof vi.fn>
let savedNxcore: unknown

/** 真实计时器下多空转几轮：编辑器在 effect 里创建、随后触发一次重渲染。 */
async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0)
      })
    })
  }
}

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element)
  })
  await settle()
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

beforeEach(() => {
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
  rename = vi.fn().mockResolvedValue(fakeCatalog())
  savedNxcore = (window as unknown as { nxcore?: unknown }).nxcore
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    files: { readText, saveMarkdown, rename },
  }
  onToast.mockClear()
  removeDocumentDraft(FILE_ID)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  // 兜底清理：避免某个用例失败时把 shim 留给下一个用例。
  registerDocumentsApi(null)
  registerExternalDocumentsApi(null)
  container.remove()
  ;(window as unknown as { nxcore?: unknown }).nxcore = savedNxcore
})

describe('SidebarDocumentEditor', () => {
  it('读取真实 .md 文本并挂载旧文稿编辑器；初始加载不触发保存', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    expect(readText).toHaveBeenCalledWith(FILE_ID)
    const surface = container.querySelector('.context-room-tiptap-content')
    expect(surface).not.toBeNull()
    expect(surface?.textContent).toContain('产品调研笔记')
    expect(surface?.textContent).toContain('三条链路并存的现状已经确认')

    // 打开不应自动写盘：保存只发生在用户编辑后的 300ms 防抖。
    expect(saveMarkdown).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('重开文件时恢复卸载前只落在本地草稿里的编辑（版本与草稿基准对齐）', async () => {
    const draftContent: TiptapJsonContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '卸载前没来得及落盘的草稿内容' }],
      }],
    }
    // 旧编辑器每次编辑都会写这份 localStorage 草稿；模拟「切走 < 300ms、
    // fire-and-forget 保存因目标文件不一致被拒绝」后重开同一个文件。
    writeDocumentDraft(FILE_ID, draftContent, 3, '草稿标题')

    await render(<EditorView file={fakeFile()} onToast={onToast} hideSideDock />)

    expect(text('.context-room-tiptap-content')).toContain('卸载前没来得及落盘的草稿内容')
  })

  it('EditorView 把真实 .md 路由到旧文稿编辑器（不再走 GenOffice 原生预览）', async () => {
    await render(<EditorView file={fakeFile()} onToast={onToast} hideSideDock />)

    expect(readText).toHaveBeenCalledWith(FILE_ID)
    expect(container.querySelector('.context-room-tiptap-content')).not.toBeNull()
    expect(container.querySelector('.op-native-col')).toBeNull()
    expect(text('.context-room-tiptap-content')).toContain('产品调研笔记')
  })

  it('保存桥：documentsApi().save → files.saveMarkdown（frontmatter 保留 + 版本自增 + 标题改名）', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    const api = documentsApi()
    expect(api).toBeTruthy()

    const contentJson: TiptapJsonContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '这里是刚刚改好的正文。' }],
      }],
    }
    let saved: RoomDocument | null = null
    await act(async () => {
      saved = await api!.save(FILE_ID, { baseVersion: 1, title: '新标题', contentJson })
    })

    expect(saved).not.toBeNull()
    expect(saved!.version).toBe(2)
    expect(saved!.title).toBe('新标题')
    expect(saved!.id).toBe(FILE_ID)
    expect(saved!.roomId).toBeNull()

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    const payload = saveMarkdown.mock.calls[0]?.[0] as {
      fileId: string
      markdown: string
      originalName: string
      workspaceId: string
    }
    expect(payload.fileId).toBe(FILE_ID)
    expect(payload.originalName).toBe('产品调研笔记.md')
    expect(payload.workspaceId).toBe('ws-1')
    // frontmatter 逐字节保留；正文由 Tiptap JSON 序列化而来；原文件以换行结尾，
    // 保存后保留这个习惯。
    expect(payload.markdown.startsWith(FRONTMATTER)).toBe(true)
    expect(payload.markdown).toContain('这里是刚刚改好的正文。')
    expect(payload.markdown.endsWith('\n')).toBe(true)

    expect(rename).toHaveBeenCalledWith(FILE_ID, '新标题')
  })

  it('旧编辑器改名保存走完整链路：标题 blur → documents.save → saveMarkdown + rename', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    const titleInput = container.querySelector<HTMLTextAreaElement>(
      '.context-room-document-title-input',
    )
    expect(titleInput).not.toBeNull()

    // 标题输入框是受控 textarea：用原生 setter + input 事件模拟输入，再触发
    // blur（旧编辑器的 onBlur 会以 0ms 防抖把当前正文 + 新标题送去保存）。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(titleInput, '重命名后的标题')
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(titleInput!.value).toBe('重命名后的标题')
    await act(async () => {
      // React 的 onBlur 走 focusout 代理（blur 不冒泡）。
      titleInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 50)
      })
    })
    await settle(2)

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith(FILE_ID, '重命名后的标题')
    const saved = await documentsApi()!.get(FILE_ID)
    expect(saved.version).toBe(2)
    expect(saved.title).toBe('重命名后的标题')
  })

  it('切文件安全闸：documentId 与当前文件不一致的保存被拒绝，不会写错 fileEntry', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    const api = documentsApi()
    const contentJson: TiptapJsonContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '属于别的文件的内容。' }] }],
    }
    await act(async () => {
      await expect(api!.save('file-md-other', { baseVersion: 1, contentJson }))
        .rejects.toThrow(/不一致/)
    })

    expect(saveMarkdown).not.toHaveBeenCalled()
  })

  it('标题没改时不调用 rename（正文照常保存）', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    const api = documentsApi()
    const contentJson: TiptapJsonContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '只改正文。' }] }],
    }
    await act(async () => {
      await api!.save(FILE_ID, { baseVersion: 1, title: '产品调研笔记', contentJson })
    })

    expect(saveMarkdown).toHaveBeenCalledTimes(1)
    expect(rename).not.toHaveBeenCalled()
  })

  it('已下线文稿后端的读能力返回空结果、写能力明确拒绝（挂载期不刷错误）', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    const api = documentsApi()
    const external = externalDocumentsApi()
    expect(api).toBeTruthy()
    expect(external).toBeTruthy()

    // 速览：返回「不可生成」态，旧编辑器的 useDocumentOverview 就不会在挂载时
    // 自动触发生成（否则每次打开都弹一次生成失败）。
    const overview = await api!.getOverview(FILE_ID)
    expect(overview.eligible).toBe(false)
    expect(overview.aiAvailable).toBe(false)
    expect(overview.topic).toBeNull()

    expect(await api!.listDocumentComments(FILE_ID)).toEqual({ items: [] })
    expect(await api!.listVersions(FILE_ID)).toEqual([])
    expect(await api!.listOperations({ documentId: FILE_ID })).toEqual([])
    expect(await api!.resolveBlockReferences({ references: [] })).toEqual({ resolutions: [] })

    // 导出状态条每 2.5s 轮询 listExports：必须 resolve 空列表，不能 reject。
    expect(await external!.listExports(FILE_ID)).toEqual({ items: [] })
    expect(await external!.importHistory(FILE_ID)).toEqual({
      entries: [],
      commentDiff: null,
      comments: [],
    })

    await expect(api!.generateOverview(FILE_ID)).rejects.toThrow(/速览生成不可用/)
    await expect(api!.startOperation({} as never)).rejects.toThrow(/暂不支持 Agent 文稿操作/)
    await expect(external!.createExport({} as never)).rejects.toThrow(/暂不支持外部文档导入\/导出/)
  })

  it('卸载后注销 shim（不把文件库实现留给下一个文件）', async () => {
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)
    expect(documentsApi()).toBeTruthy()

    await act(async () => {
      root?.unmount()
      await Promise.resolve()
    })
    root = null

    // 测试环境没有 window.nxcore.documents，注销后应回到「未注册」。
    expect(documentsApi()).toBeUndefined()
    expect(externalDocumentsApi()).toBeUndefined()
  })

  it('读取失败显示错误 + 重试；重试成功后进入编辑态（toast 只弹一次）', async () => {
    readText.mockRejectedValueOnce(new Error('IPC 读取失败'))
    await render(<SidebarDocumentEditor file={fakeFile()} onToast={onToast} />)

    expect(text('[data-state="error"] .sidebar-doc-editor-state')).toContain('Markdown 加载失败')
    expect(container.querySelector('.context-room-tiptap-content')).toBeNull()
    expect(onToast).toHaveBeenCalledTimes(1)

    readText.mockResolvedValueOnce({ text: `${FRONTMATTER}${BODY}` })
    const retryButton = container.querySelector<HTMLButtonElement>('.sidebar-doc-editor-state-action')
    expect(retryButton).not.toBeNull()
    await act(async () => { retryButton!.click() })
    await settle()

    expect(readText).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.context-room-tiptap-content')).not.toBeNull()
    expect(onToast).toHaveBeenCalledTimes(1)
  })
})