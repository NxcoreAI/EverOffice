import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { SubagentInvocation } from '@nxcore/agent-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RoomContextDigest } from '../src/modules/context-rooms/room-context-digest.js'
import type { SubagentOrchestrator } from '../src/modules/subagents/orchestrator.js'
import type { SubagentRegistry } from '../src/modules/subagents/registry.js'
import { createSubagentPiTools } from '../src/modules/subagents/tools.js'
import type { SlidesStyleStageDeps } from '../src/modules/subagents/slides-style-stage.js'
import type { SlidesStyleImageGenerator } from '../src/modules/slides-style/image-gen.js'
import { SlidesStyleSessionStore } from '../src/modules/slides-style/style-session.js'
import type { DatabaseClient } from '../src/infrastructure/database/client.js'
import { createDatabase } from '../src/infrastructure/database/client.js'

function registryWith(agentIds: string[]): SubagentRegistry {
  return {
    get: (id: string) => (agentIds.includes(id) ? { id } : null),
    listAvailable: () => [],
    listAll: () => [],
  } as unknown as SubagentRegistry
}

function orchestratorReturning(invocation: Partial<SubagentInvocation>): SubagentOrchestrator & {
  dispatch: ReturnType<typeof vi.fn>
} {
  return {
    dispatch: vi.fn(async () => ({
      id: 'invocation-1',
      agentDefinitionId: 'content-analyst',
      agentRevisionId: 'revision-1',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
      task: '分析指定 Context Room 的资料并提炼可核验结论',
      input: null,
      status: 'completed',
      result: { text: '' },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...invocation,
    })),
  } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
}

const run = { runId: 'run-1', sessionId: 'session-1' }

/** 与 buildRoomContextDigest 返回结构同构的最小投影夹具。 */
const digestFixture: RoomContextDigest = {
  roomId: 'room-1',
  room: {
    title: '校园活动 Room',
    kind: '项目',
    brief: { background: '筹备社团学期活动' },
    timeline: [],
  },
  facts: [{
    factId: 'fact-1',
    content: '社团已登记',
    type: '属性',
    sourceKind: 'everroom-doc',
    sourceId: 'doc-1',
    sourceTitle: '活动登记表',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  entities: [],
  appliedCorrections: [],
  localActions: [],
  documentCount: 1,
  documents: [{
    documentId: 'doc-1',
    title: '活动登记表',
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    markdown: '社团已登记，负责人已确认场地。',
    truncated: false,
  }],
}

describe('createSubagentPiTools room_correction_draft', () => {
  const claimContext = {
    claims: [
      {
        claimId: 'claim-1',
        section: 'overview' as const,
        text: '社团已登记并确认场地。',
        origin: 'fact',
        corrected: false,
        evidence: [{ sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '活动登记表' }],
      },
      {
        claimId: 'claim-2',
        section: 'next_steps' as const,
        text: '下一步发布评审通知。',
        origin: 'inference',
        corrected: true,
        evidence: [],
      },
    ],
  }

  it('registers only when room-corrector exists; citation 路径组装 claims 并透传 edits', async () => {
    const withCorrector = createSubagentPiTools(
      registryWith(['room-corrector']),
      orchestratorReturning({}) as never,
      { resolveRoomCorrectionContext: () => claimContext },
    )
    expect(withCorrector.map((tool) => tool.name)).toContain('room_correction_draft')
    expect(createSubagentPiTools(registryWith([]), orchestratorReturning({}))
      .map((tool) => tool.name)).not.toContain('room_correction_draft')

    const orchestrator = orchestratorReturning({
      result: {
        text: '',
        structuredOutput: {
          kind: 'citation-correction',
          edits: [{
            operation: 'content_replace',
            section: 'overview',
            targetClaimId: 'claim-1',
            originalText: '社团已登记并确认场地。',
            replacementText: '社团已完成登记、付款与场地确认。',
            rationale: '按用户评论补充付款状态',
          }],
          summary: '修正了 overview 的一条 claim',
        },
      },
    })
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestrator, {
      resolveRoomCorrectionContext: () => claimContext,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    const result = await tool.execute(
      { ...run, roomId: 'room-1', responseLanguage: 'zh-CN' } as never,
      {
        task: 'citation-correction',
        instruction: '场地已经确认了，也付过款了',
        selectedText: '【引用】claim-1 社团已登记并确认场地。【用户评论】补充付款',
      } as never,
      undefined,
    )

    const dispatched = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatched).toMatchObject({ agentId: 'room-corrector', task: '计算总览引用纠正', source: 'primary_agent' })
    const input = dispatched.input as Record<string, unknown>
    expect(input.task).toBe('citation-correction')
    expect(input.selectedText).toContain('社团已登记')
    // 网关组装：claims 快照原样进入（含 nextSteps→next_steps 的 section 映射在 resolver 侧完成）。
    expect(input.claims).toEqual(claimContext.claims)
    expect(input.responseLanguage).toBe('zh-CN')

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'completed',
      kind: 'citation-correction',
      roomId: 'room-1',
      edits: [{ operation: 'content_replace', targetClaimId: 'claim-1' }],
      summary: '修正了 overview 的一条 claim',
    })
  })

  it('general-correction 返回 proposal；citation 缺 selectedText 直接拒绝', async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: '',
        structuredOutput: {
          kind: 'general-correction',
          proposal: {
            operation: 'content_replace',
            section: 'overview',
            targetClaimId: 'claim-2',
            originalText: '下一步发布评审通知。',
            replacementText: '下一步完成发布评审并归档结论。',
            rationale: '用户要求更新建议',
          },
          summary: '更新了 next_steps 建议',
        },
      },
    })
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestrator, {
      resolveRoomCorrectionContext: () => claimContext,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    const result = await tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'general-correction',
      instruction: '更新建议下一步',
    } as never, undefined)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.proposal).toMatchObject({ operation: 'content_replace', section: 'overview' })

    await expect(tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'citation-correction',
      instruction: '改一下',
    } as never, undefined)).rejects.toThrow('room_correction_draft_selected_text_required')
  })

  it('room 不存在与并发拒绝的失败语义', async () => {
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestratorReturning({}), {
      resolveRoomCorrectionContext: () => null,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    await expect(tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'general-correction',
      instruction: 'x',
    } as never, undefined)).rejects.toThrow('context_room_not_found')
  })
})

describe('createSubagentPiTools room_analysis', () => {
  it('registers room_analysis only when the content-analyst agent exists', () => {
    const withAnalyst = createSubagentPiTools(
      registryWith(['content-analyst']),
      orchestratorReturning({}),
    )
    expect(withAnalyst.map((tool) => tool.name)).toContain('room_analysis')

    const withoutAnalyst = createSubagentPiTools(registryWith([]), orchestratorReturning({}))
    expect(withoutAnalyst.map((tool) => tool.name)).not.toContain('room_analysis')

    // 分析任务合并（方案 §4.2）：调度目标已换为 content-analyst，
    // 仅存在 context-room 时不再注册 room_analysis。
    const onlyRoom = createSubagentPiTools(registryWith(['context-room']), orchestratorReturning({}))
    expect(onlyRoom.map((tool) => tool.name)).not.toContain('room_analysis')
  })

  it('assembles the room digest as content and dispatches content-analyst', async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: `分析结论：\n\`\`\`json\n${JSON.stringify({
          summary: 'Room 资料围绕校园活动展开',
          facts: [{ content: '社团已登记', source: '活动登记表' }],
          risks: [],
          gaps: ['缺少预算材料'],
          nextSteps: ['补充预算'],
        })}\n\`\`\``,
      },
    })
    const tools = createSubagentPiTools(registryWith(['content-analyst']), orchestrator, {
      resolveRoomContext: async () => digestFixture,
    })
    const roomAnalysis = tools.find((tool) => tool.name === 'room_analysis')!

    const result = await roomAnalysis.execute(run as never, {
      roomId: 'room-1',
      focus: ' 关注预算 ',
      responseLanguage: ' zh-CN ',
    } as never, undefined)

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatchInput = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatchInput).toMatchObject({
      agentId: 'content-analyst',
      task: '分析指定 Context Room 的资料并提炼可核验结论',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
    })
    const input = dispatchInput.input as Record<string, unknown>
    expect(input.sourceLabel).toBe('校园活动 Room')
    expect(String(input.question)).toContain('关注预算')
    expect(String(input.question)).toContain('zh-CN')
    // content 为网关侧组装的 Room 材料纯文本：房间头 + 文档 markdown + 事实清单。
    expect(String(input.content)).toContain('【Room】校园活动 Room')
    expect(String(input.content)).toContain('### 活动登记表')
    expect(String(input.content)).toContain('社团已登记，负责人已确认场地。')
    expect(String(input.content)).toContain('【结构化事实】')
    expect(String(input.content)).toContain('- 社团已登记（来源：活动登记表）')
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      invocationId: 'invocation-1',
      agentId: 'content-analyst',
      status: 'completed',
      analysis: {
        summary: 'Room 资料围绕校园活动展开',
        facts: [{ content: '社团已登记', source: '活动登记表' }],
        gaps: ['缺少预算材料'],
        nextSteps: ['补充预算'],
      },
    })
  })

  it('fails fast when the room digest resolver is missing or finds no room', async () => {
    const withoutResolver = createSubagentPiTools(registryWith(['content-analyst']), orchestratorReturning({}))
    const roomAnalysis = withoutResolver.find((tool) => tool.name === 'room_analysis')!
    await expect(
      roomAnalysis.execute(run as never, { roomId: 'room-1' } as never, undefined),
    ).rejects.toThrow('room_analysis_room_context_unavailable')

    const withNullResolver = createSubagentPiTools(
      registryWith(['content-analyst']),
      orchestratorReturning({}),
      { resolveRoomContext: async () => null },
    )
    const nullRoomAnalysis = withNullResolver.find((tool) => tool.name === 'room_analysis')!
    await expect(
      nullRoomAnalysis.execute(run as never, { roomId: 'missing-room' } as never, undefined),
    ).rejects.toThrow('context_room_not_found')
  })
})

describe('createSubagentPiTools slides_draft', () => {
  /** draft/generate 两阶段串接：按 agentId 返回各自的 invocation 夹具；builder 生成 invocationId 时回调 onInvocationId。 */
  function orchestratorByAgent(handlers: Record<string, Partial<SubagentInvocation>>): SubagentOrchestrator & {
    dispatch: ReturnType<typeof vi.fn>
  } {
    return {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        input.onInvocationId?.(invocationId)
        return {
          id: invocationId,
          agentDefinitionId: input.agentId,
          agentRevisionId: 'revision-1',
          source: 'primary_agent',
          parentSessionId: 'session-1',
          parentRunId: 'run-1',
          task: '演示文稿',
          input: null,
          status: 'completed',
          result: { text: '' },
          errorCode: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          ...handlers[input.agentId],
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
  }

  const planFixture = {
    phase: 'draft',
    title: '季度汇报',
    narrative: '业绩回顾到下一步计划',
    pages: [
      { title: '封面', points: ['季度汇报'], materialHints: '简洁封面' },
      { title: '业绩', role: 'data', points: ['营收增长'], data: 'Q1: 1.2 亿；Q2: 1.5 亿' },
      { title: '计划', points: ['三线扩张'] },
    ],
    warnings: [],
    summary: '3 页方案',
  }

  const builderResultFixture = {
    status: 'completed',
    fileEntryId: 'file-1',
    fileName: '季度汇报.pptx',
    pages: 3,
    outline: ['封面', '业绩', '计划'],
    warnings: [],
    summary: '已生成 3 页',
  }

  /** generate 阶段读回草稿的文档快照夹具（与 readDocumentForAgent 同构）。 */
  const draftSnapshot = {
    document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
    blocks: [],
    markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：Q1: 1.2 亿；Q2: 1.5 亿\n\n## 计划\n- 三线扩张\n',
  }

  it('draft：planner 产内容草稿 → 服务端落成草稿文档即停（draft_ready），不调度落页代理', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: planFixture } },
    })
    const createSlidesDraftDocument = vi.fn(async (_input: { roomId: string; title: string; markdown: string }) => ({
      documentId: 'doc-draft-1',
      title: '季度汇报',
    }))
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      createSlidesDraftDocument,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      {
        task: 'draft',
        instruction: '做一份 3 页的季度汇报',
        title: '季度汇报',
        outline: ['封面', '业绩', '计划'],
      } as never,
      undefined,
      onUpdate,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch).toMatchObject({ agentId: 'slides-planner', source: 'primary_agent' })
    expect(plannerDispatch.task).toBe('演示文稿内容草稿')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({
      phase: 'draft',
      instruction: '做一份 3 页的季度汇报',
      roomId: 'room-1',
      title: '季度汇报',
    })
    expect(plannerInput.outline).toEqual(['封面', '业绩', '计划'])

    expect(createSlidesDraftDocument).toHaveBeenCalledTimes(1)
    const draftInput = createSlidesDraftDocument.mock.calls[0]![0] as Record<string, unknown>
    expect(draftInput).toMatchObject({ roomId: 'room-1', title: '季度汇报' })
    expect(String(draftInput.markdown)).toContain('## 业绩')
    expect(String(draftInput.markdown)).toContain('数据：Q1: 1.2 亿；Q2: 1.5 亿')

    // 草稿实时可见：draft_ready 带全量页清单与文档定位。
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const update = onUpdate.mock.calls[0]![0] as { details: Record<string, unknown> }
    expect(update.details).toMatchObject({
      stage: 'draft_ready',
      title: '季度汇报',
      totalPages: 3,
      doneCount: 0,
      documentId: 'doc-draft-1',
    })

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'draft_ready',
      documentId: 'doc-draft-1',
      documentTitle: '季度汇报',
      pages: 3,
    })
  })

  it('generate：读回确认稿 → arrange 编排 → builder 一口气落页（进度器布防、两跳成链）', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: planFixture.pages.map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const trashDraft = vi.fn(async () => {})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      {
        task: 'generate',
        instruction: '受众是领导，15 分钟，内容均衡',
        draftDocumentId: 'doc-draft-1',
      } as never,
      undefined,
      onUpdate,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(2)
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch.task).toBe('演示文稿编排')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({ phase: 'arrange', roomId: 'room-1', title: '季度汇报' })
    expect((plannerInput.draftPages as Array<Record<string, unknown>>)[1]).toMatchObject({
      title: '业绩',
      data: 'Q1: 1.2 亿；Q2: 1.5 亿',
    })
    // 预设风格字段已拆除（af1c1dac）：风格倾向走 instruction，不再有 style 入参。
    expect(plannerInput.style).toBeUndefined()

    const builderDispatch = orchestrator.dispatch.mock.calls[1]![0] as Record<string, unknown>
    expect(builderDispatch).toMatchObject({ agentId: 'slides-builder', source: 'primary_agent' })
    // 两跳串接成链：落页调用挂靠编排调用之下，时间线据此呈现先后依赖。
    expect(builderDispatch.parentRunId).toBe('invocation-plan')
    const builderInput = builderDispatch.input as Record<string, unknown>
    expect(builderInput).toMatchObject({
      task: 'create',
      title: '季度汇报',
    })
    expect(builderInput.plan).toEqual(arrangePlan)

    // plan_ready + 逐页进度：编排方案一出即透传，落页进度经布防的转发器广播。
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages[0]).toBe('plan_ready')

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      task: 'create',
      status: 'completed',
      fileEntryId: 'file-1',
      fileName: '季度汇报.pptx',
      pages: 3,
      summary: '已生成 3 页',
    })

    // 级联清理：落页完成即回收内容草稿（进回收站）。
    expect(trashDraft).toHaveBeenCalledTimes(1)
    expect(trashDraft).toHaveBeenCalledWith('doc-draft-1')
  })

  it('generate：落页部分完成时草稿保留（便于重试），不回收', async () => {
    const arrangePlan = {
      phase: 'arrange',
      title: '季度汇报',
      pages: [{ title: '封面', role: 'opening', density: 'sparse', points: ['季度汇报'] }],
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': {
        result: {
          text: '',
          structuredOutput: { ...builderResultFixture, status: 'partial', summary: '已生成 2 页，第 3 页失败' },
        },
      },
    })
    const trashDraft = vi.fn(async () => {})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'partial' })
    expect(trashDraft).not.toHaveBeenCalled()
  })

  it('generate：缺少 draftDocumentId 或草稿解析不到页结构即返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => ({ ...draftSnapshot, markdown: '被清空的文档' }),
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const missingId = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成' } as never,
      undefined,
    )
    expect(JSON.parse((missingId as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_draft_document_required',
    })

    const emptyDraft = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    expect(JSON.parse((emptyDraft as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_draft_document_empty',
    })
    expect(orchestrator.dispatch).not.toHaveBeenCalled()
  })

  it('generate：编排阶段失败即返回 failed，不发生落页调度', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': {
        status: 'timed_out',
        errorCode: 'timeout',
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '做一份季度汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', retryable: true })
    expect(payload.message).toContain('编排阶段未完成')
  })

  it('generate：方案代理未注册时返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '做一份季度汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).not.toHaveBeenCalled()
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', errorCode: 'slides_planner_not_registered' })
  })

  it('edit：不经方案阶段直落 slides-builder；fileId 缺省不进 input；roomId 冲突与缺失直接拒绝', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    await expect(
      slidesDraft.execute({ ...run, roomId: 'room-1' } as never, { task: 'edit', instruction: '字号调大', roomId: 'room-2' } as never, undefined),
    ).rejects.toThrow('ROOM_SELECTION_MISMATCH')

    await expect(
      slidesDraft.execute(run as never, { task: 'edit', instruction: '字号调大' } as never, undefined),
    ).rejects.toThrow('ROOM_SELECTION_REQUIRED')

    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'edit', instruction: '字号调大', style: 'boardroom' } as never,
      undefined,
    )
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatched = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatched).toMatchObject({ agentId: 'slides-builder', source: 'primary_agent' })
    const input = dispatched.input as Record<string, unknown>
    expect(input).toMatchObject({ task: 'edit', instruction: '字号调大', roomId: 'room-1' })
    expect(input.fileId).toBeUndefined()
    expect(input.style).toBeUndefined()

    expect(
      createSubagentPiTools(registryWith([]), orchestratorReturning({})).some((tool) => tool.name === 'slides_draft'),
    ).toBe(false)
  })
})

describe('createSubagentPiTools slides_draft 风格阶段', () => {
  const stylePlanParams = {
    palette: {
      background: '#f5f2ec', surface: '#faf9f6', primary: '#1e3a5f', accent: '#e0a03c',
      text: '#2f2b28', textMuted: '#8f8a81', onDarkText: '#f2f4f7',
      chartSeries: ['#1e3a5f', '#5a6f8a', '#8fa1b8', '#e0a03c', '#e8bd88'],
    },
    typography: {
      fontHeading: 'PingFang SC', fontBody: 'PingFang SC',
      sizes: { coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 18, body: 14, caption: 11, kpi: 44, table: 13 },
      headingBold: true,
    },
    spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 8 },
    decoration: { cardStroke: null, cardStrokeWidthPt: 0.75, cardShadow: 'none', divider: 'line', imageFit: 'cover' },
    motif: { kind: 'none', spec: {} },
    layoutHints: {},
    darkCover: true,
    effectLines: ['主色 深藏青 #1E3A5F'],
  }

  function syntheticOverviewPng(): Buffer {
    const canvas = createCanvas(320, 180)
    const context = canvas.getContext('2d')
    context.fillStyle = '#f5f2ec'
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#1e3a5f'
    context.fillRect(0, 0, 320, 52)
    context.fillStyle = '#e0a03c'
    context.fillRect(248, 70, 56, 100)
    return canvas.toBuffer('image/png')
  }

  const databases: DatabaseClient[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close())
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function setupStyleDeps(options: {
    settleOutput?: Record<string, unknown> | null
    directionOutput?: Record<string, unknown> | null
  } = {}): Promise<{
    deps: SlidesStyleStageDeps
    orchestrator: SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    generateImages: ReturnType<typeof vi.fn>
    saveDemoPng: ReturnType<typeof vi.fn>
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-style-stage-test-'))
    temporaryDirectories.push(dir)
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    databases.push(database)
    const generateImages = vi.fn(async (input: { count: number; idempotencyKey: string }) =>
      Array.from({ length: input.count }, (_, index) => ({
        contentHash: `${input.idempotencyKey}:${String(index)}`.padEnd(64, '0').slice(0, 64),
        fileEntryId: `entry-${String(index)}`,
      })))
    const saveDemoPng = vi.fn(async () => ({ contentHash: 'd'.repeat(64), fileEntryId: 'demo-entry' }))
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateOverviewImages: generateImages } as unknown as SlidesStyleImageGenerator,
      vlm: {
        model: 'test-vlm',
        analyze: async () => ({ serif: false, weight: 'bold', geometric: 'neutral', rounded: false }),
      },
      readMaterialBytes: async () => ({ buffer: syntheticOverviewPng(), mime: 'image/png' }),
      demoRenderer: {
        renderPptx: async () => {
          throw new Error('office_bridge_unavailable')
        },
      },
      saveDemoPng,
    }
    const dispatchHandlers: Record<string, Partial<SubagentInvocation>> = {
      'slides-styler': {
        result: {
          text: '',
          structuredOutput: options.settleOutput ?? options.directionOutput ?? null,
        },
      },
    }
    const orchestrator = {
      dispatch: vi.fn(async (input: { agentId: string; task?: string; input?: { task?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = `invocation-${input.agentId}`
        input.onInvocationId?.(invocationId)
        if (input.agentId === 'slides-styler' && input.input?.task === 'settle') {
          return {
            id: 'invocation-styler', agentDefinitionId: 'slides-styler', agentRevisionId: 'r1',
            source: 'primary_agent', parentSessionId: 'session-1', parentRunId: 'run-1',
            task: '风格参数复核', input: null, status: 'completed',
            result: { text: '', structuredOutput: { task: 'settle', styleParams: stylePlanParams, notes: '' } },
            errorCode: null, errorMessage: null,
            createdAt: '', startedAt: '', completedAt: '',
          }
        }
        return {
          id: 'invocation-styler', agentDefinitionId: 'slides-styler', agentRevisionId: 'r1',
          source: 'primary_agent', parentSessionId: 'session-1', parentRunId: 'run-1',
          task: '纵览图生图提示词', input: null, status: 'completed',
          result: { text: '', structuredOutput: options.directionOutput ?? null },
          errorCode: null, errorMessage: null,
          createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    void dispatchHandlers
    return { deps, orchestrator, generateImages, saveDemoPng }
  }

  it('style：styler 出提示词 → 生图 → 广播挑图卡并落库会话', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: { task: 'direction', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，顶部标题区用灰色假字条……'.repeat(2), styleBrief: '深色科技' },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      slidesStyle: deps,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )

    const payload = JSON.parse(result.content as string) as { status: string; styleSessionId: string; candidates: number }
    expect(payload.status).toBe('style_images_ready')
    expect(payload.candidates).toBe(3)
    const broadcast = onUpdate.mock.calls.at(-1)?.[0] as { details: { stage: string; candidates: Array<{ url: string }> } }
    expect(broadcast.details.stage).toBe('style_images_ready')
    expect(broadcast.details.candidates).toHaveLength(3)
    expect(broadcast.details.candidates[0]?.url.startsWith('everroom-material://')).toBe(true)
    expect(generateImages).toHaveBeenCalledTimes(1)
    const session = deps.sessions.byId(payload.styleSessionId)
    expect(session?.stage).toBe('images_ready')
    expect(session?.draftDocumentId).toBe('doc-draft-1')
  })

  it('style 重入：活跃挑图会话 + 新反馈 → 反馈累积、轮次 +1、重出候选', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: { task: 'direction', imagePrompt: '一张深色科技风 PPT 风格参考图，版式完整……'.repeat(2), styleBrief: '' },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const first = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const firstPayload = JSON.parse(first.content as string) as { styleSessionId: string }

    const second = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '不要太蓝，要更商务' } as never,
      undefined, undefined,
    )
    const secondPayload = JSON.parse(second.content as string) as { styleSessionId: string; generation: number }
    expect(secondPayload.styleSessionId).toBe(firstPayload.styleSessionId)
    expect(secondPayload.generation).toBe(2)
    const session = deps.sessions.byId(secondPayload.styleSessionId)
    expect(session?.feedback).toEqual(['不要太蓝，要更商务'])
    const secondCall = generateImages.mock.calls[1]?.[0] as { idempotencyKey: string }
    expect(secondCall.idempotencyKey).toContain(':gen:2')
  })

  it('style_select：提取+复核+降级演示页 → 风格卡就绪；坏序号被拒', async () => {
    const { deps, orchestrator, saveDemoPng } = await setupStyleDeps()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }

    const bad = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 9 } as never,
      undefined, undefined,
    )
    expect((JSON.parse(bad.content as string) as { status: string }).status).toBe('failed')

    const onUpdate = vi.fn()
    const selected = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 2 } as never,
      undefined, onUpdate,
    )
    const payload = JSON.parse(selected.content as string) as { status: string; warnings?: string[] }
    expect(payload.status).toBe('style_card_ready')
    // 桌面渲染不可用 → 演示页降级（仍有风格卡），提示入 warnings。
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining('演示页渲染')]))
    expect(saveDemoPng).not.toHaveBeenCalled()
    const broadcast = onUpdate.mock.calls.at(-1)?.[0] as { details: { stage: string; swatches: Array<{ hex: string }>; demoImageUrl: string | null } }
    expect(broadcast.details.stage).toBe('style_card_ready')
    expect(broadcast.details.swatches[1]?.hex).toBe('#1e3a5f')
    expect(broadcast.details.demoImageUrl).toBeNull()
    const session = deps.sessions.byId(styleSessionId)
    expect(session?.stage).toBe('card_ready')
    expect(session?.styleParams?.palette.primary).toBe('#1e3a5f')
  })

  it('generate：带 styleSessionId 时 builder 输入注入 styleParams；未到风格卡阶段的会话被拒', async () => {
    const { deps, orchestrator } = await setupStyleDeps()
    const planFixture = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: [{ title: '封面', role: 'cover', density: 'sparse', points: ['季度汇报'] },
        { title: '业绩', role: 'data', density: 'dense', points: ['增长'], data: 'bar | categories: Q1, Q2 | 营收: 1, 2' }],
      warnings: [], summary: '',
    }
    const buildResult = { status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx', pages: 2, outline: ['封面', '业绩'], warnings: [], summary: 'ok' }
    const orchestratorTwo = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { task?: string; phase?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        input.onInvocationId?.(invocationId)
        const result = input.agentId === 'slides-planner'
          ? { text: '', structuredOutput: planFixture }
          : { text: '', structuredOutput: buildResult }
        return {
          id: invocationId, agentDefinitionId: input.agentId, agentRevisionId: 'r1', source: 'primary_agent',
          parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
          result, errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    void orchestrator
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorTwo, {
      slidesStyle: deps,
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    // 会话还在 images_ready → 拒绝。
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    const early = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(early.content as string) as { errorCode: string }).errorCode).toBe('slides_style_session_invalid')

    // 走到 card_ready → generate 注入 styleParams 给 builder。
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )
    const generated = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(generated.content as string) as { status: string }).status).toBe('completed')
    const builderCall = (orchestratorTwo.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => (call[0] as { agentId: string }).agentId === 'slides-builder')
    const builderInput = (builderCall?.[0] as { input?: { styleParams?: { palette: { primary: string } } } }).input
    expect(builderInput?.styleParams?.palette.primary).toBe('#1e3a5f')
    expect(deps.sessions.byId(styleSessionId)?.stage).toBe('confirmed')
  })
})
