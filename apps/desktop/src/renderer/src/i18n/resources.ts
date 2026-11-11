import contextRoomEnglishMessages from './locales/en-US/contextRoom.json'
import contextRoomChineseMessages from './locales/zh-CN/contextRoom.json'
import surfaceEnglishMessages from './locales/en-US/surface.json'
import surfaceChineseMessages from './locales/zh-CN/surface.json'
import workbenchEnglishMessages from './locales/en-US/workbench.json'
import workbenchChineseMessages from './locales/zh-CN/workbench.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type AppLocale = typeof SUPPORTED_LOCALES[number]

export const i18nResources = {
  'zh-CN': {
    common: {},
    contextRoom: contextRoomChineseMessages,
    surface: surfaceChineseMessages,
    workbench: workbenchChineseMessages,
  },
  'en-US': {
    common: {},
    contextRoom: contextRoomEnglishMessages,
    surface: surfaceEnglishMessages,
    workbench: workbenchEnglishMessages,
  },
} as const

export type I18nNamespace = keyof typeof i18nResources['en-US']
