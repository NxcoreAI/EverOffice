// powerMonitor 四类区间结束事件 + 空闲检测（连续空闲 5 分钟结束区间）。
// powerMonitor 为依赖注入，便于单测。

import type { PowerMonitor } from 'electron'

export type PowerEventKind = 'suspend' | 'resume' | 'lock' | 'unlock' | 'idle'

export interface PowerWatcherOptions {
  idleThresholdMs?: number
  pollIntervalMs?: number
  now?: () => Date
}

export interface PowerWatcher {
  dispose(): void
}

export function createPowerWatcher(
  powerMonitor: Pick<PowerMonitor, 'on' | 'off' | 'getSystemIdleTime'>,
  onEvent: (kind: PowerEventKind, at: Date) => void,
  options: PowerWatcherOptions = {},
): PowerWatcher {
  const idleThresholdMs = options.idleThresholdMs ?? 5 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 15_000
  const now = options.now ?? (() => new Date())

  const handler = (kind: PowerEventKind) => () => {
    if (kind === 'resume' || kind === 'unlock') idleLatched = false
    onEvent(kind, now())
  }

  powerMonitor.on('suspend', handler('suspend'))
  powerMonitor.on('resume', handler('resume'))
  powerMonitor.on('lock-screen', handler('lock'))
  powerMonitor.on('unlock-screen', handler('unlock'))

  let idleLatched = false
  const timer = setInterval(() => {
    const idleSeconds = powerMonitor.getSystemIdleTime()
    if (idleSeconds * 1000 >= idleThresholdMs) {
      if (idleLatched) return
      idleLatched = true
      onEvent('idle', now())
    } else {
      idleLatched = false
    }
  }, pollIntervalMs)
  timer.unref?.()

  return {
    dispose: () => {
      powerMonitor.off('suspend', handler('suspend'))
      powerMonitor.off('resume', handler('resume'))
      powerMonitor.off('lock-screen', handler('lock'))
      powerMonitor.off('unlock-screen', handler('unlock'))
      clearInterval(timer)
    },
  }
}
