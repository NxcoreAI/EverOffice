import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { DocumentEvent, TiptapJsonContent } from '@nxcore/agent-contract'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  contextRooms,
  jobs,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  rooms,
  roomSourceMemberships,
  routeDecisions,
  documents,
} from '../src/infrastructure/database/schema.js'
import Fastify from 'fastify'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { documentRoutes } from '../src/modules/documents/routes.js'
import { DocumentService } from '../src/modules/documents/service.js'
import { KnowledgeService, type KnowledgeServiceConfig } from '../src/modules/knowledge/service.js'

const temporaryDirectories: string[] = []
const disposables: Array<() => void | Promise<void>> = []

const contentJson: TiptapJsonContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '季度复盘草稿' }] }],
}

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-document-move-test-'))
  temporaryDirectories.push(dataDir)
  const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  for (const [id, title] of [['room-1', '旧房'], ['room-2', '新房']] as const) {
    db.insert(contextRooms).values({ id, title, data: {}, position: 0 }).run()
    db.insert(rooms).values({ id, title, kind: '议题' }).run()
  }
  const broker = new DocumentEventBroker()
  const service = new DocumentService(db, broker)
  const events: DocumentEvent[] = []
  broker.listen((event) => events.push(event))
  const knowledge = new KnowledgeService(db, {
    baseUrl: '',
    serviceId: 'everroom',
    teamId: 'everroom',
    dataDir,
    roomWikisEnabled: false,
    ingestDebounceMs: 600_000,
    routerEnabled: false,
    entityPromoteScore: 2.4,
    entityPromoteSources: 3,
    mergeAutoDice: 0.75,
    mergeJudgeDice: 0.6,
    llm: null,
    embeddingLlm: null,
    embeddingModel: '',
  } satisfies KnowledgeServiceConfig, { info: () => undefined, warn: () => undefined, error: () => undefined })
  service.onDocumentMoved = (moved) => knowledge.handleDocumentMoved({
    documentId: moved.documentId,
    fromRoomId: moved.fromRoomId,
    toRoomId: moved.toRoomId,
  })
  disposables.push(() => {
    sqlite.close()
  })
  return { db, service, events }
}

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((dispose) => dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Room 产物移动到其他 Room', () => {
  it('切换归属链接并广播两房事件：源房摘除、目标房新增', async () => {
    const { db, service, events } = await createHarness()
    const document = await service.import({
      id: 'doc-move-1',
      roomId: 'room-1',
      title: '季度复盘',
      contentJson,
      origin: 'native',
    })

    const moved = await service.moveToRoom(document.id, { fromRoomId: 'room-1', roomId: 'room-2' })

    expect(moved.fromRoomId).toBe('room-1')
    expect(moved.toRoomId).toBe('room-2')
    expect(moved.document.roomId).toBe('room-2')
    expect(service.list('room-1').map((item) => item.id)).not.toContain(document.id)
    expect(service.list('room-2').map((item) => item.id)).toContain(document.id)
    expect(service.get(document.id)?.roomId).toBe('room-2')

    const movedEvent = events.find((event) => event.type === 'document.moved')
    expect(movedEvent?.roomId).toBe('room-1')
    expect((movedEvent?.payload as { toRoomId?: string }).toRoomId).toBe('room-2')
    const targetEvent = events.find((event) =>
      event.type === 'document.changed' && event.roomId === 'room-2')
    expect((targetEvent?.payload as { document?: { roomId?: string } }).document?.roomId).toBe('room-2')
  })

  it('同步迁移来源成员关系、实体提及、事实与路由决策', async () => {
    const { db, service } = await createHarness()
    const document = await service.import({
      id: 'doc-move-2',
      roomId: 'room-1',
      title: '客户访谈纪要',
      contentJson,
      origin: 'native',
    })
    db.insert(roomSourceMemberships).values({
      id: 'membership-1',
      roomId: 'room-1',
      sourceKind: 'everroom-doc',
      sourceId: document.id,
      sourceVersion: document.version,
      evidenceGroupKey: 'everroom-doc:doc-move-2',
      role: 'entry',
      effectiveWeight: 1,
      qualityLevel: 'high',
      trusted: true,
      entityIndexed: true,
    }).run()
    db.insert(roomEntityMentions).values({
      id: 'mention-1',
      roomId: 'room-1',
      entityId: 'entity-customer',
      sourceKind: 'everroom-doc',
      sourceId: document.id,
      sourceVersion: document.version,
      evidenceGroupKey: 'everroom-doc:doc-move-2',
      salience: 0.9,
      relevanceFactor: 1,
      qualityLevel: 'high',
      trusted: true,
    }).run()
    db.insert(roomEntityFacts).values({
      id: 'fact-1',
      roomId: 'room-1',
      factId: 'fact-customer-renewal',
      content: '客户计划续约',
      type: '属性',
      sourceKind: 'everroom-doc',
      sourceId: document.id,
      sourceVersion: document.version,
      evidenceGroupKey: 'everroom-doc:doc-move-2',
    }).run()
    db.insert(routeDecisions).values({
      id: 'decision-1',
      sourceKind: 'everroom-doc',
      sourceId: document.id,
      sourceVersion: document.version,
      primaryRoomId: 'room-1',
      confidence: 1,
      decidedBy: 'entry',
      evidence: { rooms: [{ roomId: 'room-1' }] },
      status: 'auto',
    }).run()

    await service.moveToRoom(document.id, { fromRoomId: 'room-1', roomId: 'room-2' })

    const memberships = db.select().from(roomSourceMemberships)
      .where(and(
        eq(roomSourceMemberships.sourceKind, 'everroom-doc'),
        eq(roomSourceMemberships.sourceId, document.id),
      )).all()
    expect(memberships.map((row) => row.roomId)).toEqual(['room-2'])

    const mentions = db.select().from(roomEntityMentions)
      .where(and(
        eq(roomEntityMentions.sourceKind, 'everroom-doc'),
        eq(roomEntityMentions.sourceId, document.id),
      )).all()
    expect(mentions.map((row) => row.roomId)).toEqual(['room-2'])

    const facts = db.select().from(roomEntityFacts)
      .where(and(
        eq(roomEntityFacts.sourceKind, 'everroom-doc'),
        eq(roomEntityFacts.sourceId, document.id),
      )).all()
    expect(facts.map((row) => row.roomId)).toEqual(['room-2'])

    const decision = db.select().from(routeDecisions).where(eq(routeDecisions.id, 'decision-1')).get()
    expect(decision?.primaryRoomId).toBe('room-2')
    expect(decision?.linkedRoomIds ?? []).toEqual([])
    expect((decision?.evidence as { rooms?: Array<{ roomId: string }> }).rooms).toEqual([{ roomId: 'room-2' }])

    // 搜索索引重排入队（worker 从新归属重建 search_index_rooms）。
    const searchJobs = db.select().from(jobs).all()
      .filter((job) => JSON.stringify(job.payload).includes(document.id))
    expect(searchJobs.length).toBeGreaterThan(0)
  })

  it('拒绝同房移动、缺失目标房与回收站文档', async () => {
    const { service } = await createHarness()
    const document = await service.import({
      id: 'doc-move-3',
      roomId: 'room-1',
      title: '待整理',
      contentJson,
      origin: 'native',
    })

    await expect(service.moveToRoom(document.id, { fromRoomId: 'room-1', roomId: 'room-1' }))
      .rejects.toMatchObject({ code: 'SAME_ROOM' })
    await expect(service.moveToRoom(document.id, { fromRoomId: 'room-1', roomId: 'room-missing' }))
      .rejects.toMatchObject({ code: 'TARGET_ROOM_NOT_FOUND' })

    await service.delete(document.id)
    await expect(service.moveToRoom(document.id, { fromRoomId: 'room-1', roomId: 'room-2' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_TRASHED' })
  })

  it('批量预检发现未知文档时整批不执行', async () => {
    const { service } = await createHarness()
    await service.import({ id: 'doc-batch-ok', roomId: 'room-1', title: '可移动', contentJson, origin: 'native' })

    await expect(service.moveManyToRoom(['doc-batch-ok', 'doc-batch-missing'], {
      fromRoomId: 'room-1',
      roomId: 'room-2',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(service.list('room-1').map((item) => item.id)).toContain('doc-batch-ok')
    expect(service.list('room-2')).toHaveLength(0)
  })

  it('批量移动同源房多个产物到同一目标房', async () => {
    const { db, service } = await createHarness()
    const ids = ['doc-batch-1', 'doc-batch-2']
    for (const id of ids) {
      await service.import({ id, roomId: 'room-1', title: id, contentJson, origin: 'native' })
    }

    const result = await service.moveManyToRoom(ids, { fromRoomId: 'room-1', roomId: 'room-2' })

    expect(result.items.map((item) => item.documentId)).toEqual(ids)
    const links = db.select().from(roomDocumentLinks).all()
      .filter((link) => ids.includes(link.documentId))
    expect(links.map((link) => link.roomId)).toEqual(['room-2', 'room-2'])
    const stillOnSource = db.select().from(documents).all()
      .filter((row) => ids.includes(row.id) && row.deletedAt !== null)
    expect(stillOnSource).toHaveLength(0)
  })
})

describe('POST /v1/documents/:id/move', () => {
  it('按 REST 契约移动并返回移动后的文档；目标房缺失返回 404', async () => {
    const { service } = await createHarness()
    const document = await service.import({
      id: 'doc-route-1',
      roomId: 'room-1',
      title: '路由移动',
      contentJson,
      origin: 'native',
    })
    const app = Fastify()
    await app.register(documentRoutes(service))

    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents/${document.id}/move`,
      payload: { fromRoomId: 'room-1', roomId: 'room-2' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().toRoomId).toBe('room-2')
    expect(response.json().document.roomId).toBe('room-2')

    const missing = await app.inject({
      method: 'POST',
      url: `/v1/documents/${document.id}/move`,
      payload: { fromRoomId: 'room-2', roomId: 'room-missing' },
    })
    expect(missing.statusCode).toBe(404)

    const batch = await app.inject({
      method: 'POST',
      url: '/v1/documents/move',
      payload: { documentIds: [document.id], fromRoomId: 'room-2', roomId: 'room-1' },
    })
    expect(batch.statusCode).toBe(200)
    expect(batch.json().items).toHaveLength(1)
    await app.close()
  })
})
