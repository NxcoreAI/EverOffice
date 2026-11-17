import {
  genofficeLangForLocale,
  isDesktopLocale,
  translateDesktopMessage,
  type DesktopLocale,
  type DesktopMessageKey,
} from '../shared/i18n/desktop'

let currentLocale: DesktopLocale = 'zh-CN'

export function setDesktopLocale(locale: unknown): void {
  if (isDesktopLocale(locale)) currentLocale = locale
}

export function getDesktopLocale(): DesktopLocale {
  return currentLocale
}

export function desktopText(
  key: DesktopMessageKey,
  values?: Record<string, string | number>,
): string {
  return translateDesktopMessage(currentLocale, key, values)
}

/**
 * Desktop locale mapped to the embedded GenOffice editors' UI language tag
 * (@genoffice/i18n `Lang`). Consumed by office/editor-locale.ts, which keeps
 * the editors' `app:get-language` channel pointed at this value.
 */
export function desktopGenofficeLang(): 'zh' | 'en' {
  return genofficeLangForLocale(currentLocale)
}
