/**
 * 侧栏（气泡窗 / 工作空间文件标签页）里真实 `.md` / `.markdown` 文件的编辑器宿主。
 *
 * 这里不新写编辑器 UI，而是把 2026-11 恢复的旧云端文稿编辑器
 * （`components/office-editor/editor/TiptapDocumentEditor.tsx`）挂起来：
 *
 * 1. `files.readText(fileId)` 读原始文本 → `splitMarkdownDocument` 剥出 YAML
 *    frontmatter（逐字节保留）→ `markdownToDocumentJson` 把正文转成旧编辑器吃的
 *    文稿 JSON，合成一份 `RoomDocument`；
 * 2. 在 **渲染期同步** 注册一份「文件库支撑」的 `DocumentsApi`
 *    （`createFileBackedDocumentsApi`），旧编辑器/Provider 的挂载 effect 里
 *    调 `documentsApi()` 时就能拿到（子组件 effect 先于父组件运行，effect 里
 *    再注册就晚了）；
 * 3. 旧编辑器编辑后 300ms 防抖走 `documents.save` → 我们的 shim →
 *    `documentJsonToMarkdown` + frontmatter → `files.saveMarkdown` 落成同一
 *    fileEntry 的新版本；标题改动再 best-effort `files.rename`；
 * 4. 评论 / 版本历史 / 速览 / Agent 文稿操作 / 外部导入导出等依赖已下线文稿
 *    后端的能力，由 shim 给出空结果或明确的「暂不支持」（见
 *    `fileBackedDocumentsApi.ts` 的降级矩阵）。
 *
 * 旧编辑器需要的三个 React 上下文：工作区文稿清单、当前活动文稿、文稿操作中心。
 * 前两个由 Lead 恢复的 Provider 提供；操作中心我们传一个安全的本地桥（列表空、
 * 启动/查询/命令明确拒绝），避免依赖「旧操作后端」是否存在。
 */
import type { RoomDocument, SaveRoomDocumentInput } from '@nxcore/agent-contract'
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { WorkspaceDocumentsProvider } from '@/components/documents/WorkspaceDocumentsProvider'
import {
  documentsApi,
  registerDocumentsApi,
  registerExternalDocumentsApi,
  type DocumentsApi,
} from '@/components/office-editor/documentApi'
import { readDocumentDraftRecord } from '@/components/office-editor/editor/documentDraftStorage'
import { TiptapDocumentEditor } from '@/components/office-editor/editor/TiptapDocumentEditor'
import { DocumentOperationProvider } from '@/components/office-editor/operations/DocumentOperationProvider'
import type { OperationBridge } from '@/components/office-editor/operations/types'
import type { ContextRoomRecord } from '@/components/office-editor/types'
import type { FileCatalogDto } from '@/shared/ingest'
import { ActiveDocumentProvider } from '@/state/ActiveDocumentContext'

import type { OfficeFile } from './data'
import {
  createFileBackedDocumentsApi,
  createUnavailableExternalDocumentsApi,
  workspaceRoomIdForFile,
} from './fileBackedDocumentsApi'
import { markdownToDocumentJson, documentJsonToMarkdown } from './markdownDocumentAdapter'
import { joinMarkdownDocument, splitMarkdownDocument } from './markdownFileText'
import './sidebarDocumentEditor.css'

const OPERATION_UNSUPPORTED = '侧栏文件编辑器暂不支持 Agent 文稿操作（本地 Markdown 文件没有文稿操作后端）。'

const rejectOperation = (): Promise<never> => Promise.reject(new Error(OPERATION_UNSUPPORTED))

/**
 * 文稿操作中心的安全桥：本地文件没有 Agent 操作后端，列表返回空、订阅 no-op，
 * 启动/查询/命令都明确拒绝（只有用户主动触发 AI 操作才会走到）。
 */
const SIDEBAR_OPERATION_BRIDGE: OperationBridge = {
  list: async () => [],
  get: rejectOperation,
  start: rejectOperation,
  command: rejectOperation,
  subscribe: () => () => undefined,
  subscribeReady: () => () => undefined,
}

export interface SidebarDocumentEditorProps {
  file: OfficeFile
  onToast: (message: string) => void
}

/** 文件库条目的展示标题：显示名 → 共享标题 → 去掉扩展名的原文件名。 */
function markdownTitleForCatalog(catalog: FileCatalogDto): string {
  const displayName = catalog.displayName?.trim()
  if (displayName) return displayName
  const sharedTitle = catalog.sharedTitle?.trim()
  if (sharedTitle) return sharedTitle
  const originalName = catalog.originalName?.trim() || '未命名 Markdown'
  return originalName.replace(/\.(?:md|markdown)$/i, '') || originalName
}

/** 合成旧编辑器吃的 `RoomDocument`（文件库文件没有文稿后端，这里是本地投影）。 */
/**
 * 重开文件时的文稿版本：文件库没有「文稿版本」概念，而旧编辑器的草稿恢复要求
 * `draft.baseVersion === backendDocument.version`（见 `shouldRecoverDocumentDraft`）。
 * 每次挂载都把 synthetic 版本对齐到草稿的基准版本，卸载时只写进 localStorage
 * 的最后一版编辑才能在重开时被恢复；没有草稿时从 1 开始。
 */
function resumeVersionFor(fileId: string): number {
  const draft = readDocumentDraftRecord(fileId)
  return typeof draft?.baseVersion === 'number' ? draft.baseVersion : 1
}

function syntheticRoomDocument(
  catalog: FileCatalogDto,
  contentJson: RoomDocument['contentJson'],
  version: number = 1,
  title: string = markdownTitleForCatalog(catalog),
): RoomDocument {
  const timestamp = catalog.updatedAt || new Date().toISOString()
  return {
    id: catalog.id,
    // 工作空间级文稿：文件库文件不属于任何 Room。
    roomId: null,
    title,
    contentJson,
    contentSchemaVersion: 1,
    version,
    status: 'active',
    origin: 'native',
    activeTransactionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/**
 * 合成旧编辑器吃的 `ContextRoomRecord`（工作空间投影）。
 * 所有统计/关联数据为空：侧栏文件编辑器不展示 Room 概览，只用到 id / title /
 * cloudDoc 绑定（旧编辑器从 `room.cloudDoc.docId` 取 documentId）。
 */
function syntheticWorkspaceRoom(catalog: FileCatalogDto): ContextRoomRecord {
  const now = new Date().toISOString()
  const roomId = workspaceRoomIdForFile(catalog)
  return {
    id: roomId,
    title: '工作空间',
    kind: '项目',
    icon: '',
    tone: 'sky',
    status: 'active',
    starred: false,
    updatedAt: catalog.updatedAt || now,
    lastViewed: now,
    roomCode: roomId,
    brief: {
      background: '',
      goal: '',
      status: '',
      risks: [],
      decisions: [],
    },
    stats: {
      docs: 0,
      mails: 0,
      meetings: 0,
      events: 0,
      memories: 0,
      tasks: 0,
    },
    riskCount: 0,
    pendingMemoryCount: 0,
    people: [],
    timeline: [],
    materials: [],
    actionItems: [],
    graphEdges: [],
    pendingMemoryItems: [],
    memoryItems: [],
    fileItems: [],
    nextReverseRecall: '',
    cloudDoc: {
      workspaceId: catalog.workspaceId,
      docId: catalog.id,
      title: markdownTitleForCatalog(catalog),
    },
  }
}

export function SidebarDocumentEditor({ file, onToast }: SidebarDocumentEditorProps) {
  const catalog = file.realCatalog
  if (!catalog) {
    return (
      <div className="sidebar-doc-editor" data-state="unavailable">
        <div className="sidebar-doc-editor-state">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>该文件缺少文件库信息，暂时无法在侧栏编辑。</p>
        </div>
      </div>
    )
  }
  return (
    <SidebarDocumentEditorFile
      key={catalog.id}
      catalog={catalog}
      onToast={onToast}
    />
  )
}

type LoadPhase = 'loading' | 'ready' | 'error' | 'unavailable'

function SidebarDocumentEditorFile({
  catalog,
  onToast,
}: {
  catalog: FileCatalogDto
  onToast: (message: string) => void
}) {
  const fileId = catalog.id
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast

  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [backend, setBackend] = useState<RoomDocument | null>(null)

  const documentRef = useRef<RoomDocument | null>(null)
  const frontmatterRef = useRef('')
  /** 原文件正文是否以换行结尾：保存时保留这个习惯，避免每次保存都造一行 diff。 */
  const bodyEndsWithNewlineRef = useRef(false)
  const toastedRef = useRef(false)
  const unmountTokenRef = useRef(0)

  const room = useMemo(() => syntheticWorkspaceRoom(catalog), [catalog])

  /* ───────────── 读取文件 → 合成文稿 ───────────── */

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError('')

    const load = async (): Promise<void> => {
      const files = window.nxcore?.files
      if (typeof files?.readText !== 'function') {
        if (!cancelled) setPhase('unavailable')
        return
      }
      try {
        const result = await files.readText(fileId)
        if (cancelled) return
        const text = typeof result?.text === 'string' ? result.text : ''
        const parts = splitMarkdownDocument(text)
        frontmatterRef.current = parts.frontmatter
        bodyEndsWithNewlineRef.current = parts.body === '' || parts.body.endsWith('\n')
        const contentJson = markdownToDocumentJson(parts.body)
        const draft = readDocumentDraftRecord(fileId)
        // 版本与草稿基准对齐后，旧编辑器 mount 时才会把未落盘的草稿恢复出来
        // （见 documentDraftStorage.shouldRecoverDocumentDraft）。
        const document = syntheticRoomDocument(
          catalogRef.current,
          contentJson,
          resumeVersionFor(fileId),
          draft?.title?.trim() || markdownTitleForCatalog(catalogRef.current),
        )
        documentRef.current = document
        setBackend(document)
        setPhase('ready')
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error && cause.message ? cause.message : '未知错误'
        setError(message)
        setPhase('error')
        if (!toastedRef.current) {
          toastedRef.current = true
          onToastRef.current('Markdown 文件读取失败，请重试。')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [fileId, reloadKey])

  /* ───────────── 保存：文稿 JSON → Markdown → files.saveMarkdown ───────────── */

  const saveDocument = useCallback(async (input: SaveRoomDocumentInput): Promise<RoomDocument> => {
    const current = documentRef.current
    if (!current) throw new Error('侧栏文件尚未加载完成，请稍后重试。')
    const files = window.nxcore?.files
    if (typeof files?.saveMarkdown !== 'function') {
      throw new Error('文件服务尚未就绪，无法保存 Markdown。')
    }
    const catalogNow = catalogRef.current

    let body = documentJsonToMarkdown(input.contentJson)
    if (body && bodyEndsWithNewlineRef.current && !body.endsWith('\n')) body += '\n'
    const markdown = joinMarkdownDocument(frontmatterRef.current, body)

    await files.saveMarkdown({
      fileId: catalogNow.id,
      markdown,
      originalName: catalogNow.originalName,
      workspaceId: catalogNow.workspaceId,
    })

    const nextTitle = (input.title ?? '').trim() || current.title
    if (nextTitle !== current.title) {
      // 改名是 best-effort：显示名没改成不影响正文已落盘。
      try {
        if (typeof files.rename === 'function') await files.rename(catalogNow.id, nextTitle)
      } catch {
        // 忽略：原始文件名/显示名保持旧值，正文已经是新版本。
      }
    }

    const updated: RoomDocument = {
      ...current,
      title: nextTitle,
      contentJson: input.contentJson,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    documentRef.current = updated
    return updated
  }, [])

  const api = useMemo<DocumentsApi>(() => createFileBackedDocumentsApi({
    fileId,
    catalog,
    getDocument: () => documentRef.current
      ?? syntheticRoomDocument(catalogRef.current, { type: 'doc', content: [] }),
    saveDocument,
    rename: async (title: string) => {
      const files = window.nxcore?.files
      if (typeof files?.rename === 'function') await files.rename(catalogRef.current.id, title)
    },
  }), [catalog, fileId, saveDocument])

  const externalApi = useMemo(() => createUnavailableExternalDocumentsApi(), [])

  // 渲染期同步注册：Provider / 旧编辑器的挂载 effect（子组件先跑）会立刻
  // 读 `documentsApi()`，放到 effect 里注册就晚一步，挂载期读会拿不到 shim。
  registerDocumentsApi(api)
  registerExternalDocumentsApi(externalApi)

  useEffect(() => {
    // 重新注册一次：StrictMode 会「挂载 → 卸载 → 再挂载」地重放 effect，
    // 重放时清理逻辑不能把 shim 清掉。
    const token = ++unmountTokenRef.current
    registerDocumentsApi(api)
    registerExternalDocumentsApi(externalApi)
    return () => {
      // 真正的卸载才清理；推迟到微任务，StrictMode 同步重挂时 token 已变，
      // 不会误清。只在 shim 仍属于本实例时清理（切文件时新实例可能已注册）。
      queueMicrotask(() => {
        if (unmountTokenRef.current !== token) return
        if (documentsApi() === api) {
          registerDocumentsApi(null)
          registerExternalDocumentsApi(null)
        }
      })
    }
  }, [api, externalApi])

  const handleBackendDocumentChange = useCallback((document: RoomDocument) => {
    // 旧编辑器保存成功后回填权威文稿：同步宿主持有的快照。
    documentRef.current = document
    setBackend(document)
  }, [])

  const retry = () => setReloadKey((value) => value + 1)

  if (phase === 'loading') {
    return (
      <div className="sidebar-doc-editor" data-state="loading">
        <div className="sidebar-doc-editor-state" role="status" aria-live="polite">
          <LoaderCircle size={18} className="sidebar-doc-editor-spin" aria-hidden="true" />
          <p>正在读取 Markdown…</p>
        </div>
      </div>
    )
  }

  if (phase === 'unavailable') {
    return (
      <div className="sidebar-doc-editor" data-state="unavailable">
        <div className="sidebar-doc-editor-state" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>文件服务尚未就绪，暂时无法在侧栏编辑这个 Markdown 文件。</p>
          <button type="button" className="sidebar-doc-editor-state-action" onClick={retry}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'error' || !backend) {
    return (
      <div className="sidebar-doc-editor" data-state="error">
        <div className="sidebar-doc-editor-state is-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>Markdown 加载失败{error ? `：${error}` : ''}</p>
          <button type="button" className="sidebar-doc-editor-state-action" onClick={retry}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar-doc-editor" data-state="ready">
      <WorkspaceDocumentsProvider>
        <ActiveDocumentProvider>
          <DocumentOperationProvider operationBridge={SIDEBAR_OPERATION_BRIDGE}>
            <TiptapDocumentEditor
              room={room}
              backendDocument={backend}
              onBackendDocumentChange={handleBackendDocumentChange}
            />
          </DocumentOperationProvider>
        </ActiveDocumentProvider>
      </WorkspaceDocumentsProvider>
    </div>
  )
}