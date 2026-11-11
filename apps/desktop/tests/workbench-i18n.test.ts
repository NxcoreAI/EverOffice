import { describe, expect, it } from 'vitest'

import i18n from '../src/renderer/src/i18n/i18next'
import { translate } from '../src/renderer/src/i18n/LocaleContext'
import zhWorkbench from '../src/renderer/src/i18n/locales/zh-CN/workbench.json'
import enWorkbench from '../src/renderer/src/i18n/locales/en-US/workbench.json'
import { workspaceDisplayName } from '../src/renderer/src/workbench/types'

describe('workbench i18n', () => {
  it('中英词条键集合一致，且没有空文案', () => {
    expect(Object.keys(enWorkbench).sort()).toEqual(Object.keys(zhWorkbench).sort())
    for (const [locale, messages] of [['zh-CN', zhWorkbench], ['en-US', enWorkbench]] as const) {
      for (const [key, value] of Object.entries(messages)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('侧栏 / 顶部标签的 workbench 词条解析为对应语言', () => {
    expect(translate('zh-CN', 'workbench:nav.recent')).toBe('最近')
    expect(translate('en-US', 'workbench:nav.recent')).toBe('Recent')
    expect(translate('en-US', 'workbench:nav.spaces')).toBe('Project Spaces')
    expect(translate('en-US', 'workbench:tab.home')).toBe('Home')
    expect(translate('zh-CN', 'workbench:workspacePage.overview')).toBe('概览')
    expect(translate('en-US', 'workbench:workspacePage.overview')).toBe('Overview')
  })

  it('占位符按当前语言插值', () => {
    expect(translate('zh-CN', 'workbench:time.minutesAgo', { count: 5 })).toBe('5 分钟前')
    expect(translate('en-US', 'workbench:time.minutesAgo', { count: 5 })).toBe('5 min ago')
    expect(translate('en-US', 'workbench:tab.pendingAnnotations', { count: 2 })).toBe('2 pending annotations')
  })

  it('默认工作区展示名随语言切换，自定义空间名保持原样', () => {
    const base = {
      id: 'default',
      path: null,
      kind: 'default' as const,
      description: null,
      goals: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    }
    const seed = { ...base, name: '默认工作区' }
    const custom = { ...base, id: 'ws-1', name: '毕设', kind: 'custom' as const }
    const aliased = { ...custom, nameEn: 'Graduation Project' }
    expect(workspaceDisplayName(seed)).toBe('默认工作区')
    expect(workspaceDisplayName(seed, 'en-US')).toBe('Default workspace')
    expect(workspaceDisplayName(custom, 'en-US')).toBe('毕设')
    expect(workspaceDisplayName(aliased, 'zh-CN')).toBe('毕设')
    expect(workspaceDisplayName(aliased, 'en-US')).toBe('Graduation Project')
  })

  it('i18next 实例注册了 workbench 命名空间', () => {
    expect(i18n.hasResourceBundle('zh-CN', 'workbench')).toBe(true)
    expect(i18n.hasResourceBundle('en-US', 'workbench')).toBe(true)
  })
})
