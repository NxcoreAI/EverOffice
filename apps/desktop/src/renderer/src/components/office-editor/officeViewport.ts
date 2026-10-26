/**
 * 内嵌 Office 视口协调：原生 WebContentsView 永远画在 DOM 之上，z-index
 * 管不了它，只能靠「矩形上报 + 显隐时序」对齐。本模块把时序规则集中到一处：
 * 1. 卸载（detach）立即上报零尺寸：页签/页面切换当帧隐藏，消灭残影遮蔽。
 * 2. 挂载后双帧确认布局再首次上报，且先做遮挡扫描，避免在弹框下闪现。
 * 3. 宿主矩形归零（面板收起等）同样上报零尺寸隐藏，而不是保留旧矩形。
 * 4. 祖先滚动会移动矩形而不改尺寸：捕获阶段 scroll 一并重报。
 * 5. 遮挡扫描：对宿主 5 个采样点做 elementsFromPoint 命中测试，多数点被
 *    其他元素盖住（全屏弹框/命令面板/拖拽层）→ 上报零尺寸隐藏；撤掉后
 *    恢复真实矩形。由 body 变更（防抖）与 pointerdown/focusin 触发。
 * 6. 浮层让位：标了 data-office-avoid 的面板（右侧 AI 侧栏在窄窗下是覆盖层，
 *    不占网格列）压在宿主上时，原生视图裁到面板左侧；面板铺满宿主则隐藏。
 *    窄窗没有网格列变化可为事件源，靠周期复扫兜住。
 */
export interface OfficeViewportAttachment {
  detach(): void
}

interface OfficeViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

const OCCLUSION_HIDE_THRESHOLD = 3
const SCAN_QUIET_MS = 150
/** 周期复扫：布局动画（面板展开/收起）不产生 DOM 变更，只靠事件会在错误状态里卡死。 */
const SCAN_INTERVAL_MS = 700
const CORNER_INSET = 12
/** 会让原生视图让位的浮层面板；面板自己声明，避免把类名约定写死在这里。 */
const AVOID_SELECTOR = '[data-office-avoid]'
const ZERO_BOUNDS: OfficeViewportBounds = { x: 0, y: 0, width: 0, height: 0 }

function sendBounds(bounds: OfficeViewportBounds): void {
  window.nxcore?.office?.setWorkspaceBounds(bounds)
}

/**
 * 浮层面板压在宿主右侧时把矩形裁到面板左边界；面板从宿主左边界起就覆盖
 * （宿主已被完全遮住）则退化为零尺寸隐藏。面板不在宿主范围内时原样返回，
 * 所以宽窗下侧栏占的是网格列、这里是空操作。
 */
export function shrinkForPanels(
  bounds: OfficeViewportBounds,
  panels: readonly OfficeViewportBounds[],
): OfficeViewportBounds {
  let right = bounds.x + bounds.width
  for (const panel of panels) {
    if (panel.width <= 0 || panel.height <= 0) continue
    const overlapsVertically = bounds.y < panel.y + panel.height && panel.y < bounds.y + bounds.height
    if (!overlapsVertically) continue
    const panelRight = panel.x + panel.width
    if (panelRight <= bounds.x || panel.x >= right) continue
    if (panel.x <= bounds.x) return ZERO_BOUNDS
    right = Math.min(right, panel.x)
  }
  const width = right - bounds.x
  if (width <= 0) return ZERO_BOUNDS
  return width === bounds.width ? bounds : { x: bounds.x, y: bounds.y, width, height: bounds.height }
}

/**
 * 采样点被盖住 = 命中栈顶既不是宿主、不在宿主内、也不包含宿主。
 * 让位面板不算遮挡：它由 shrinkForPanels 按矩形让位，两套机制不能互相打架
 *（否则面板盖到 3 个采样点时视图会先被判定成「有弹框」直接隐藏）。
 */
function isPointOccluded(host: HTMLElement, x: number, y: number): boolean {
  if (typeof document.elementsFromPoint !== 'function') return false
  const top = document.elementsFromPoint(x, y).find((element) => !element.closest(AVOID_SELECTOR))
  if (!top || top === host) return false
  return !host.contains(top) && !top.contains(host)
}

function countOccludedSamples(host: HTMLElement): number {
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return 0
  const midX = rect.left + rect.width / 2
  const midY = rect.top + rect.height / 2
  const left = rect.left + CORNER_INSET
  const right = rect.right - CORNER_INSET
  const top = rect.top + CORNER_INSET
  const bottom = rect.bottom - CORNER_INSET
  const points: Array<[number, number]> = [
    [midX, midY],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ]
  let occluded = 0
  for (const [x, y] of points) {
    if (isPointOccluded(host, x, y)) occluded += 1
  }
  return occluded
}

function collectPanelBounds(): OfficeViewportBounds[] {
  if (typeof document.querySelectorAll !== 'function') return []
  const panels: OfficeViewportBounds[] = []
  for (const element of document.querySelectorAll<HTMLElement>(AVOID_SELECTOR)) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    panels.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }
  return panels
}

export function attachOfficeViewport(host: HTMLElement): OfficeViewportAttachment {
  let detached = false
  let suppressed = false
  let scanTimer: number | null = null
  let lastSent = ''

  // 原生视图 setBounds 每帧重设也有代价，同矩形不重复上报。
  const send = (bounds: OfficeViewportBounds): void => {
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
    if (key === lastSent) return
    lastSent = key
    sendBounds(bounds)
  }

  const report = (): void => {
    if (detached || suppressed) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      send(ZERO_BOUNDS)
      return
    }
    const raw = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    send(shrinkForPanels(raw, collectPanelBounds()))
  }

  const scan = (): void => {
    if (detached) return
    const next = countOccludedSamples(host) >= OCCLUSION_HIDE_THRESHOLD
    if (next !== suppressed) {
      suppressed = next
      if (suppressed) send(ZERO_BOUNDS)
      else report()
      return
    }
    // 遮挡状态没变也要重报：窄窗下面板从「占列」切成「浮层」时宿主尺寸不变，
    // ResizeObserver 不会响，只能靠这里的周期复扫把让位矩形跟上。
    if (!suppressed) report()
  }

  // 首次立即扫（弹层出现当帧判定），静默 150ms 后再扫一次收尾（动画类关闭）。
  const scheduleScan = (): void => {
    if (detached) return
    if (scanTimer === null) scan()
    else window.clearTimeout(scanTimer)
    scanTimer = window.setTimeout(() => {
      scanTimer = null
      scan()
    }, SCAN_QUIET_MS)
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null
  observer?.observe(host)
  const mutationObserver = typeof MutationObserver === 'function' && document.body
    ? new MutationObserver(scheduleScan)
    : null
  mutationObserver?.observe(document.body!, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  })
  window.addEventListener('resize', report)
  window.addEventListener('scroll', report, true)
  window.addEventListener('pointerdown', scheduleScan, true)
  window.addEventListener('focusin', scheduleScan, true)

  // 先立即上报一次：窗口在后台/被遮挡时 rAF 会被节流，等下一帧才上报会让
  // 内嵌视图一直不显示（访达双击打开时的典型现场）。
  report()
  const nextFrame = (callback: () => void): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback)
    else callback()
  }
  nextFrame(() => nextFrame(report))
  // 周期复扫兜底：遮挡判定是「采样点 + 棘轮状态」，面板展开动画/弹层关闭
  // 不一定触发 DOM 变更，只靠事件会让视图永久停在隐藏态。
  const scanInterval = window.setInterval(scan, SCAN_INTERVAL_MS)

  return {
    detach(): void {
      if (detached) return
      detached = true
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer)
        scanTimer = null
      }
      window.clearInterval(scanInterval)
      observer?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      window.removeEventListener('pointerdown', scheduleScan, true)
      window.removeEventListener('focusin', scheduleScan, true)
      send(ZERO_BOUNDS)
    },
  }
}
