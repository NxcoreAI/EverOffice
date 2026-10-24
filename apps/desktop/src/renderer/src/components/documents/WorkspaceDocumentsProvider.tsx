import { WORKSPACE_DOCUMENT_CHANNEL, type DocumentEventFrame, type RoomDocument } from '@nxcore/agent-contract'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  WORKSPACE_DOCUMENT_STATE_EVENT_TYPES,
  mergeWorkspaceDocuments,
  replaceWorkspaceDocuments,
  workspaceDocumentFromEvent,
} from './workspaceDocuments'

/**
 * 工作区文稿 API 的本地视图：`preload` 与主进程桥接自 P0-2b 起已支持
 * `roomId = null`（= 整个工作区），`shared/sources.ts` 的 `NxcoreDesktopApi`
 * 仍写着 `roomId: string`。DTO 收窄随 preload/shared 那一轮统一处理，
 * 这里先用方法双变（method bivariance）声明工作区形态，不引入类型断言。
 */
interface WorkspaceDocumentsApi {
  list(roomId: string | null): Promise<RoomDocument[]>
  // 主进程桥把 `roomId ?? WORKSPACE_DOCUMENT_CHANNEL` 映射到工作区频道，
  // 因此「不传 roomId」与「传 null」等价；preload 类型把这两者写成了可选参数。
  subscribe(roomId?: string): Promise<void>
  unsubscribe(roomId?: string): Promise<void>
  onEvent(listener: (frame: DocumentEventFrame) => void): () => void
  onReady(listener: (roomId: string) => void): () => void
}

export interface WorkspaceDocumentsState {
  /** 工作区文稿清单（roomId 为 null），按更新时间倒序。 */
  documents: RoomDocument[]
  documentsLoading: boolean
  /** 编辑器提交/新建后把最新文稿并入清单（增量事件之外的确定性回填）。 */
  upsertDocument: (document: RoomDocument) => void
  /** 重新拉取整份工作区清单（订阅重连、跨归属移动后使用）。 */
  refresh: () => Promise<void>
}

const WorkspaceDocumentsContext = createContext<WorkspaceDocumentsState | null>(null)

function workspaceDocumentsApi(): WorkspaceDocumentsApi | undefined {
  return window.nxcore?.documents
}

/**
 * 工作区文稿库 Provider（P0-2 渲染层）：订阅工作区频道并维护一份工作区文稿清单。
 * 取代原先以 Room 为键的 `RoomDocumentsProvider`——文稿归属收敛为「工作区」，
 * 清单不再按 Room 分组（roomId 非 null 的文稿不进本清单）。
 */
export function WorkspaceDocumentsProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<RoomDocument[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)

  const upsertDocument = useCallback((document: RoomDocument) => {
    if (document.roomId !== null) return
    if (document.deletedAt) {
      setDocuments((current) => current.filter((candidate) => candidate.id !== document.id))
      return
    }
    setDocuments((current) => mergeWorkspaceDocuments(current, [document]))
  }, [])

  const refresh = useCallback(async () => {
    const api = workspaceDocumentsApi()
    if (!api) {
      setDocumentsLoading(false)
      return
    }
    setDocumentsLoading(true)
    try {
      const listed = await api.list(null)
      setDocuments((current) => replaceWorkspaceDocuments(current, listed))
    } finally {
      setDocumentsLoading(false)
    }
  }, [])

  useEffect(() => {
    const api = workspaceDocumentsApi()
    if (!api) {
      setDocumentsLoading(false)
      return
    }
    void api.subscribe().catch(() => undefined)
    void refresh().catch(() => undefined)

    const unsubscribeEvents = api.onEvent(({ event }) => {
      if (!WORKSPACE_DOCUMENT_STATE_EVENT_TYPES.has(event.type)) return
      // 归属变更（移入/移出 Room）无法从单条事件重建清单，直接重拉快照。
      if (event.type === 'document.moved') {
        void refresh().catch(() => undefined)
        return
      }
      const document = workspaceDocumentFromEvent(event)
      if (document) {
        upsertDocument(document)
        return
      }
      // 无文档负载的删除事件：工作区文稿直接摘除。
      if (event.roomId === null) {
        setDocuments((current) => current.filter((candidate) => candidate.id !== event.documentId))
      }
    })
    // 事件流是有损的：每次 (重)连接都要用 REST 快照兜底，避免断线期间的变更丢失。
    const unsubscribeReady = api.onReady((roomId) => {
      if (roomId === WORKSPACE_DOCUMENT_CHANNEL) void refresh().catch(() => undefined)
    })
    return () => {
      unsubscribeEvents()
      unsubscribeReady()
      void api.unsubscribe().catch(() => undefined)
    }
  }, [refresh, upsertDocument])

  const value = useMemo<WorkspaceDocumentsState>(() => ({
    documents,
    documentsLoading,
    upsertDocument,
    refresh,
  }), [documents, documentsLoading, refresh, upsertDocument])

  return <WorkspaceDocumentsContext.Provider value={value}>{children}</WorkspaceDocumentsContext.Provider>
}

export function useWorkspaceDocuments(): WorkspaceDocumentsState {
  const value = useContext(WorkspaceDocumentsContext)
  if (!value) throw new Error('useWorkspaceDocuments must be used inside WorkspaceDocumentsProvider')
  return value
}