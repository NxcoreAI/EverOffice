import { Link2, Network } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import type { RoomDocument } from '@nxcore/agent-contract'

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge'
import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { createContextRoomResourceLibrary } from '../../resources'
import { useRoomRelationGraph } from '../../hooks/useRoomRelationGraph'
import { RoomGraphCanvas } from '../RoomGraphCanvas'
import { RoomNodeInspector } from '../RoomGraphInspector'
import { CreateRoomRelationDialog, relationTypeLabel, RoomRelationInspector } from '../RoomRelationControls'
import { PanelEmptyState } from './PanelEmptyState'

/** 用户缩放/拖拽后，鼠标在关系图谱上静止多久自动弹性复位到自适应视野。 */
const RELATIONS_AUTO_FIT_IDLE_MS = 5_000

export function RelationsPane({
  room,
  rooms,
  backendDocuments,
  knowledgeFiles,
  onOpenRoom,
  onSelectResource,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  backendDocuments: RoomDocument[]
  knowledgeFiles: KnowledgeFileDto[]
  onOpenRoom: (roomId: string) => void
  onSelectResource: (resource: ContextRoomResource) => void
}) {
  const { locale, t } = useLocale()
  const [visibility, setVisibility] = useState<'active' | 'hidden'>('active')
  const { error, graph, loading, reload } = useRoomRelationGraph(room.id, visibility)
  const [selectedGraphRoomId, setSelectedGraphRoomId] = useState(room.id)
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [createRelationOpen, setCreateRelationOpen] = useState(false)

  useEffect(() => {
    setSelectedGraphRoomId(room.id)
    setSelectedRelationId(null)
    setInspectorOpen(true)
  }, [room.id])

  const nodeIds = useMemo(() => new Set(graph?.nodes.map((node) => node.id) ?? [room.id]), [graph?.nodes, room.id])
  const graphRooms = useMemo(() => rooms.filter((candidate) => nodeIds.has(candidate.id)), [nodeIds, rooms])
  // 证据行跳转用的资源库：关系两端的共享来源属于本 Room，云文档/上传文件可点开。
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room],
  )
  const selectedRoom = graphRooms.find((candidate) => candidate.id === selectedGraphRoomId) ?? room
  const selectedRelation = graph?.edges.find((edge) => edge.id === selectedRelationId) ?? null
  const relationToSelected = selectedRoom.id === room.id ? null : graph?.edges.find((edge) => (
    (edge.sourceRoomId === room.id && edge.targetRoomId === selectedRoom.id)
      || (edge.targetRoomId === room.id && edge.sourceRoomId === selectedRoom.id)
  )) ?? null
  const hasRelations = Boolean(graph?.edges.length)

  return (
    <div className={`context-room-related-rooms-pane${hasRelations ? '' : ' is-empty'}${selectedRelation || inspectorOpen ? ' has-inspector' : ''}`}>
      <section className="context-room-related-graph">
        <header>
          <div><span>{room.title}</span></div>
          <div className="context-room-related-graph-actions">
            <span className="context-room-graph-index-state" data-status={error ? 'degraded' : graph?.indexing.status ?? 'building'}>
              {error ? t('contextRoom:relations.indexDegraded') : graph?.indexing.status === 'building'
                ? t('contextRoom:relations.indexBuilding', { count: graph.indexing.pendingSources })
                : t('contextRoom:relations.indexReady')}
            </span>
            <button type="button" aria-pressed={visibility === 'hidden'} title={t('contextRoom:relations.showHidden')} onClick={() => setVisibility((value) => value === 'active' ? 'hidden' : 'active')}>
              {t(visibility === 'hidden' ? 'contextRoom:relations.showActive' : 'contextRoom:relations.showHidden')}
            </button>
            <button type="button" aria-label={t('contextRoom:relations.newRelation')} title={t('contextRoom:relations.newRelation')} onClick={() => setCreateRelationOpen(true)}><Link2 aria-hidden="true" /></button>
          </div>
        </header>
        <div className="context-room-related-graph-canvas">
          {loading && !graph ? <div className="context-room-graph-state">{t('contextRoom:relations.loadingGraph')}</div> : hasRelations ? (
            <RoomGraphCanvas
              compact
              rooms={graphRooms}
              relations={graph?.edges ?? []}
              selectedId={selectedGraphRoomId}
              selectedRelationId={selectedRelationId}
              // 不设按钮：缩放/拖拽后鼠标静止满 5 秒，弹性补间回自适应视野。
              autoFitOnIdleMs={RELATIONS_AUTO_FIT_IDLE_MS}
              onSelectRoom={(roomId) => { setSelectedRelationId(null); setSelectedGraphRoomId(roomId ?? room.id); setInspectorOpen(Boolean(roomId)) }}
              onSelectRelation={(relationId) => { setSelectedRelationId(relationId); setSelectedGraphRoomId(room.id); setInspectorOpen(Boolean(relationId)) }}
              onOpenRoom={onOpenRoom}
            />
          ) : (
            <PanelEmptyState
              icon={Network}
              title={t(visibility === 'hidden' ? 'contextRoom:relations.noHiddenRelations' : 'contextRoom:relations.noRelatedRoomsYet')}
              description={t(error ? 'contextRoom:relations.degradedNoSyntheticEdges' : 'contextRoom:relations.noEvidenceBackedRelations')}
            />
          )}
        </div>
      </section>

      {selectedRelation ? (
        <RoomRelationInspector
          relation={selectedRelation}
          rooms={rooms}
          resources={library.resources}
          onSelectResource={onSelectResource}
          onClose={() => setSelectedRelationId(null)}
          onChanged={reload}
        />
      ) : inspectorOpen ? (
        <RoomNodeInspector
          room={selectedRoom}
          contextLabel={t(selectedRoom.id === room.id ? 'contextRoom:relations.currentRoom' : 'contextRoom:relations.relatedRoom')}
          relationshipSummary={relationToSelected ? `${relationTypeLabel(relationToSelected.type, t)} · ${t('contextRoom:relations.scoreValue', { score: relationToSelected.score.toFixed(2) })}` : t('contextRoom:relations.centerOfTheCurrentGraph')}
          onClose={() => setInspectorOpen(false)}
          onOpenRoom={selectedRoom.id === room.id ? undefined : onOpenRoom}
        />
      ) : null}

      <CreateRoomRelationDialog
        open={createRelationOpen}
        fromRoomId={room.id}
        rooms={rooms}
        onOpenChange={setCreateRelationOpen}
        onCreated={async (relation) => { await reload(); setSelectedRelationId(relation.id) }}
      />
    </div>
  )
}
