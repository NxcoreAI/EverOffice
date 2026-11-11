/**
 * 工作空间「云文档」编辑器：把 2026-11 恢复的旧云文稿编辑器
 * （`components/office-editor/editor/TiptapDocumentEditor.tsx`）接到**真实**
 * 网关 documents 表（`window.nxcore.documents`）上。
 *
 * 与侧栏 Markdown 文件编辑器（`office-proto/SidebarDocumentEditor.tsx`）的区别：
 * - 文件编辑器把真实 `.md` 文件投影成文稿，数据落文件库（`files.saveMarkdown`），
 *   并在挂载期注册一份文件库支撑的 `DocumentsApi` shim；
 * - 云文档本身就是文稿后端的条目，正文/版本/评论/全在 documents 表，编辑与保存
 *   直接走 preload 的 `documents.get/save`，不需要任何投影。
 *
 * 关键点：**渲染期同步清空** `documentApi` 的覆盖实现。
 * `SidebarDocumentEditor` 在渲染期同步 `registerDocumentsApi(shim)`，卸载清理却
 * 推迟到微任务（见该文件注释）；如果用户从 Markdown 文件切到云文档，旧编辑器的
 * Provider/编辑器 effect（子组件先于父组件运行）仍会读到那份文件库 shim，云文档
 * 就会「读到一个 Markdown 文件」并被保存进文件库。因此在云文档编辑器渲染的第一
 * 时间把覆盖清成 `null`，让 `documentsApi()` 回落到真实的 preload 桥
 * （`registerDocumentsApi(null)` 的语义就是「没有注册实现，用窗口桥」）。
 */
import { WORKSPACE_DOCUMENT_CHANNEL, type RoomDocument } from '@nxcore/agent-contract'
import { AlertTriangle, FileText, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { WorkspaceDocumentsProvider, useWorkspaceDocuments } from '@/components/documents/WorkspaceDocumentsProvider'
import {
  documentsApi,
  registerDocumentsApi,
  registerExternalDocumentsApi,
} from '@/components/office-editor/documentApi'
import { TiptapDocumentEditor } from '@/components/office-editor/editor/TiptapDocumentEditor'
import { DocumentOperationProvider } from '@/components/office-editor/operations/DocumentOperationProvider'
import { desktopOperationBridge } from '@/components/office-editor/operations/desktopOperationBridge'
import type { ContextRoomRecord } from '@/components/office-editor/types'
import { ActiveDocumentProvider } from '@/state/ActiveDocumentContext'

import './cloudDocumentEditor.css'

export interface CloudDocumentEditorProps {
  /** documents 表的文稿 id。 */
  documentId: string
  /** 列表里已知的标题（加载完成前后都用它兜底展示）。 */
  title?: string
  onToast: (message: string) => void
}

type LoadPhase = 'loading' | 'ready' | 'error' | 'unavailable' | 'missing'

/**
 * 工作区级文稿 → 旧编辑器吃的合成 `ContextRoomRecord`。
 *
 * 云文档不再归属任何 Room（`roomId === null`），旧编辑器却要一个 room 对象取
 * `room.cloudDoc.docId` 等绑定信息；这里造一个「工作空间」投影，统计/关联数据
 * 全部为空（云文档编辑器不展示 Room 概览）。`id` 用工作区频道常量，语义上标明
 * 「这是工作区作用域」，也不会与真实 Room id 冲突。
 */
function syntheticWorkspaceRoom(documentId: string, title: string): ContextRoomRecord {
  const now = new Date().toISOString()
  return {
    id: WORKSPACE_DOCUMENT_CHANNEL,
    title: '工作空间',
    kind: '项目',
    icon: '',
    tone: 'sky',
    status: 'active',
    starred: false,
    updatedAt: now,
    lastViewed: now,
    roomCode: WORKSPACE_DOCUMENT_CHANNEL,
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
      workspaceId: '',
      docId: documentId,
      title,
    },
  }
}

export function CloudDocumentEditor({ documentId, title, onToast }: CloudDocumentEditorProps) {
  // 同步清空文件库 shim（原因见文件头注释）。必须发生在渲染期、早于任何子组件
  // 的挂载 effect；`null` 的语义就是「回落到 window.nxcore.documents」。
  registerDocumentsApi(null)
  registerExternalDocumentsApi(null)

  return (
    <CloudDocumentEditorDocument
      key={documentId}
      documentId={documentId}
      initialTitle={title}
      onToast={onToast}
    />
  )
}

function CloudDocumentEditorDocument({
  documentId,
  initialTitle,
  onToast,
}: {
  documentId: string
  initialTitle?: string
  onToast: (message: string) => void
}) {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [error, setError] = useState('')
  const [initialDocument, setInitialDocument] = useState<RoomDocument | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast
  const toastedRef = useRef(false)

  const title = initialTitle?.trim() || '未命名云文档'
  const room = useMemo(() => syntheticWorkspaceRoom(documentId, title), [documentId, title])

  // 操作中心桥：从渲染期起 `documentsApi()` 已回落到真实桥，这里拿到的是真实
  // `documents.listOperations/startOperation/...`。useMemo 固定 identity：Provider
  // 的挂载 effect 依赖它，每次渲染都换新桥会反复 refresh。
  const operationBridge = useMemo(() => desktopOperationBridge(), [])

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError('')

    const load = async (): Promise<void> => {
      const api = documentsApi()
      if (!api || typeof api.get !== 'function') {
        if (!cancelled) setPhase('unavailable')
        return
      }
      try {
        const document = await api.get(documentId)
        if (cancelled) return
        if (!document || document.deletedAt) {
          setPhase('missing')
          return
        }
        setInitialDocument(document)
        setPhase('ready')
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error && cause.message ? cause.message : '未知错误'
        setError(message)
        setPhase('error')
        if (!toastedRef.current) {
          toastedRef.current = true
          onToastRef.current('云文档加载失败，请重试。')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [documentId, reloadKey])

  const retry = useCallback(() => setReloadKey((value) => value + 1), [])

  if (phase === 'loading') {
    return (
      <div className="cloud-doc-editor" data-state="loading">
        <div className="cloud-doc-editor-state" role="status" aria-live="polite">
          <LoaderCircle size={18} className="cloud-doc-editor-spin" aria-hidden="true" />
          <p>正在加载云文档…</p>
        </div>
      </div>
    )
  }

  if (phase === 'unavailable') {
    return (
      <div className="cloud-doc-editor" data-state="unavailable">
        <div className="cloud-doc-editor-state" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>文稿服务尚未就绪，暂时无法打开云文档。</p>
          <button type="button" className="cloud-doc-editor-state-action" onClick={retry}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'missing') {
    return (
      <div className="cloud-doc-editor" data-state="missing">
        <div className="cloud-doc-editor-state" role="alert">
          <FileText size={18} aria-hidden="true" />
          <p>云文档不存在，可能已被删除。</p>
          <button type="button" className="cloud-doc-editor-state-action" onClick={retry}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'error' || !initialDocument) {
    return (
      <div className="cloud-doc-editor" data-state="error">
        <div className="cloud-doc-editor-state is-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>云文档加载失败{error ? `：${error}` : ''}</p>
          <button type="button" className="cloud-doc-editor-state-action" onClick={retry}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cloud-doc-editor" data-state="ready">
      <WorkspaceDocumentsProvider>
        <ActiveDocumentProvider>
          <DocumentOperationProvider operationBridge={operationBridge}>
            <CloudDocumentSurface
              room={room}
              documentId={documentId}
              initialDocument={initialDocument}
            />
          </DocumentOperationProvider>
        </ActiveDocumentProvider>
      </WorkspaceDocumentsProvider>
    </div>
  )
}

/**
 * 渲染期之后的这一层负责「后端快照 → 旧编辑器」：
 * `WorkspaceDocumentsProvider` 已经订阅了工作区频道（Agent 写完文稿会推送事件），
 * 这里把同一份清单里该文稿的更新版本喂给旧编辑器；旧编辑器见到更大 version 且
 * 没有未落盘编辑时会原位更新正文（见 `documentEditorSync.ts`）。
 */
function CloudDocumentSurface({
  room,
  documentId,
  initialDocument,
}: {
  room: ContextRoomRecord
  documentId: string
  initialDocument: RoomDocument
}) {
  const { documents } = useWorkspaceDocuments()
  const [backendDocument, setBackendDocument] = useState<RoomDocument>(initialDocument)
  const backendRef = useRef(backendDocument)
  backendRef.current = backendDocument

  const listedDocument = documents.find((document) => document.id === documentId) ?? null
  useEffect(() => {
    if (!listedDocument || listedDocument.deletedAt) return
    setBackendDocument((current) => (
      listedDocument.version > current.version ? listedDocument : current
    ))
  }, [listedDocument])

  const handleBackendDocumentChange = useCallback((document: RoomDocument) => {
    setBackendDocument(document)
  }, [])

  return (
    <TiptapDocumentEditor
      room={room}
      backendDocument={backendDocument}
      onBackendDocumentChange={handleBackendDocumentChange}
    />
  )
}