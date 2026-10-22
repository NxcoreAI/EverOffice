import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { knowledgeRoutes } from '../src/modules/knowledge/routes.js'
import type { KnowledgeService } from '../src/modules/knowledge/service.js'

describe('knowledge room routes', () => {
  it('serves global and direct Room graphs without truncation', async () => {
    const nodes = Array.from({ length: 26 }, (_, index) => ({
      id: `room-${index}`,
      title: `Room ${index}`,
      kind: '项目',
      origin: 'user',
      updatedAt: new Date(0).toISOString(),
    }))
    const edges = Array.from({ length: 22 }, (_, index) => ({
      id: `relation-${index}`,
      sourceRoomId: 'room-0',
      targetRoomId: `room-${index + 1}`,
      directed: false,
      type: 'shared_evidence',
      origin: 'auto',
      score: 1.1,
      strength: 'weak',
      sharedSourceCount: 1,
      sharedEntityCount: 0,
      directMentionCount: 0,
      pinned: false,
      hidden: false,
      label: null,
      note: null,
      topReasons: [],
      updatedAt: new Date(0).toISOString(),
    }))
    const globalGraph = { revision: 7, generatedAt: new Date(0).toISOString(), indexing: { status: 'ready', pendingSources: 0 }, nodes, edges }
    const directGraph = { ...globalGraph, nodes: nodes.slice(0, 23) }
    const roomGraph = vi.fn().mockReturnValue(globalGraph)
    const roomRelations = vi.fn().mockReturnValue(directGraph)
    const service = { roomGraph, roomRelations } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const global = await app.inject({ url: '/v1/knowledge/room-graph' })
      expect(global.statusCode).toBe(200)
      expect(global.json().nodes).toHaveLength(26)
      expect(global.json().edges).toHaveLength(22)

      const direct = await app.inject({ url: '/v1/knowledge/rooms/room-0/relations?visibility=active' })
      expect(direct.statusCode).toBe(200)
      expect(direct.json().nodes).toHaveLength(23)
      expect(direct.json().edges).toHaveLength(22)
      expect(roomRelations).toHaveBeenCalledWith('room-0', 'active')
    } finally {
      await app.close()
    }
  })

  it('supports relation evidence and manual create, update, and removal APIs', async () => {
    const relation = {
      id: 'relation-1', sourceRoomId: 'room-a', targetRoomId: 'room-b', directed: true,
      type: 'blocks', origin: 'manual', score: 0, strength: 'weak', sharedSourceCount: 0,
      sharedEntityCount: 0, directMentionCount: 0, pinned: true, hidden: false,
      label: null, note: null, topReasons: [], updatedAt: new Date(0).toISOString(),
    }
    const roomRelationEvidence = vi.fn().mockReturnValue({ items: [], total: 0 })
    const createRoomRelation = vi.fn().mockReturnValue(relation)
    const updateRoomRelation = vi.fn().mockReturnValue({ ...relation, hidden: true })
    const removeManualRoomRelation = vi.fn().mockReturnValue(null)
    const service = {
      roomRelationEvidence,
      createRoomRelation,
      updateRoomRelation,
      removeManualRoomRelation,
    } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      expect((await app.inject({ url: '/v1/knowledge/room-relations/relation-1/evidence' })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/v1/knowledge/room-relations',
        payload: { fromRoomId: 'room-a', toRoomId: 'room-b', type: 'blocks', directed: true },
      })).statusCode).toBe(201)
      expect((await app.inject({
        method: 'PATCH', url: '/v1/knowledge/room-relations/relation-1', payload: { hidden: true },
      })).json()).toMatchObject({ hidden: true })
      expect((await app.inject({
        method: 'DELETE', url: '/v1/knowledge/room-relations/relation-1/manual',
      })).json()).toEqual({ relation: null })
    } finally {
      await app.close()
    }
  })

  it('exposes Room file version and update time in the artifact list DTO', async () => {
    // 版本可见性：目录文件带 vN + 最新版本时间；legacy 无版本链 → null（不伪造 v1）
    const listRoomFiles = vi.fn().mockReturnValue([
      {
        id: 'file-1', originalName: 'Q3方案.pptx', bytes: 1024, title: 'Q3方案',
        status: 'confirmed', decidedBy: 'resolution', confidence: null,
        sourceKind: 'agent-generated',
        uploadedAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-20T08:00:00.000Z'),
        versionNo: 3,
      },
      {
        id: 'file-legacy', originalName: '旧资料.md', bytes: 10, title: null,
        status: 'auto', decidedBy: 'llm', confidence: 0.8,
        sourceKind: 'legacy-upload',
        uploadedAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        versionNo: null,
      },
    ])
    const service = { listRoomFiles } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const response = await app.inject({ url: '/v1/knowledge/rooms/room-1/files' })
      expect(response.statusCode).toBe(200)
      const items = response.json().items as Array<Record<string, unknown>>
      expect(items).toHaveLength(2)
      expect(items[0]).toMatchObject({ id: 'file-1', versionNo: 3, updatedAt: '2026-10-20T08:00:00.000Z' })
      expect(items[1]).toMatchObject({ id: 'file-legacy', updatedAt: '2026-10-01T00:00:00.000Z' })
      // null 必须原样透出：客户端据此省略 v 段
      expect(items[1]!.versionNo).toBeNull()
      expect(listRoomFiles).toHaveBeenCalledWith('room-1')
    } finally {
      await app.close()
    }
  })

  it('treats deletion of an absent Room as an idempotent success', async () => {
    const deleteRoom = vi.fn().mockReturnValue(false)
    const service = { deleteRoom } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/knowledge/rooms/missing-room',
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe('')
      expect(deleteRoom).toHaveBeenCalledWith('missing-room')
    } finally {
      await app.close()
    }
  })

  it('accepts up to 20 recommendations and returns per-entity batch results', async () => {
    const promoteEntities = vi.fn().mockReturnValue([
      { entityId: 'ready-1', status: 'queued', jobId: 'job-1', error: null },
      { entityId: 'stale-1', status: 'rejected', jobId: null, error: 'recommendation_below_threshold' },
    ])
    const suppressEntities = vi.fn().mockReturnValue([
      { entityId: 'ready-1', status: 'suppressed', error: null },
    ])
    const service = { promoteEntities, suppressEntities } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const promoted = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-promote',
        payload: { entityIds: ['ready-1', 'stale-1'] },
      })
      expect(promoted.statusCode).toBe(202)
      expect(promoted.json().items).toHaveLength(2)
      expect(promoteEntities).toHaveBeenCalledWith(['ready-1', 'stale-1'])

      const suppressed = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-suppress',
        payload: { entityIds: ['ready-1'] },
      })
      expect(suppressed.statusCode).toBe(200)
      expect(suppressEntities).toHaveBeenCalledWith(['ready-1'])

      const tooMany = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-promote',
        payload: { entityIds: Array.from({ length: 21 }, (_, index) => `entity-${index}`) },
      })
      expect(tooMany.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
