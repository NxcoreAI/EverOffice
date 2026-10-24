import { describe, expect, it } from 'vitest'

import type { RuntimeConfigSnapshot } from '../../../shared/sources'

import {
  buildManualEntryPayload,
  buildUserPayload,
  formStateFromSnapshot,
  primaryFieldsFromSnapshot,
  runtimeConfigFormError,
  type ManualAiConfigFields,
  type RuntimeConfigFormState,
} from './runtimeConfigFormState'

function snapshot(userConfig: Record<string, unknown> | null): RuntimeConfigSnapshot {
  return {
    config: {},
    userConfig,
    source: userConfig ? 'user' : 'default',
    selectedSource: userConfig ? 'user' : 'default',
    availableSources: userConfig ? ['default', 'user'] : ['default'],
    configVersion: 1,
    updatedAt: '2026-10-12T00:00:00.000Z',
  }
}

const ai = (model: string, baseUrl = 'https://api.example.com/v1', apiKey = 'sk'): ManualAiConfigFields => ({
  provider: 'openai-compatible',
  model,
  baseUrl,
  apiKey,
})

function stateWith(overrides: Partial<RuntimeConfigFormState>): RuntimeConfigFormState {
  return { ...formStateFromSnapshot(null), ...overrides }
}

function allOfficialScenarios(): RuntimeConfigFormState['scenarios'] {
  return {
    primary: { mode: 'official', model: '', baseUrl: '', apiKey: '' },
    background: { mode: 'official', model: '', baseUrl: '', apiKey: '' },
    lite: { mode: 'official', model: '', baseUrl: '', apiKey: '' },
    cursorCompletion: { mode: 'official', model: '', baseUrl: '', apiKey: '' },
  }
}

describe('formStateFromSnapshot — 场景解析', () => {
  it('fresh snapshot（无 userConfig）：全部场景跟随通用，特殊模型用官方', () => {
    const state = formStateFromSnapshot(snapshot(null))
    expect(state.generic).toEqual({ provider: 'openai-compatible', model: '', baseUrl: '', apiKey: '' })
    for (const id of ['primary', 'background', 'lite', 'cursorCompletion'] as const) {
      expect(state.scenarios[id]).toEqual({ mode: 'generic', model: '', baseUrl: '', apiKey: '' })
    }
    expect(state.vlm.mode).toBe('official')
    expect(state.webSearchCustom).toBe(false)
  })

  it('槽位缺失 = 用官方；空串/掩码连接字段 = 旧继承语义 → 跟随通用', () => {
    const state = formStateFromSnapshot(snapshot({
      schemaVersion: 1,
      primary: { provider: 'openai-compatible', model: 'm', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      background: { model: '', baseUrl: '', apiKey: '' },
      lite: { model: 'qwen-flash', baseUrl: '', apiKey: '' },
    }))
    expect(state.scenarios.primary.mode).toBe('generic')
    expect(state.scenarios.background.mode).toBe('official')
    expect(state.scenarios.lite.mode).toBe('generic')
  })

  it('连接与通用一致：模型相同跟随通用、不同单独配置（无独立连接）；独立端点带独立密钥', () => {
    const state = formStateFromSnapshot(snapshot({
      schemaVersion: 1,
      primary: { provider: 'p', model: 'main-m', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      lite: { provider: 'p', model: 'lite-m', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      cursorCompletion: { provider: 'p', model: 'cc-m', baseUrl: 'https://cc.example.com/v1', apiKey: '********' },
    }))
    expect(state.scenarios.lite).toMatchObject({ mode: 'custom', model: 'lite-m', baseUrl: '', apiKey: '' })
    expect(state.scenarios.cursorCompletion).toMatchObject({ mode: 'custom', model: 'cc-m', baseUrl: 'https://cc.example.com/v1' })
    expect(state.keyConfigured.scenarios.cursorCompletion).toBe(true)
  })

  it('特殊模型：槽位有内容即自定义（有 baseUrl = 独立连接），缺失即官方', () => {
    const state = formStateFromSnapshot(snapshot({
      schemaVersion: 1,
      vlm: { provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    }))
    expect(state.vlm.mode).toBe('custom')
    expect(state.vlm.model).toBe('qwen-vl-max')
    expect(state.vlm.baseUrl).toBe('https://api.example.com/v1')
    expect(state.vlm.apiKey).toBe('')
    expect(state.webSearchCustom).toBe(false)
  })

  it('特殊模型：只存模型（连接空）= 继承通用连接的自定义', () => {
    const state = formStateFromSnapshot(snapshot({
      schemaVersion: 1,
      primary: { provider: 'p', model: 'm', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      vlm: { provider: 'p', model: 'qwen-vl-max' },
    }))
    expect(state.vlm.mode).toBe('custom')
    expect(state.vlm.baseUrl).toBe('')
  })
})

describe('buildUserPayload — 槽位级构建', () => {
  it('跟随通用/仅模型覆盖只存模型（连接由解析层继承）；独立连接存全量；未配置槽位删除', () => {
    const state = stateWith({
      generic: ai('main-m'),
      scenarios: {
        primary: { mode: 'generic', model: '', baseUrl: '', apiKey: '' },
        background: { mode: 'custom', model: 'bg-m', baseUrl: '', apiKey: '' },
        lite: { mode: 'official', model: '', baseUrl: '', apiKey: '' },
        cursorCompletion: { mode: 'custom', model: 'cc-m', baseUrl: 'https://cc.example.com/v1', apiKey: 'cc-key' },
      },
      webSearchCustom: true,
      webSearch: { provider: 'openai-compatible', model: 'qwen-plus', baseUrl: 'https://s.example.com/v1', apiKey: '' },
    })
    const payload = buildUserPayload(snapshot({
      schemaVersion: 1,
      primary: { provider: 'old', model: 'old-m', baseUrl: 'https://old.example.com/v1', apiKey: 'old' },
      vlm: { provider: 'old', model: 'old-vlm', baseUrl: 'https://old.example.com/v1', apiKey: 'old' },
      asr: { provider: 'aliyun', model: 'old-asr', baseUrl: 'u', apiKey: 'k' },
      knowledge: { enabled: true, serviceId: 'svc', embedding: { provider: 'q', model: 'old-embed', baseUrl: 'u', apiKey: 'k' } },
      memory: { enabled: true },
    }), state) as Record<string, Record<string, unknown>>

    expect(payload.primary).toMatchObject({ model: 'main-m', baseUrl: 'https://api.example.com/v1' })
    // 仅模型覆盖：只存 provider+model，连接留空 → 解析层继承通用模型。
    expect(payload.background).toEqual({ provider: 'openai-compatible', model: 'bg-m' })
    expect(payload.lite).toBeUndefined()
    // 独立连接：全量落盘。
    expect(payload.cursorCompletion).toEqual({ provider: 'openai-compatible', model: 'cc-m', baseUrl: 'https://cc.example.com/v1', apiKey: 'cc-key' })
    expect(payload.vlm).toBeUndefined()
    // 已删子系统（ASR/记忆/知识）的历史槽位不在本模块管理范围：原样保留，
    // 由 gateway 读取/保存时静默剥离。
    expect(payload.asr).toEqual({ provider: 'aliyun', model: 'old-asr', baseUrl: 'u', apiKey: 'k' })
    expect(payload.knowledge).toEqual({ enabled: true, serviceId: 'svc', embedding: { provider: 'q', model: 'old-embed', baseUrl: 'u', apiKey: 'k' } })
    expect(payload.memory).toEqual({ enabled: true })
    expect((payload.webSearch as Record<string, unknown>).apiKey).toEqual({ operation: 'keep' })
  })

  it('全部场景用官方时不写任何文本槽位', () => {
    const state = stateWith({
      generic: ai('main-m'),
      scenarios: allOfficialScenarios(),
    })
    const payload = buildUserPayload(snapshot(null), state) as Record<string, unknown>
    expect(payload.primary).toBeUndefined()
    expect(payload.background).toBeUndefined()
    expect(payload.schemaVersion).toBe(1)
  })

  it('vlm 连接留空只存 provider+model（继承通用连接）；填全走独立连接', () => {
    const inherited = stateWith({
      generic: ai('main-m'),
      vlm: { provider: 'qwen', model: 'qwen-vl-max', baseUrl: '', apiKey: '', mode: 'custom' },
    })
    const inheritedPayload = buildUserPayload(snapshot(null), inherited) as Record<string, Record<string, unknown>>
    expect(inheritedPayload.vlm).toEqual({ provider: 'openai-compatible', model: 'qwen-vl-max' })

    const standalone = stateWith({
      generic: ai('main-m'),
      vlm: { provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://vlm.example.com/v1', apiKey: 'vlm-key', mode: 'custom' },
    })
    const standalonePayload = buildUserPayload(snapshot(null), standalone) as Record<string, Record<string, unknown>>
    expect(standalonePayload.vlm).toEqual({ provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://vlm.example.com/v1', apiKey: 'vlm-key' })
  })

  it('webSearch 密钥 envelope：输入新值 set、勾删 delete', () => {
    const base = stateWith({
      generic: ai('main-m'),
      webSearchCustom: true,
      webSearch: { provider: 'openai-compatible', model: 'qwen-plus', baseUrl: 'https://s.example.com/v1', apiKey: 'sk-new' },
    })
    expect((buildUserPayload(snapshot(null), base).webSearch as Record<string, unknown>).apiKey).toEqual({ operation: 'set', value: 'sk-new' })
    const deleted = { ...base, deleteSearchKey: true, webSearch: { ...base.webSearch, apiKey: '' } }
    expect((buildUserPayload(snapshot(null), deleted).webSearch as Record<string, unknown>).apiKey).toEqual({ operation: 'delete' })
  })
})

describe('runtimeConfigFormError', () => {
  const t = (key: string) => key
  it('场景启用时通用模型必填全', () => {
    const partial = stateWith({ generic: { provider: 'p', model: 'm', baseUrl: '', apiKey: '' } })
    expect(runtimeConfigFormError(partial, t)).toBe('surface:settings.rcGenericIncomplete')
    expect(runtimeConfigFormError(stateWith({ generic: ai('m') }), t)).toBeNull()
  })

  it('全部场景官方时通用模型可为空；单独配置必须有模型名', () => {
    const allOfficial = stateWith({
      generic: { provider: 'p', model: '', baseUrl: '', apiKey: '' },
      scenarios: allOfficialScenarios(),
    })
    expect(runtimeConfigFormError(allOfficial, t)).toBeNull()
    const customNoModel = stateWith({ generic: ai('m'), scenarios: { ...allOfficial.scenarios, primary: { mode: 'custom', model: ' ', baseUrl: '', apiKey: '' } } })
    expect(runtimeConfigFormError(customNoModel, t)).toBe('surface:settings.rcScenarioModelRequired')
  })

  it('特殊模型：自定义必须有模型名；独立连接要么成对填全要么留空；继承需通用启用', () => {
    expect(runtimeConfigFormError(stateWith({ generic: ai('m'), vlm: { provider: 'p', model: ' ', baseUrl: '', apiKey: '', mode: 'custom' } }), t))
      .toBe('surface:settings.rcScenarioModelRequired')
    expect(runtimeConfigFormError(stateWith({ generic: ai('m'), vlm: { provider: 'p', model: 'v', baseUrl: 'https://vlm.example.com/v1', apiKey: '', mode: 'custom' } }), t))
      .toBe('surface:settings.rcScenarioConnectionIncomplete')
    const allOfficial = {
      generic: { provider: 'p', model: '', baseUrl: '', apiKey: '' },
      scenarios: allOfficialScenarios(),
    } as const
    expect(runtimeConfigFormError(stateWith({ ...allOfficial, vlm: { provider: 'p', model: 'vlm', baseUrl: '', apiKey: '', mode: 'custom' } }), t))
      .toBe('surface:settings.rcGenericIncomplete')
    expect(runtimeConfigFormError(stateWith({ generic: ai('m'), vlm: { provider: 'p', model: 'vlm', baseUrl: '', apiKey: '', mode: 'custom' } }), t)).toBeNull()
  })

  it('已存密钥（掩码播种）时 apiKey 留空沿用原值，不算缺失', () => {
    // 脱敏快照里密钥是掩码串：掩码即「库里有值」。
    const state = formStateFromSnapshot(snapshot({
      schemaVersion: 1,
      primary: { provider: 'openai-compatible', model: 'glm-4', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
      vlm: { provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    }))
    expect(state.keyConfigured.generic).toBe(true)
    expect(state.keyConfigured.vlm).toBe(true)
    expect(state.generic.apiKey).toBe('')
    // 视觉段独立连接、apiKey 留空：校验通过（沿用库中原值）。
    expect(runtimeConfigFormError(state, t)).toBeNull()
    // 从未存过密钥（userConfig 为空）时独立连接缺密钥仍报错。
    const fresh = stateWith({ generic: ai('m'), vlm: { provider: 'p', model: 'vlm', baseUrl: 'https://api.example.com/v1', apiKey: '', mode: 'custom' } })
    expect(runtimeConfigFormError(fresh, t)).toBe('surface:settings.rcScenarioConnectionIncomplete')
  })
})

describe('buildManualEntryPayload — 启动 gate', () => {
  it('只覆盖 primary，其余槽位原样保留', () => {
    const payload = buildManualEntryPayload(snapshot({
      schemaVersion: 1,
      primary: { provider: 'old', model: 'old-m', baseUrl: 'https://old.example.com/v1', apiKey: 'old' },
      asr: { provider: 'aliyun', model: 'asr-m', baseUrl: 'u', apiKey: 'k' },
      vlm: { provider: 'p', model: 'vlm-m', baseUrl: 'u', apiKey: 'k' },
    }), { primary: ai('main-m') }) as Record<string, unknown>
    expect(payload.primary).toMatchObject({ model: 'main-m', baseUrl: 'https://api.example.com/v1' })
    // 渲染层不碰已删槽位（gateway 保存时剥离）。
    expect(payload.asr).toMatchObject({ model: 'asr-m' })
    expect(payload.vlm).toMatchObject({ model: 'vlm-m' })
  })

  it('gate 播种读 userConfig 原始 primary（掩码留空）', () => {
    expect(primaryFieldsFromSnapshot(snapshot({
      primary: { provider: 'p', model: 'm', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    }))).toEqual({ provider: 'p', model: 'm', baseUrl: 'https://api.example.com/v1', apiKey: '' })
    expect(primaryFieldsFromSnapshot(snapshot(null))).toEqual({ provider: 'openai-compatible', model: '', baseUrl: '', apiKey: '' })
  })
})