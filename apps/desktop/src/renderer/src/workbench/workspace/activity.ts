import type { AgentEvent, AgentSession } from '@nxcore/agent-contract'

import { translateZh, type Translate } from '@/i18n/LocaleContext'
import type { RealOfficeFile } from '@/office-proto/data'

import { isArtifactSourceKind } from './artifactKind'

/**
 * 工作空间概览页的派生数据。
 *
 * 后端没有「动态」「洞察」实体（见 `docs/design/product-data-map.zh-CN.md` §9）：
 * - 动态 = 本空间 sessions + 文件库条目按时间合并的倒序事件流；
 * - 洞察 = 最近更新会话的最后一条 assistant 文本（消息快照优先，run 事件兜底）。
 *
 * 动态的模型对齐原型（`everoffice` `workspace.ts:105-146`）：
 * - `kind` 是**有限枚举**，决定图标与色彩（见 ACTIVITY_TONE）；
 * - 文案是 `segments[]`，引用只存 id 不存名字（工作改名、文件改名后历史自动跟随），
 *   渲染层把每个引用渲染成独立按钮 → 一行可同时指「某工作」和「某文件」。
 *
 * 这里全部是纯函数，页面渲染与单测共用，不在渲染层写 mock 文案。
 * 方案与分期：`docs/workspace-overview-activity-plan.zh-CN.md`。
 */

/**
 * 事件类型：与原型 7 类一一对应，命名按产品语汇（工作 = AgentSession）。
 *
 * `kind` 只承担**视觉分组**职责（图标 + 色彩），具体语义由文案决定：
 * 同为 `work-created`，刚建好是「新建了工作」，久未启动只是最近被更新则是「更新了工作」。
 */
export type ActivityKind =
  /** 新建/更新了一项工作（原型 task 的「你创建了工作 X」）。 */
  | 'work-created'
  /** 工作开始执行（原型 task 的「执行到第 N 步」）。 */
  | 'work-run'
  /** 产出等你审阅（原型 review）。P0 暂不产生：审批事件还没落库。 */
  | 'work-review'
  /** 工作结束/交付（原型 done）。 */
  | 'work-done'
  /** 生成了产物（原型 output）。 */
  | 'output'
  /** 添加了材料（原型 material）。 */
  | 'material'
  /** 计划/任务状态变更（原型 plan）。依赖计划事件流接线，P1 之后产生。 */
  | 'plan'
  /** 小 E 产出洞察（原型 insight）。产品已有独立洞察卡，动态默认不出这一类行。 */
  | 'insight'

/** 视觉分组：色彩取语义 token，不写死 hex（主题可切）。 */
export type ActivityTone = 'accent' | 'running' | 'warning' | 'success' | 'muted'

/** kind → tone。页面据此选图标底色，CSS 侧用 `.wb-ov-activity-icon.is-<tone>`。 */
export const ACTIVITY_TONE: Record<ActivityKind, ActivityTone> = {
  'work-created': 'accent',
  'work-run': 'running',
  'work-review': 'warning',
  'work-done': 'success',
  output: 'success',
  material: 'muted',
  plan: 'muted',
  insight: 'accent',
}

/** 文案的一段：纯文本，或一个可点引用。 */
export interface ActivitySegment {
  text?: string
  /** 指向工作会话（AgentSession.id）。 */
  workId?: string
  /** 指向文件库条目（FileCatalogDto.id，不是 OfficeFile.id）。 */
  fileId?: string
  /** 指向计划项（plan 事件，P1 之后使用）。 */
  planItemId?: string
}

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** 一句话文案，分段；引用段由页面渲染成按钮。 */
  segments: ActivitySegment[]
  /** ISO 时间；解析失败时排序沉底。相对时间由页面单独渲染。 */
  at: string
  /**
   * 次级信息（信息密度）：brief / durationSec / error。
   * 服务端派生时来自网关（run 的 prompt 摘要与耗时）；本地回落派生时尽力而为。
   * 缺失时行渲染退回单行文案，与旧版完全一致。
   */
  detail?: ActivityDetail
}

/** 与契约 `WorkspaceActivityDetail` 同构；brief 是展示快照，不跟随改名。 */
export interface ActivityDetail {
  /** 结果摘要（AI 做完事的总结首行）：单行省略展示，title 给全文。 */
  brief?: string
  /** run 耗时（秒）；渲染层格式化为「3 分钟」等。 */
  durationSec?: number
  /** 失败原因（仅 failed 的 run）。 */
  error?: string
  /** 同一工作累计执行次数；>1 时出「N 次」徽标。 */
  runCount?: number
}

/** 概览动态默认最多 12 条（信息密度优化后行高更紧凑，一屏可承载更多；旧值 8）。 */
export const ACTIVITY_COLLAPSED_LIMIT = 12
export const ACTIVITY_EXPANDED_LIMIT = 20

/** 概览只需要会话的这几个字段，方便单测构造最小 fixture。 */
export type SessionActivityInput = Pick<
  AgentSession,
  'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'
>

/** `updatedAt` 与 `createdAt` 落在 1s 内视为「刚建好、还没真正跑过」。 */
const SESSION_CREATED_WINDOW_MS = 1000

function isFreshlyCreated(session: SessionActivityInput): boolean {
  const created = Date.parse(session.createdAt)
  const updated = Date.parse(session.updatedAt)
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false
  return Math.abs(updated - created) <= SESSION_CREATED_WINDOW_MS
}

function sessionKindOf(session: SessionActivityInput): ActivityKind {
  if (session.status === 'running') return 'work-run'
  if (session.status === 'closed' || session.status === 'interrupted') return 'work-done'
  return 'work-created'
}

/** 动词按语义选，kind 只管视觉：同一 `work-created` 下「新建」与「更新」是两句话。 */
function sessionVerbOf(session: SessionActivityInput, t: Translate): string {
  if (session.status === 'running') return t('workbench:activity.workStarted')
  if (session.status === 'closed' || session.status === 'interrupted') return t('workbench:activity.workDone')
  return isFreshlyCreated(session) ? t('workbench:activity.workCreated') : t('workbench:activity.workUpdated')
}

function sessionTimeOf(session: SessionActivityInput): string {
  if (Number.isFinite(Date.parse(session.updatedAt))) return session.updatedAt
  return session.createdAt
}

function sessionActivityOf(session: SessionActivityInput, t: Translate): ActivityItem {
  // 引用段只放 id：真正的名字由页面按 workId 实时解析，工作改名后历史文案自动跟随。
  // 本地回落派生拿不到 run 数据，没有 brief/runCount（网关派生时 brief 来自 AI 回复总结）。
  return {
    id: `session:${session.id}`,
    kind: sessionKindOf(session),
    segments: [{ text: sessionVerbOf(session, t) }, { workId: session.id }],
    at: sessionTimeOf(session),
  }
}

function fileActivityOf(entry: RealOfficeFile, t: Translate): ActivityItem {
  // 判据与产物页共用（artifactKind.ts）：产物只出 output，其余一律算材料。
  const artifact = isArtifactSourceKind(entry.catalog.sourceKind)
  return {
    id: `file:${entry.catalog.id}`,
    kind: artifact ? 'output' : 'material',
    segments: [{ text: artifact ? t('workbench:activity.generated') : t('workbench:activity.addedMaterial') }, { fileId: entry.catalog.id }],
    at: entry.catalog.updatedAt,
  }
}

function timestampOf(item: ActivityItem): number {
  const parsed = Date.parse(item.at)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/** 同一时刻工作事件排在前（人先看「发生了什么工作」，再看「产出了什么」）。 */
function kindRank(item: ActivityItem): number {
  return item.kind === 'output' || item.kind === 'material' ? 1 : 0
}

/** 时间倒序；同一时刻工作在前、文件在后，再按 id 兜底保证稳定。 */
function compareActivities(left: ActivityItem, right: ActivityItem): number {
  const leftTime = timestampOf(left)
  const rightTime = timestampOf(right)
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
  const rank = kindRank(left) - kindRank(right)
  if (rank !== 0) return rank
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export interface BuildActivitiesInput {
  sessions?: readonly SessionActivityInput[]
  files?: readonly RealOfficeFile[]
  /** 翻译器；缺省 zh-CN（单测/离线默认）。 */
  t?: Translate
}

/** 合并「本空间会话 + 文件库条目」，按时间倒序返回完整列表（截断交给 collapseActivities）。 */
export function buildActivities({ sessions = [], files = [], t = translateZh }: BuildActivitiesInput = {}): ActivityItem[] {
  return [
    ...sessions.map((session) => sessionActivityOf(session, t)),
    ...files.map((file) => fileActivityOf(file, t)),
  ].sort(compareActivities)
}

export interface CollapsedActivities {
  visible: ActivityItem[]
  /** 折叠后没显示出来的条数（展开态为超出 20 条的剩余）。 */
  hiddenCount: number
}

/** 动态折叠：默认 8 条，展开后 20 条（需求上限，不再做第二级展开）。 */
export function collapseActivities(
  items: readonly ActivityItem[],
  expanded: boolean,
): CollapsedActivities {
  const limit = expanded ? ACTIVITY_EXPANDED_LIMIT : ACTIVITY_COLLAPSED_LIMIT
  const visible = items.slice(0, limit)
  return { visible, hiddenCount: Math.max(0, items.length - visible.length) }
}

/* ───────────────── 洞察文本 ───────────────── */

/** 洞察摘要最多 4 行、240 字，超出折成一段话加省略号。 */
export const INSIGHT_MAX_LINES = 4
export const INSIGHT_MAX_CHARS = 240

export interface InsightMessageLike {
  role: string
  /** 消息 id：用于洞察「证据」定位；fixture 可省略。 */
  id?: string
  content: string
}

export interface InsightTextDetail {
  text: string
  /** 命中的 assistant 消息 id；消息无 id（fixture / 旧数据）时为 null。 */
  messageId: string | null
}

function isMarkdownNoise(line: string): boolean {
  // 分隔线、表格分隔行、纯 HTML 标签行都不是正文。
  if (/^[-*_]{3,}$/.test(line)) return true
  if (line.includes('|') && /^[\s|:-]+$/.test(line)) return true
  if (/^<[^>]+>$/.test(line)) return true
  return false
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 把一条 assistant 正文折成 2–4 行的短段落；没有正文时返回 null。 */
export function normalizeInsightText(raw: string): string | null {
  if (!raw || !raw.trim()) return null
  const lines = raw.split(/\r?\n/)
  const picked: string[] = []
  let inFence = false
  let truncated = false
  let chars = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || !trimmed) continue
    if (isMarkdownNoise(trimmed)) continue
    const cleaned = stripInlineMarkdown(trimmed)
    if (!cleaned) continue
    if (picked.length >= INSIGHT_MAX_LINES) {
      truncated = true
      break
    }
    if (picked.length > 0 && chars + cleaned.length > INSIGHT_MAX_CHARS) {
      truncated = true
      break
    }
    picked.push(cleaned)
    chars += cleaned.length + 1
  }

  if (picked.length === 0) return null
  const full = picked.join('\n')
  const clipped = full.length > INSIGHT_MAX_CHARS ? full.slice(0, INSIGHT_MAX_CHARS).trimEnd() : full
  return truncated || clipped !== full ? `${clipped}…` : clipped
}

/** 从会话消息里取最后一条有正文的 assistant 消息，折成洞察文本与命中消息 id。 */
export function extractInsightDetail(
  messages: readonly InsightMessageLike[],
): InsightTextDetail | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = normalizeInsightText(message.content)
    if (text) return { text, messageId: message.id ?? null }
  }
  return null
}

/** 从会话消息里取最后一条有正文的 assistant 消息，折成洞察文本。 */
export function extractInsightText(messages: readonly InsightMessageLike[]): string | null {
  return extractInsightDetail(messages)?.text ?? null
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/**
 * 消息快照为空时的兜底：把 run 事件里的 `message.completed` / `message.delta`
 * 折回一段 assistant 正文。
 */
export function insightTextFromEvents(events: readonly AgentEvent[]): string | null {
  let completed: string | null = null
  const deltas: string[] = []

  for (const event of events) {
    if (event.type === 'message.delta') {
      const delta = readPayloadString(event.payload, 'delta')
      if (delta) deltas.push(delta)
      continue
    }
    if (event.type === 'message.completed') {
      const content = readPayloadString(event.payload, 'content')
      const role = readPayloadString(event.payload, 'role')
      if (content?.trim() && (role === null || role === 'assistant')) completed = content
    }
  }

  const fromCompleted = completed ? normalizeInsightText(completed) : null
  if (fromCompleted) return fromCompleted
  const streamed = deltas.join('')
  return streamed ? normalizeInsightText(streamed) : null
}
