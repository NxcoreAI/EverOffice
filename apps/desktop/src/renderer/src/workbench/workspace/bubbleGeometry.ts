/**
 * 工作空间气泡窗的宽度几何：把「记忆宽度 + 容器宽度 + 用户是否拖过阈值」收敛成
 * 实际渲染宽度与几个布局档位。
 *
 * 背景（为什么不再用固定 720 上限）：
 * - 停靠态常规拖宽只到「对话区还能保住 CHAT_MIN_WIDTH」的那条线（softMax），
 *   再往左拖就是用户明确要把面板压满整个工作区（cover），此时对话区让位到 0，
 *   面板去掉停靠留白与卡片描边，视觉上与最大化覆盖层一致；
 * - 窗口被拖宽/收窄后，渲染宽度必须按当前容器重新收敛，否则记忆宽度会比实际宽，
 *   下一次拖拽就会从旧值跳一下。拖拽起点因此用实测宽度（BubbleWindow 里量），
 *   这里只提供纯计算，方便单测。
 */

/** 气泡窗最小宽度（再窄就没有编辑意义）。 */
export const BUBBLE_MIN_WIDTH = 360
/** 首次展开的默认宽度。 */
export const BUBBLE_DEFAULT_WIDTH = 480
/** 停靠态右缘留白（与 bubble.css 的 .wb-bubble margin-right 同步）。 */
export const BUBBLE_DOCK_GAP = 8
/** 对话区保底宽度（与 workspace.css 的 .wb-ws-main min-width 同步）。 */
export const CHAT_MIN_WIDTH = 240
/** 记忆宽度的安全上限（容器量不到时的兜底，避免状态无限增长）。 */
const BUBBLE_SAFE_MAX_WIDTH = 4096

export interface BubbleGeometryInput {
  /** 状态里记住的停靠宽度。 */
  width: number
  /** 容器（.wb-ws）可用宽度；0/负数 = 还没量到，不做容器收敛。 */
  containerWidth: number
  /** 用户是否已经拖过 softMax（只有拖过才允许继续压满整页）。 */
  cover: boolean
}

export interface BubbleGeometry {
  /** 实际渲染宽度（px）。 */
  width: number
  /** 停靠态上限：越过它就开始挤掉对话区的保底宽度。 */
  softMax: number
  /** 铺满整个工作区的宽度（去掉右缘留白）。 */
  coverWidth: number
  /** 是否处于「对话区可以让位到 0」的区间。 */
  covering: boolean
  /** 是否已经铺满整页（视觉上等同最大化覆盖层）。 */
  full: boolean
}

/**
 * 解析气泡窗渲染宽度。
 *
 * - 常规态：宽度收敛在 [BUBBLE_MIN_WIDTH, softMax]，对话区至少保住 CHAT_MIN_WIDTH；
 * - 拖过 softMax 后（cover=true）：允许继续长到 coverWidth，对话区随之让位；
 * - 容器量不到（containerWidth<=0）：保持原宽度，交给上层兜底。
 */
export function resolveBubbleGeometry({ width, containerWidth, cover }: BubbleGeometryInput): BubbleGeometry {
  const requested = clamp(width || BUBBLE_DEFAULT_WIDTH, BUBBLE_MIN_WIDTH, BUBBLE_SAFE_MAX_WIDTH)
  if (containerWidth <= 0) {
    return {
      width: requested,
      softMax: Number.POSITIVE_INFINITY,
      coverWidth: Number.POSITIVE_INFINITY,
      covering: cover,
      full: false,
    }
  }
  // 容器窄到连「最小宽度 + 对话区保底」都放不下时，优先保住面板最小宽度。
  const softMax = Math.max(BUBBLE_MIN_WIDTH, containerWidth - CHAT_MIN_WIDTH - BUBBLE_DOCK_GAP)
  const coverWidth = Math.max(BUBBLE_MIN_WIDTH, containerWidth)
  const limit = cover ? coverWidth : softMax
  const resolved = clamp(requested, BUBBLE_MIN_WIDTH, limit)
  const covering = resolved > softMax
  const full = cover && resolved >= coverWidth - 1
  return { width: resolved, softMax, coverWidth, covering, full }
}

export interface BubbleDragInput {
  /** 拖拽起点宽度：调用方必须传面板「实测宽度」，不能传记忆宽度。 */
  startWidth: number
  /** 指针相对起点的水平位移（向左为负）。 */
  deltaX: number
  softMax: number
  coverWidth: number
}

export interface BubbleDragResult {
  /** 这次拖拽想设定的记忆宽度。 */
  width: number
  /** 这次拖拽之后是否进入「压满整页」档位。 */
  cover: boolean
}

/**
 * 把一次指针位移换算成记忆宽度 + cover 档位。
 *
 * 关键：宽度向左拖增大会越过 softMax，此时把 cover 打开，渲染宽度才能连续地
 * 继续长到 coverWidth（若只在拖拽结束时再改档位，中途会被 softMax 截住、
 * 松手后才跳一下）。反向拖回 softMax 以内时自动退出 cover。
 */
export function resolveBubbleDrag({ startWidth, deltaX, softMax, coverWidth }: BubbleDragInput): BubbleDragResult {
  const next = startWidth - deltaX
  const width = clamp(next, BUBBLE_MIN_WIDTH, Math.max(BUBBLE_MIN_WIDTH, coverWidth))
  return { width, cover: width > softMax }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
