import type { MovedRoomDocument } from '@nxcore/agent-contract'
import { Clock, FolderInput, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import { ReferenceDialog } from './shared'

export interface MovableDocumentSummary {
  id: string
  title: string
  /** 文档当前所属 Room（源房）。 */
  roomId: string
}

interface RoomOption {
  id: string
  title: string
  kind?: string
}

const RECENT_KEY = 'everroom:move-document-recent-rooms'
const RECENT_LIMIT = 5

function readRecentRoomIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(0, RECENT_LIMIT)
      : []
  } catch {
    return []
  }
}

function rememberRecentRoomId(roomId: string): void {
  try {
    const next = [roomId, ...readRecentRoomIds().filter((id) => id !== roomId)].slice(0, RECENT_LIMIT)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式/配额受限时静默降级：最近使用只是快捷入口，不阻断移动。
  }
}

/**
 * 「移动到其他 Room」目标选择器：搜索过滤 + 最近使用置顶 + 单选确认。
 *
 * 房间清单每次打开都从网关快照取（避免本地快照滞后），排除文档当前所在房。
 * 批量（多选）与单个走同一弹层：documents.length > 1 时调用批量移动接口。
 */
export function MoveDocumentToRoomDialog({
  open,
  onOpenChange,
  documents,
  onMoved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  documents: MovableDocumentSummary[]
  onMoved?: (moved: MovedRoomDocument[]) => void
}) {
  const { t } = useLocale()
  const [rooms, setRooms] = useState<RoomOption[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  const sourceRoomId = documents[0]?.roomId ?? null
  const documentKey = documents.map((document) => document.id).join('\u0000')

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedRoomId(null)
    setMoveError(null)
    setLoadError(null)
    const api = window.nxcore?.contextRooms
    if (!api) {
      setRooms([])
      setLoadError(t('contextRoom:moveDocument.roomsUnavailable'))
      return
    }
    let cancelled = false
    setLoading(true)
    void api.list()
      .then((snapshot) => {
        if (cancelled) return
        setRooms((snapshot?.rooms ?? []).map((room) => ({
          id: room.id,
          title: room.title,
          kind: room.kind,
        })))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : t('contextRoom:moveDocument.roomsUnavailable'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, documentKey])

  const candidates = useMemo(
    () => rooms.filter((room) => room.id !== sourceRoomId),
    [rooms, sourceRoomId],
  )
  const keyword = query.trim().toLocaleLowerCase()
  const matches = useMemo(
    () => (keyword
      ? candidates.filter((room) =>
        room.title.toLocaleLowerCase().includes(keyword)
        || (room.kind ?? '').toLocaleLowerCase().includes(keyword))
      : candidates),
    [candidates, keyword],
  )
  const recentIds = open ? readRecentRoomIds() : []
  const recentRooms = matches.filter((room) => recentIds.includes(room.id))
  const otherRooms = matches.filter((room) => !recentIds.includes(room.id))
  const targetRoom = rooms.find((room) => room.id === selectedRoomId) ?? null
  const isBatch = documents.length > 1

  const submit = async () => {
    const target = selectedRoomId
    if (!target || documents.length === 0) return
    const api = window.nxcore?.documents
    if (!api) {
      setMoveError(t('contextRoom:moveDocument.documentsUnavailable'))
      return
    }
    setMoving(true)
    setMoveError(null)
    try {
      const moved = documents.length > 1
        ? (await api.moveMany(documents.map((document) => document.id), documents[0]!.roomId, target)).items
        : [await api.move(documents[0]!.id, documents[0]!.roomId, target)]
      rememberRecentRoomId(target)
      const roomTitle = rooms.find((room) => room.id === target)?.title ?? target
      showToast({
        title: t('contextRoom:moveDocument.moved'),
        message: isBatch
          ? t('contextRoom:moveDocument.movedManyToRoom', { count: documents.length, room: roomTitle })
          : t('contextRoom:moveDocument.movedToRoom', { name: documents[0]!.title, room: roomTitle }),
      })
      onMoved?.(moved)
      onOpenChange(false)
    } catch (error: unknown) {
      setMoveError(error instanceof Error && error.message
        ? error.message
        : t('contextRoom:moveDocument.moveFailed'))
    } finally {
      setMoving(false)
    }
  }

  const renderRoom = (room: RoomOption) => (
    <button
      key={room.id}
      type="button"
      className="context-room-move-room"
      data-selected={room.id === selectedRoomId || undefined}
      aria-pressed={room.id === selectedRoomId}
      onClick={() => setSelectedRoomId(room.id)}
    >
      <span className="context-room-move-room-body">
        <b>{room.title}</b>
        {room.kind ? <small>{room.kind}</small> : null}
      </span>
    </button>
  )

  return (
    <ReferenceDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('contextRoom:moveDocument.title')}
      contentClassName="context-room-move-dialog-shell"
    >
      <div className="context-room-move-dialog">
        <header>
          <span className="context-room-move-symbol">
            <FolderInput aria-hidden="true" strokeWidth={1.8} />
          </span>
          <div>
            <h2>{t('contextRoom:moveDocument.title')}</h2>
            <p>
              {isBatch
                ? t('contextRoom:moveDocument.subtitleBatch', { count: documents.length })
                : t('contextRoom:moveDocument.subtitle', { name: documents[0]?.title ?? '' })}
            </p>
          </div>
        </header>

        <label className="context-room-move-search">
          <Search aria-hidden="true" strokeWidth={1.8} />
          <input
            type="text"
            autoFocus
            value={query}
            placeholder={t('contextRoom:moveDocument.searchPlaceholder')}
            aria-label={t('contextRoom:moveDocument.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="context-room-move-list" role="listbox" aria-label={t('contextRoom:moveDocument.targetRoom')}>
          {loading ? (
            <p className="context-room-move-hint">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              {t('contextRoom:moveDocument.loadingRooms')}
            </p>
          ) : null}
          {loadError ? <p className="context-room-move-error" role="alert">{loadError}</p> : null}
          {!loading && !loadError && recentRooms.length > 0 ? (
            <p className="context-room-move-group">
              <Clock aria-hidden="true" strokeWidth={1.8} />
              {t('contextRoom:moveDocument.recent')}
            </p>
          ) : null}
          {!loading && !loadError ? recentRooms.map(renderRoom) : null}
          {!loading && !loadError && otherRooms.length > 0 && recentRooms.length > 0 ? (
            <p className="context-room-move-group">{t('contextRoom:moveDocument.allRooms')}</p>
          ) : null}
          {!loading && !loadError ? otherRooms.map(renderRoom) : null}
          {!loading && !loadError && matches.length === 0 ? (
            <p className="context-room-move-hint">{t('contextRoom:moveDocument.noMatch')}</p>
          ) : null}
        </div>

        {moveError ? <p className="context-room-move-error" role="alert">{moveError}</p> : null}

        <footer>
          <button type="button" className="context-room-ghost" onClick={() => onOpenChange(false)}>
            {t('contextRoom:moveDocument.cancel')}
          </button>
          <button
            type="button"
            className="context-room-primary"
            disabled={!targetRoom || moving}
            onClick={() => void submit()}
          >
            {moving
              ? t('contextRoom:moveDocument.moving')
              : targetRoom
                ? t('contextRoom:moveDocument.moveToRoom', { room: targetRoom.title })
                : t('contextRoom:moveDocument.move')}
          </button>
        </footer>
      </div>
    </ReferenceDialog>
  )
}