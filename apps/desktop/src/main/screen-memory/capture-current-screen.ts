import { desktopCapturer, screen, systemPreferences, type NativeImage } from 'electron'

export type ScreenPermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export function getScreenCapturePermission(): ScreenPermissionStatus {
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted' || status === 'denied' || status === 'not-determined' || status === 'restricted') return status
  return 'unknown'
}

export type CaptureScreen = () => Promise<{ image: NativeImage; scaleFactor: number } | null>

/** 采集主屏当前画面（MVP 只采主屏；多屏为后续版本项）。 */
export const capturePrimaryScreen: CaptureScreen = async () => {
  const primary = screen.getPrimaryDisplay()
  const scaleFactor = primary.scaleFactor > 0 ? primary.scaleFactor : 1
  const width = Math.round(primary.size.width * scaleFactor)
  const height = Math.round(primary.size.height * scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  })
  const primarySource = sources.find((source) => source.display_id === String(primary.id)) ?? sources[0]
  if (!primarySource) return null
  const thumbnail = primarySource.thumbnail
  if (thumbnail.isEmpty()) return null
  return { image: thumbnail, scaleFactor }
}
