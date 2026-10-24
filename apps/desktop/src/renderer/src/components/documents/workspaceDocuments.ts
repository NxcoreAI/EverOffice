import type { DocumentEvent, RoomDocument } from '@nxcore/agent-contract'

/**
 * 工作区文稿库的事件合并逻辑。
 *
 * 工作区文稿（`roomId === null`）只有一份清单：订阅时用 `documents.subscribe(null)`
 * 落到工作区频道，主进程把工作区文稿的变更推到这里。合并规则与旧的 Room 索引一致
 * （同一 id 取更大 version，version 相同取更新的 updatedAt），保证增量事件与
 * 列表快照交错到达时不会把新内容覆盖回旧内容。
 */

/** 从文档事件里取出工作区文稿；归属其他 Room 的文稿不进工作区清单。 */
export function workspaceDocumentFromEvent(event: DocumentEvent): RoomDocument | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const document = (event.payload as { document?: unknown }).document
  if (!document || typeof document !== 'object') return null
  const value = document as Partial<RoomDocument>
  return typeof value.id === 'string' && value.roomId === null ? value as RoomDocument : null
}

function newerDocument(current: RoomDocument | undefined, incoming: RoomDocument): RoomDocument {
  if (!current) return incoming
  if (incoming.version !== current.version) return incoming.version > current.version ? incoming : current
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

function byUpdatedAtDescending(left: RoomDocument, right: RoomDocument): number {
  return right.updatedAt.localeCompare(left.updatedAt)
}

/** 增量合并：保留清单中已有、把 incoming 按 id 并入，再按更新时间倒序。 */
export function mergeWorkspaceDocuments(current: RoomDocument[], incoming: RoomDocument[]): RoomDocument[] {
  const byId = new Map(current.map((document) => [document.id, document]))
  for (const document of incoming) byId.set(document.id, newerDocument(byId.get(document.id), document))
  return [...byId.values()].sort(byUpdatedAtDescending)
}

/** 快照替换：清单以 incoming 为准，同 id 仍取更新的一条（事件可能先到）。 */
export function replaceWorkspaceDocuments(current: RoomDocument[], incoming: RoomDocument[]): RoomDocument[] {
  const currentById = new Map(current.map((document) => [document.id, document]))
  return incoming
    .map((document) => newerDocument(currentById.get(document.id), document))
    .sort(byUpdatedAtDescending)
}

/** 会改变清单内容（而非仅标题/正文）的文档事件。 */
export const WORKSPACE_DOCUMENT_STATE_EVENT_TYPES = new Set<DocumentEvent['type']>([
  'document.changed',
  'document.operation.changed',
  'document.deleted',
  'document.moved',
])
