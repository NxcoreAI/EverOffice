import { describe, expect, it } from 'vitest'

import type { RuntimeConfigSnapshot } from '../../../../shared/sources'

import {
  buildManualEntryPayload,
  configTestErrorMessage,
  isRuntimeConfigReady,
  manualConfigFieldError,
  primaryFieldsFromSnapshot,
  startupGateOutcome,
  type ManualAiConfigFields,
} from './runtimeConfigGateState'

function snapshot(userConfig: Record<string, unknown> | null = null, extra: Partial<RuntimeConfigSnapshot> = {}): RuntimeConfigSnapshot {
  return {
    config: {},
    userConfig,
    source: 'default',
    selectedSource: 'default',
    availableSources: ['default'],
    configVersion: 1,
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...extra,
  }
}

const primary = (model: string, baseUrl: string, apiKey: string): ManualAiConfigFields => ({
  provider: 'openai-compatible',
  model,
  baseUrl,
  apiKey,
})

describe('runtime config gate state', () => {
  it('treats only an explicit server-side flag as ready', () => {
    expect(isRuntimeConfigReady(null)).toBe(false)
    expect(isRuntimeConfigReady(snapshot())).toBe(false)
    expect(isRuntimeConfigReady(snapshot({}, { primaryConfigured: true }))).toBe(true)
  })

  it('seeds manual fields from the saved user primary, keeping masked secrets blank', () => {
    const current = snapshot({
      primary: { provider: 'glm', model: 'glm-4', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    })
    expect(primaryFieldsFromSnapshot(current)).toEqual({
      provider: 'glm',
      model: 'glm-4',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
    })
  })

  it('falls back to the default provider when primary is missing', () => {
    expect(primaryFieldsFromSnapshot(snapshot())).toEqual({
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    })
  })

  it('builds a user payload that preserves unrelated sections', () => {
    const current = snapshot({ asr: { provider: 'aliyun' }, primary: { provider: 'old' } })
    const next = buildManualEntryPayload(current, {
      primary: {
        provider: 'openai-compatible',
        model: 'm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-new',
      },
    }) as {
      schemaVersion: number
      asr: unknown
      primary: Record<string, string>
    }
    expect(next.schemaVersion).toBe(1)
    // 未管理的键原样保留（已删槽位由 gateway 保存时剥离，渲染层不碰）。
    expect(next.asr).toEqual({ provider: 'aliyun' })
    expect(next.primary).toEqual({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-new',
    })
  })

  it('maps connection test failures to readable messages', () => {
    const t = (key: string) => key
    expect(configTestErrorMessage('runtime_config_test_incomplete', t)).toBe('surface:configGate.testIncomplete')
    expect(configTestErrorMessage('runtime_config_test_http_401: bad key', t)).toBe('surface:configGate.testAuthFailed')
    expect(configTestErrorMessage('runtime_config_test_http_404: no route', t)).toBe('surface:configGate.testNotFound')
    // 未分类状态与网络失败都附带服务端原始错误尾巴，排障不再靠猜。
    expect(configTestErrorMessage('runtime_config_test_unreachable: refused', t)).toBe('surface:configGate.testUnreachable（refused）')
    expect(configTestErrorMessage('runtime_config_test_http_502: upstream down', t)).toBe('surface:configGate.testFailedGeneric（upstream down）')
    expect(configTestErrorMessage('runtime_config_test_unreachable', t)).toBe('surface:configGate.testUnreachable')
    expect(configTestErrorMessage(undefined, t)).toBe('surface:configGate.testFailedGeneric')
  })

  it('requires the primary model, base URL and API key', () => {
    const t = (key: string) => key
    expect(manualConfigFieldError(primary('', 'https://api.example.com/v1', 'sk'), t))
      .toBe('surface:configGate.fieldRequired')
    expect(manualConfigFieldError(primary('m', 'https://api.example.com/v1', ''), t))
      .toBe('surface:configGate.fieldRequired')
    expect(manualConfigFieldError(primary('m', 'https://api.example.com/v1', 'sk'), t)).toBeNull()
  })
})

describe('startupGateOutcome', () => {
  const input = (overrides: Partial<Parameters<typeof startupGateOutcome>[0]> = {}) => ({
    configReady: true,
    accountResolved: true,
    authenticated: true,
    ...overrides,
  })

  it('waits until both config and account status settle', () => {
    expect(startupGateOutcome(input({ configReady: false }))).toBe('wait')
    expect(startupGateOutcome(input({ accountResolved: false }))).toBe('wait')
  })

  it('enters the app once authenticated', () => {
    expect(startupGateOutcome(input())).toBe('app')
  })

  it('keeps unauthenticated manual (BYOK) config usable', () => {
    expect(startupGateOutcome(input({ authenticated: false }))).toBe('app')
    expect(startupGateOutcome(input({ authenticated: null }))).toBe('app')
  })
})
