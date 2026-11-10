import {
  WORKSPACE_DOCUMENT_CHANNEL,
  type DocumentEvent,
  type DocumentEventFrame,
  type RoomDocument,
} from '@nxcore/agent-contract'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  WORKSPACE_DOCUMENT_STATE_EVENT_TYPES,
  mergeWorkspaceDocuments,
  replaceWorkspaceDocuments,
  workspaceDocumentFromEvent,
} from '@/components/documents/workspaceDocuments'

/**
 * 工作空间「云文档」（网关 documents 表）列表数据源。
 *
 * 工作空间气泡窗的「资料与文件」浏览态在最上方单列一组云文档：它们是 Agent /
 * 用户在文稿后端里创建的工作区级文稿（`roomId === null`），不是文件库条目。
 * 这里直接读 preload 的真实文稿桥（**不走** `documentsApi()`）：`documentsApi()`
 * 可能被侧栏 Markdown 文件编辑器的「文件库支撑」shim 覆盖，而云文档列表必须
 * 始终来自真实 documents IPC。
 *
 * 事件语义与 `components/documents/WorkspaceDocumentsProvider` 完全一致（共用
 * `workspaceDocuments.ts` 的合并助手）：订阅工作区频道、增量事件按 id 合并、
 * `(重)连接 ready` 后重新拉快照兜底（事件流有损）。
 */

/**
 * preload 的 `documents.list` 现签名是 `list(roomId: string)`，但真实主进程桥把
 * `roomId ?? WORKSPACE_DOCUMENT_CHANNEL` 映射到工作区频道（`null` = 整个工作区）。
 * `WorkspaceDocumentsProvider` 用同样的方法双变声明描述工作区形态；DTO 收窄留给
 * preload/shared 那一轮统一处理，这里不改 shared 类型。
 */
interface WorkspaceDocumentsApi {
  list(roomId: string | null): Promise<RoomDocument[]>
  subscribe(roomId?: string): Promise<void>
  unsubscribe(roomId?: string): Promise<void>
  onEvent(listener: (frame: DocumentEventFrame) => void): () => void
  onReady(listener: (roomId: string) => void): () => void
}

function workspaceDocumentsApi(): WorkspaceDocumentsApi | undefined {
  return window.nxcore?.documents
}

export interface CloudDocumentEventResult {
  documents: RoomDocument[]
  /** 归属变更（document.moved）无法从单条事件重建清单，需要重拉快照。 */
  needsRefresh: boolean
}

/**
 * 单条文稿事件 → 工作区云文档清单（纯函数，便于单测）。
 *
 * 规则与 `WorkspaceDocumentsProvider` 的事件处理保持一致：
 * - 只有会改变清单状态的事件才参与合并；
 * - `document.moved` 直接要求重拉快照；
 * - 带文档负载的事件按 id 增量合并（同 id 取更大 version）；
 * - 无负载的删除事件（`roomId === null`）按 documentId 摘除。
 */
export function reduceCloudDocumentEvent(
  current: RoomDocument[],
  event: DocumentEvent,
): CloudDocumentEventResult {
  if (!WORKSPACE_DOCUMENT_STATE_EVENT_TYPES.has(event.type)) {
    return { documents: current, needsRefresh: false }
  }
  if (event.type === 'document.moved') {
    return { documents: current, needsRefresh: true }
  }
  const document = workspaceDocumentFromEvent(event)
  if (document) {
    return { documents: mergeWorkspaceDocuments(current, [document]), needsRefresh: false }
  }
  if (event.roomId === null) {
    return {
      documents: current.filter((candidate) => candidate.id !== event.documentId),
      needsRefresh: false,
    }
  }
  return { documents: current, needsRefresh: false }
}

export interface CloudDocuments {
  /** 真实文稿桥不存在（未恢复/旧版主进程）：气泡窗隐藏「云文档」分组。 */
  available: boolean
  /** 工作区级云文档，按更新时间倒序。 */
  documents: RoomDocument[]
  loading: boolean
  refresh: () => void
}

/**
 * 工作区云文档清单：`documents.list(null)` + 工作区订阅 + 事件增量合并。
 * 无桥时返回空清单并标记 `available: false`（调用方据此隐藏入口）。
 */
export function useCloudDocuments(): CloudDocuments {
  const [documents, setDocuments] = useState<RoomDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(
    () => typeof window.nxcore?.documents?.list === 'function',
  )
  // 事件回调里要读「当前清单」但不能把 documents 放进订阅 effect 的依赖（否则
  // 每次事件都重新订阅一次频道）；用 ref 镜像，事件合并保持同步。
  const documentsRef = useRef<RoomDocument[]>([])
  documentsRef.current = documents
  // 并发刷新只认最后一次请求，避免旧快照覆盖新事件。
  const requestSeq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const api = workspaceDocumentsApi()
    if (!api || typeof api.list !== 'function') {
      setAvailable(false)
      setLoading(false)
      return
    }
    setAvailable(true)
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    try {
      const listed = await api.list(null)
      if (seq !== requestSeq.current) return
      // list(null) 语义上只返回工作区文稿；防御性再过滤一次，Room 归属文稿不进本清单。
      const workspaceDocuments = (Array.isArray(listed) ? listed : [])
        .filter((document) => document.roomId === null)
      const next = replaceWorkspaceDocuments(documentsRef.current, workspaceDocuments)
      documentsRef.current = next
      setDocuments(next)
    } catch {
      // 单次快照失败不清空已有清单：事件流仍可能补上（网关短暂不可用时列表不闪空）。
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const api = workspaceDocumentsApi()
    if (!api || typeof api.list !== 'function') {
      setAvailable(false)
      setLoading(false)
      return undefined
    }
    setAvailable(true)
    let disposed = false
    const reload = () => {
      if (!disposed) void load()
    }

    void api.subscribe().catch(() => undefined)
    void load()

    const unsubscribeEvents = api.onEvent((frame) => {
      const result = reduceCloudDocumentEvent(documentsRef.current, frame.event)
      if (result.needsRefresh) {
        reload()
        return
      }
      if (result.documents !== documentsRef.current) {
        documentsRef.current = result.documents
        setDocuments(result.documents)
      }
    })
    // 事件流有损：每次 (重)连接都用快照兜底，避免断线期间的变更丢失。
    const unsubscribeReady = api.onReady((roomId) => {
      if (roomId === WORKSPACE_DOCUMENT_CHANNEL) reload()
    })

    return () => {
      disposed = true
      unsubscribeEvents()
      unsubscribeReady()
      void api.unsubscribe().catch(() => undefined)
    }
  }, [load])

  const refresh = useCallback(() => {
    void load()
  }, [load])

  return { available, documents, loading, refresh }
}