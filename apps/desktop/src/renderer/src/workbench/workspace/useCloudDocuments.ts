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
 * 云文档与文件库条目在气泡窗里混排成同一份列表：它们是 Agent / 用户在文稿后端里
 * 创建的工作区级文稿（`roomId === null`），按 `workspaceId` 归属到具体工作空间。
 * 这里直接读 preload 的真实文稿桥（**不走** `documentsApi()`）：`documentsApi()`
 * 可能被侧栏 Markdown 文件编辑器的「文件库支撑」shim 覆盖，而云文档列表必须
 * 始终来自真实 documents IPC。
 *
 * 事件语义与 `components/documents/WorkspaceDocumentsProvider` 完全一致（共用
 * `workspaceDocuments.ts` 的合并助手）：订阅工作区频道、增量事件按 id 合并、
 * `(重)连接 ready` 后重新拉快照兜底（事件流有损）。
 *
 * 多工作空间：`list(workspaceId ?? null)` 按空间过滤快照；事件 payload 带
 * `document.workspaceId` 时只接受归属当前空间的事件。旧网关的事件不带归属，
 * 无法判断属于哪个空间，因此不盲目合并，改为防抖重拉一次快照。
 */

/**
 * preload 的 `documents.list` 现签名是 `list(workspaceId?: string | null)`；
 * `null`/缺省 = 整个工作区的文稿集合，传 workspaceId 时按空间过滤。
 */
interface WorkspaceDocumentsApi {
  list(workspaceId?: string | null): Promise<RoomDocument[]>
  subscribe(roomId?: string): Promise<void>
  unsubscribe(roomId?: string): Promise<void>
  onEvent(listener: (frame: DocumentEventFrame) => void): () => void
  onReady(listener: (roomId: string) => void): () => void
}

/** 事件未带工作空间归属时的快照重拉防抖窗口（合并同帧内连续到达的事件）。 */
const WORKSPACE_EVENT_REFRESH_DELAY_MS = 200

function workspaceDocumentsApi(): WorkspaceDocumentsApi | undefined {
  return window.nxcore?.documents
}

/**
 * 云文档归属工作空间。契约里 `RoomDocument.workspaceId` 是可选字段（旧数据没有），
 * 这里防御式读取：字段还没在 shared 类型里落地时也不影响渲染层编译。
 */
function documentWorkspaceId(document: RoomDocument | null | undefined): string | null {
  const value = (document as { workspaceId?: string | null } | null | undefined)?.workspaceId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 快照/事件里的文稿是否属于当前工作空间；无归属信息（旧数据）时按服务端结果放行。 */
function belongsToWorkspace(document: RoomDocument, workspaceId: string | null): boolean {
  if (!workspaceId) return true
  const id = documentWorkspaceId(document)
  return !id || id === workspaceId
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
  /** 真实文稿桥不存在（未恢复/旧版主进程）：气泡窗不展示云文档行。 */
  available: boolean
  /** 工作空间级云文档，按更新时间倒序。 */
  documents: RoomDocument[]
  loading: boolean
  refresh: () => void
}

/**
 * 工作空间云文档清单：`documents.list(workspaceId ?? null)` + 工作区订阅 + 事件
 * 增量合并。无桥时返回空清单并标记 `available: false`（调用方据此隐藏云文档行）。
 */
export function useCloudDocuments(workspaceId?: string): CloudDocuments {
  // 归一成 trimmed scope：切空间时 load 依赖变化，自动重新订阅并重拉快照。
  const scope = workspaceId?.trim() || null
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
  // 未带归属的事件防抖重拉：连续多条只触发一次快照。
  const refreshTimer = useRef<number | null>(null)
  // 切工作空间时先清空旧清单，避免短暂把别的空间的云文档显示出来。
  const scopeRef = useRef(scope)

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
      const listed = await api.list(scope)
      if (seq !== requestSeq.current) return
      // list 在网关侧按空间过滤；防御性再过滤一次工作区级文稿 + 归属。
      const workspaceDocuments = (Array.isArray(listed) ? listed : [])
        .filter((document) => document.roomId === null)
        .filter((document) => belongsToWorkspace(document, scope))
      const next = replaceWorkspaceDocuments(documentsRef.current, workspaceDocuments)
      documentsRef.current = next
      setDocuments(next)
    } catch {
      // 单次快照失败不清空已有清单：事件流仍可能补上（网关短暂不可用时列表不闪空）。
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [scope])

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [])

  /** 事件不带归属时（旧网关）防抖重拉，合并窗口内的连续事件。 */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void load()
    }, WORKSPACE_EVENT_REFRESH_DELAY_MS)
  }, [load])

  useEffect(() => {
    if (scopeRef.current === scope) return
    scopeRef.current = scope
    documentsRef.current = []
    setDocuments([])
    setLoading(true)
  }, [scope])

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
    const debouncedReload = () => {
      if (!disposed) scheduleRefresh()
    }

    void api.subscribe().catch(() => undefined)
    void load()

    const unsubscribeEvents = api.onEvent((frame) => {
      const event = frame.event
      if (!WORKSPACE_DOCUMENT_STATE_EVENT_TYPES.has(event.type)) return
      const document = workspaceDocumentFromEvent(event)
      const eventWorkspaceId = documentWorkspaceId(document)
      // 事件带归属：别的空间的云文档事件不该进入当前清单。
      if (scope && eventWorkspaceId && eventWorkspaceId !== scope) return
      // 事件没带归属（旧网关、删除/moved 等无负载事件）：无法判断属于哪个空间，
      // 不盲目合并，交给防抖快照刷新（服务端按 workspaceId 过滤）。
      if (scope && !eventWorkspaceId) {
        debouncedReload()
        return
      }
      const result = reduceCloudDocumentEvent(documentsRef.current, event)
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
      clearRefreshTimer()
      unsubscribeEvents()
      unsubscribeReady()
      void api.unsubscribe().catch(() => undefined)
    }
  }, [clearRefreshTimer, load, scheduleRefresh, scope])

  const refresh = useCallback(() => {
    void load()
  }, [load])

  return { available, documents, loading, refresh }
}
