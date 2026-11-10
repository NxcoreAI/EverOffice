// @vitest-environment happy-dom
/**
 * 工作空间「云文档」入口 + 真实 documents 后端编辑器回归。
 *
 * 覆盖：
 * 1) 气泡窗浏览态顶部「云文档」分组：`documents.list(null)` 拉取、标题/更新时间展示、
 *    空态文案、点击 → 伪 OfficeFile（cloudDocument 标记）交给 onOpenFile；
 * 2) 事件刷新：工作区文稿事件（document.changed）增量合并进列表；onReady 重拉快照；
 * 3) 纯函数：RoomDocument → 伪文件转换、事件 → 清单合并（version 取大、删除摘除、
 *    moved 要求重拉）；
 * 4) `EditorView` 按 cloudDocument 路由到 `CloudDocumentEditor`，旧 Tiptap 编辑器挂载
 *    真实云文档正文；
 * 5) 关键回归：云文档编辑器渲染期同步清掉侧栏 Markdown 文件编辑器的「文件库支撑」
 *    shim，`documentsApi()` 必须是真实（mock 的）documents 桥，保存走 `documents.save`，
 *    绝不落到文件库 `files.saveMarkdown`。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WORKSPACE_DOCUMENT_CHANNEL,
  type DocumentEvent,
  type DocumentOverviewView,
  type RoomDocument,
  type TiptapJsonContent,
} from '@nxcore/agent-contract'

import {
  documentsApi,
  registerDocumentsApi,
  registerExternalDocumentsApi,
} from '../src/renderer/src/components/office-editor/documentApi'
import { removeDocumentDraft } from '../src/renderer/src/components/office-editor/editor/documentDraftStorage'
import {
  cloudDocumentTitle,
  cloudDocumentToOfficeFile,
  type OfficeFile,
} from '../src/renderer/src/office-proto/data'
import { EditorView } from '../src/renderer/src/office-proto/EditorView'
import { BubbleWindow } from '../src/renderer/src/workbench/workspace/BubbleWindow'
import type { BubbleState } from '../src/renderer/src/workbench/workspace/useBubble'
import { reduceCloudDocumentEvent } from '../src/renderer/src/workbench/workspace/useCloudDocuments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DOC_ID = 'doc-cloud-1'

function documentBody(text: string): TiptapJsonContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function roomDocument(overrides: Partial<RoomDocument> = {}): RoomDocument {
  return {
    id: DOC_ID,
    roomId: null,
    title: 'Agent 写的云文档',
    contentJson: documentBody('云文档正文第一段'),
    contentSchemaVersion: 1,
    version: 3,
    status: 'active',
    origin: 'native',
    activeTransactionId: null,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...overrides,
  }
}

function emptyOverview(documentId: string): DocumentOverviewView {
  return {
    documentId,
    topic: null,
    points: [],
    conclusion: null,
    generatedAtVersion: null,
    generatedAt: null,
    eligible: false,
    reason: 'empty',
    aiAvailable: false,
  }
}

/** 真实 documents 桥（恢复后 preload 的形状）的最小 mock；测试按调用断言。 */
function documentsBridge(seed: RoomDocument) {
  const events: Array<(frame: { type: 'document.event'; protocol: 1; event: DocumentEvent }) => void> = []
  const readies: Array<(roomId: string) => void> = []
  const bridge = {
    list: vi.fn().mockResolvedValue([seed]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((listener: (frame: { type: 'document.event'; protocol: 1; event: DocumentEvent }) => void) => {
      events.push(listener)
      return () => {
        const index = events.indexOf(listener)
        if (index >= 0) events.splice(index, 1)
      }
    }),
    onReady: vi.fn((listener: (roomId: string) => void) => {
      readies.push(listener)
      return () => {
        const index = readies.indexOf(listener)
        if (index >= 0) readies.splice(index, 1)
      }
    }),
    get: vi.fn().mockResolvedValue(seed),
    save: vi.fn(async (documentId: string, input: {
      baseVersion: number
      title?: string
      contentJson: TiptapJsonContent
    }) => ({
      ...seed,
      id: documentId,
      title: input.title ?? seed.title,
      contentJson: input.contentJson,
      version: input.baseVersion + 1,
      updatedAt: '2026-11-10T10:00:00.000Z',
    })),
    listOperations: vi.fn().mockResolvedValue([]),
    startOperation: vi.fn(),
    getOperation: vi.fn(),
    executeOperationCommand: vi.fn(),
    onOperationChanged: vi.fn(() => () => undefined),
    listDocumentComments: vi.fn().mockResolvedValue({ items: [] }),
    getOverview: vi.fn().mockResolvedValue(emptyOverview(DOC_ID)),
    listBlocks: vi.fn().mockResolvedValue({
      documentId: DOC_ID,
      roomId: WORKSPACE_DOCUMENT_CHANNEL,
      version: seed.version,
      blocks: [],
    }),
  }
  return { bridge, events, readies }
}

type DocumentsBridge = ReturnType<typeof documentsBridge>['bridge']

let container: HTMLDivElement
let root: Root | null = null
let documents: DocumentsBridge
let documentsEvents: ReturnType<typeof documentsBridge>['events']
let documentsReadies: ReturnType<typeof documentsBridge>['readies']
let fileList: ReturnType<typeof vi.fn>
let saveMarkdown: ReturnType<typeof vi.fn>
let savedNxcore: unknown
const onToast = vi.fn()
const onOpenFile = vi.fn()

async function settle(times = 6): Promise<void> {
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

function browsingBubble(): BubbleState {
  return {
    mode: 'open',
    width: 520,
    cover: false,
    maximized: false,
    files: [],
    activeFileId: null,
  }
}

function renderBubble(bubble = browsingBubble()): React.ReactElement {
  return (
    <BubbleWindow
      bubble={bubble}
      onResize={() => undefined}
      onMinimize={() => undefined}
      onToggleMax={() => undefined}
      onClose={() => undefined}
      onActivateFile={() => undefined}
      onCloseFile={() => undefined}
      onBrowse={() => undefined}
      onOpenFile={onOpenFile}
      onToast={onToast}
    />
  )
}

function emitEvent(event: DocumentEvent): void {
  for (const listener of documentsEvents) {
    listener({ type: 'document.event', protocol: 1, event })
  }
}

function changedEvent(document: RoomDocument): DocumentEvent {
  return {
    id: `event-${document.id}-${document.version}`,
    roomId: null,
    documentId: document.id,
    operationId: null,
    type: 'document.changed',
    occurredAt: '2026-11-10T09:30:00.000Z',
    payload: { document },
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const seed = roomDocument()
  const mocked = documentsBridge(seed)
  documents = mocked.bridge
  documentsEvents = mocked.events
  documentsReadies = mocked.readies
  fileList = vi.fn().mockResolvedValue({ items: [], total: 0 })
  saveMarkdown = vi.fn().mockResolvedValue({
    fileEntryId: 'file-md-1',
    fileVersionId: 'version-2',
    contentHash: 'hash-2',
    originalName: 'x.md',
  })
  savedNxcore = (window as unknown as { nxcore?: unknown }).nxcore
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    documents,
    files: { list: fileList, saveMarkdown, readText: vi.fn(), rename: vi.fn() },
  }
  onToast.mockClear()
  onOpenFile.mockClear()
  removeDocumentDraft(DOC_ID)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  registerDocumentsApi(null)
  registerExternalDocumentsApi(null)
  removeDocumentDraft(DOC_ID)
  container.remove()
  ;(window as unknown as { nxcore?: unknown }).nxcore = savedNxcore
})

describe('云文档伪文件与事件合并（纯函数）', () => {
  it('RoomDocument → OfficeFile：cloudDocument 标记 + 标题/更新时间', () => {
    const file = cloudDocumentToOfficeFile(roomDocument())
    expect(file.id).toBe(`cloud-doc:${DOC_ID}`)
    expect(file.kind).toBe('cloud-doc')
    expect(file.name).toBe('Agent 写的云文档')
    expect(file.cloudDocument).toEqual({ documentId: DOC_ID, title: 'Agent 写的云文档' })
    expect(file.updatedLabel).toBeTruthy()
    expect(file.roomId).toBeNull()
  })

  it('空标题回落「未命名云文档」', () => {
    expect(cloudDocumentTitle({ title: '   ' })).toBe('未命名云文档')
    const file = cloudDocumentToOfficeFile(roomDocument({ title: '' }))
    expect(file.name).toBe('未命名云文档')
    expect(file.cloudDocument?.title).toBe('未命名云文档')
  })

  it('document.changed 按 id 合并，version 更大者胜；旧版本事件不回退', () => {
    const current = [roomDocument()]
    const newer = roomDocument({ version: 4, title: '改过的标题' })
    const merged = reduceCloudDocumentEvent(current, changedEvent(newer))
    expect(merged.needsRefresh).toBe(false)
    expect(merged.documents).toHaveLength(1)
    expect(merged.documents[0]?.version).toBe(4)
    expect(merged.documents[0]?.title).toBe('改过的标题')

    const stale = reduceCloudDocumentEvent(merged.documents, changedEvent(roomDocument({ version: 2 })))
    expect(stale.documents[0]?.version).toBe(4)
  })

  it('新文稿事件进入清单；无负载删除事件按 documentId 摘除', () => {
    const added = reduceCloudDocumentEvent([], changedEvent(roomDocument({ id: 'doc-cloud-2' })))
    expect(added.documents.map((document) => document.id)).toEqual(['doc-cloud-2'])

    const deleted = reduceCloudDocumentEvent(added.documents, {
      id: 'event-del',
      roomId: null,
      documentId: 'doc-cloud-2',
      operationId: null,
      type: 'document.deleted',
      occurredAt: '2026-11-10T10:00:00.000Z',
      payload: null,
    })
    expect(deleted.documents).toEqual([])
  })

  it('document.moved 要求重拉快照；评论类事件不影响清单', () => {
    const moved = reduceCloudDocumentEvent([roomDocument()], {
      id: 'event-moved',
      roomId: null,
      documentId: DOC_ID,
      operationId: null,
      type: 'document.moved',
      occurredAt: '2026-11-10T10:00:00.000Z',
      payload: { documentId: DOC_ID, fromRoomId: null, toRoomId: 'room-x', title: 'x' },
    })
    expect(moved.needsRefresh).toBe(true)

    const comments = reduceCloudDocumentEvent([roomDocument()], {
      id: 'event-comments',
      roomId: null,
      documentId: DOC_ID,
      operationId: null,
      type: 'document.comments.changed',
      occurredAt: '2026-11-10T10:00:00.000Z',
      payload: null,
    })
    expect(comments.documents).toHaveLength(1)
    expect(comments.needsRefresh).toBe(false)
  })
})

describe('气泡窗「云文档」分组', () => {
  it('list(null) 拉取工作区云文档并渲染标题 + 更新时间；点击打开伪文件', async () => {
    await render(renderBubble())

    expect(fileList).toHaveBeenCalled()
    expect(documents.list).toHaveBeenCalledWith(null)
    expect(documents.subscribe).toHaveBeenCalled()
    expect(container.querySelector('[aria-label="云文档"]')).not.toBeNull()
    expect(text('.wb-bubble-cloud-docs-title')).toBe('云文档')
    expect(text('.wb-bubble-cloud-doc-row')).toContain('Agent 写的云文档')
    expect(text('.wb-bubble-cloud-doc-row')).toContain('v3')

    const row = container.querySelector<HTMLButtonElement>('.wb-bubble-cloud-doc-row button')
    expect(row).not.toBeNull()
    await act(async () => {
      row!.click()
    })
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    const opened = onOpenFile.mock.calls[0]?.[0] as OfficeFile
    expect(opened.cloudDocument).toEqual({ documentId: DOC_ID, title: 'Agent 写的云文档' })
    expect(opened.kind).toBe('cloud-doc')
  })

  it('没有云文档时显示让 Agent 写一篇的空态', async () => {
    documents.list.mockResolvedValue([])
    await render(renderBubble())

    expect(container.querySelector('[aria-label="云文档"]')).not.toBeNull()
    expect(text('.wb-bubble-cloud-docs-state')).toContain('还没有云文档，可以让 Agent 写一篇')
  })

  it('工作区文稿事件到达后列表自动刷新（无需手动刷新）', async () => {
    await render(renderBubble())
    expect(text('.wb-bubble-cloud-docs-list')).toContain('Agent 写的云文档')

    await act(async () => {
      emitEvent(changedEvent(roomDocument({
        id: 'doc-cloud-2',
        title: 'Agent 刚写完的新文档',
        version: 1,
      })))
    })
    await settle(2)

    expect(text('.wb-bubble-cloud-docs-list')).toContain('Agent 刚写完的新文档')
  })

  it('没有 documents 桥时整组隐藏，资料列表不受影响', async () => {
    ;(window as unknown as { nxcore?: unknown }).nxcore = {
      files: { list: fileList, saveMarkdown, readText: vi.fn(), rename: vi.fn() },
    }
    await render(renderBubble())

    expect(container.querySelector('[aria-label="云文档"]')).toBeNull()
    expect(container.querySelector('.wb-bubble-browser-scopes')).not.toBeNull()
  })

  it('工作区频道 ready 事件触发快照重拉', async () => {
    await render(renderBubble())
    expect(documents.list).toHaveBeenCalledTimes(1)

    await act(async () => {
      for (const listener of documentsReadies) listener(WORKSPACE_DOCUMENT_CHANNEL)
    })
    await settle(2)

    expect(documents.list.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('CloudDocumentEditor（真实 documents 后端）', () => {
  it('EditorView 按 cloudDocument 路由：旧 Tiptap 编辑器挂载真实云文档正文', async () => {
    const file = cloudDocumentToOfficeFile(roomDocument())
    await render(<EditorView file={file} onToast={onToast} hideSideDock />)

    expect(documents.get).toHaveBeenCalledWith(DOC_ID)
    const surface = container.querySelector('.context-room-tiptap-content')
    expect(surface).not.toBeNull()
    expect(surface?.textContent).toContain('云文档正文第一段')
    // 标题在正文上方的受控 textarea（旧编辑器把 legacy title 从正文里剥掉了）。
    const titleInput = container.querySelector<HTMLTextAreaElement>(
      '.context-room-document-title-input',
    )
    expect(titleInput?.value).toBe('Agent 写的云文档')
    // 不是 mock MdView / GenOffice 预览。
    expect(container.querySelector('.op-native-col')).toBeNull()
    expect(container.querySelector('.op-md-preview')).toBeNull()
  })

  it('渲染期清掉文件库 shim：documentsApi() 是真实桥，保存走 documents.save 而不是 files.saveMarkdown', async () => {
    // 模拟侧栏 Markdown 文件编辑器先挂载过一次、注册了文件库 shim（其清理是微任务）。
    const fileShimSave = vi.fn()
    const fileShim = {
      save: fileShimSave,
      get: vi.fn(),
      list: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      onOperationChanged: vi.fn(() => () => undefined),
      onReady: vi.fn(() => () => undefined),
    } as unknown as NonNullable<ReturnType<typeof documentsApi>>
    registerDocumentsApi(fileShim)
    registerExternalDocumentsApi(null)
    expect(documentsApi()).toBe(fileShim)

    const file = cloudDocumentToOfficeFile(roomDocument())
    await render(<EditorView file={file} onToast={onToast} hideSideDock />)

    // 关键断言：云文档挂载后 documentsApi() 已回落到真实 mock，而不是文件库 shim。
    expect(documentsApi()).toBe(documents)

    const titleInput = container.querySelector<HTMLTextAreaElement>(
      '.context-room-document-title-input',
    )
    expect(titleInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(titleInput, '重命名后的云文档')
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      // React 的 onBlur 走 focusout 代理（blur 不冒泡）。
      titleInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await settle(4)

    expect(documents.save).toHaveBeenCalledTimes(1)
    const [savedId, savedInput] = documents.save.mock.calls[0] as unknown as [
      string,
      { baseVersion: number; title?: string; contentJson: TiptapJsonContent },
    ]
    expect(savedId).toBe(DOC_ID)
    expect(savedInput.baseVersion).toBe(3)
    expect(savedInput.title).toBe('重命名后的云文档')
    // 正文来自真实云文档（不是文件库投影）。
    expect(JSON.stringify(savedInput.contentJson)).toContain('云文档正文第一段')
    // 文件库 shim 完全没被调用（云文档的正文/版本由 documents 表负责）。
    expect(fileShimSave).not.toHaveBeenCalled()
    expect(saveMarkdown).not.toHaveBeenCalled()
  })

  it('文稿不存在 / 加载失败给出错误态并可重试', async () => {
    documents.get.mockRejectedValueOnce(new Error('IPC 读取失败'))
    const file = cloudDocumentToOfficeFile(roomDocument())
    await render(<EditorView file={file} onToast={onToast} hideSideDock />)

    expect(container.querySelector('[data-state="error"] .cloud-doc-editor-state')).not.toBeNull()
    expect(container.querySelector('.context-room-tiptap-content')).toBeNull()
    expect(onToast).toHaveBeenCalledTimes(1)

    documents.get.mockResolvedValueOnce(roomDocument())
    const retry = container.querySelector<HTMLButtonElement>('.cloud-doc-editor-state-action')
    expect(retry).not.toBeNull()
    await act(async () => {
      retry!.click()
    })
    await settle()

    expect(documents.get).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.context-room-tiptap-content')).not.toBeNull()
    expect(onToast).toHaveBeenCalledTimes(1)
  })

  it('Agent 侧更新（工作区事件带来更大 version）推给打开中的编辑器', async () => {
    const file = cloudDocumentToOfficeFile(roomDocument())
    await render(<EditorView file={file} onToast={onToast} hideSideDock />)
    expect(text('.context-room-tiptap-content')).toContain('云文档正文第一段')

    await act(async () => {
      emitEvent(changedEvent(roomDocument({
        version: 4,
        contentJson: documentBody('Agent 刚刚更新后的正文'),
        updatedAt: '2026-11-10T10:30:00.000Z',
      })))
    })
    await settle(4)

    expect(text('.context-room-tiptap-content')).toContain('Agent 刚刚更新后的正文')
  })
})