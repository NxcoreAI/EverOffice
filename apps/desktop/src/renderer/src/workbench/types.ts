import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import { translate, translateZh, type AppLocale, type Translate } from '@/i18n/LocaleContext'

/* ───────────────── 主页标签 ───────────────── */

/**
 * 主页侧栏的页面入口（只保留有真实数据能力的页面；知识库后端已移除，不迁移）。
 * 设置与其它五个页面平级，只是排到侧栏底部单独一组。
 */
export type HomePageKey = 'recent' | 'spaces' | 'files' | 'agent' | 'skills' | 'connectors' | 'settings'

export const HOME_PAGES: ReadonlyArray<{ key: HomePageKey; labelKey: string }> = [
  { key: 'recent', labelKey: 'workbench:nav.recent' },
  { key: 'spaces', labelKey: 'workbench:nav.spaces' },
  { key: 'files', labelKey: 'workbench:nav.files' },
  { key: 'agent', labelKey: 'workbench:nav.agent' },
  { key: 'skills', labelKey: 'workbench:nav.skills' },
  { key: 'connectors', labelKey: 'workbench:nav.connectors' },
  { key: 'settings', labelKey: 'workbench:nav.settings' },
]

/* ───────────────── 工作空间标签 ───────────────── */

/** 工作空间侧栏的功能菜单（「新建工作」是即开的会话，不是页面）。 */
export type WorkspacePageKey = 'overview' | 'library' | 'outputs' | 'plan'

export const WORKSPACE_PAGES: ReadonlyArray<{ key: WorkspacePageKey; labelKey: string }> = [
  { key: 'overview', labelKey: 'workbench:workspacePage.overview' },
  { key: 'library', labelKey: 'workbench:workspacePage.library' },
  { key: 'outputs', labelKey: 'workbench:workspacePage.outputs' },
  { key: 'plan', labelKey: 'workbench:workspacePage.plan' },
]

/**
 * 工作空间标签内的视图：
 * - page：功能页（概览/资料库/产物/计划）
 * - session：某个工作会话（= 一个 AgentSession）
 * - draft：新建工作草稿；首条消息发出后落成会话，视图切到 session
 */
export type WorkspaceTabView =
  | { kind: 'page'; page: WorkspacePageKey }
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft' }

export const DEFAULT_WORKSPACE_VIEW: WorkspaceTabView = { kind: 'page', page: 'overview' }

/* ───────────────── 窗口级标签 ───────────────── */

export interface HomeTab {
  id: 'home'
  kind: 'home'
  /** 主页标签记住上次停留的页面（标签间切换不丢）。 */
  page: HomePageKey
}

export interface WorkspaceTab {
  id: string
  kind: 'workspace'
  workspaceId: string
  /** 空间必须存在才会被渲染（启动恢复时会校验）。 */
  view: WorkspaceTabView
}

export type WindowTab = HomeTab | WorkspaceTab

export const HOME_TAB_ID = 'home' as const
export const HOME_TAB: HomeTab = { id: HOME_TAB_ID, kind: 'home', page: 'recent' }

export const workspaceTabId = (workspaceId: string): string => `ws:${workspaceId}`

/** 默认工作区是应用种子数据；展示时按当前语言本地化，用户改过名则保留原名。 */
const DEFAULT_WORKSPACE_SEED_NAMES = new Set(['默认工作区', 'Default workspace'])

export function workspaceDisplayName(
  workspace: AgentWorkspace,
  locale: AppLocale = 'zh-CN',
): string {
  const preferred = workspace.nameEn?.trim()
  if (locale === 'en-US' && preferred) return preferred
  if (workspace.kind === 'default' && DEFAULT_WORKSPACE_SEED_NAMES.has(workspace.name.trim())) {
    return translate(locale, 'workbench:common.defaultWorkspace')
  }
  return workspace.name
}

/** 标签标题：主页固定、工作空间显示空间名。 */
export function tabTitle(
  tab: WindowTab,
  workspaces: readonly AgentWorkspace[],
  locale: AppLocale = 'zh-CN',
): string {
  if (tab.kind === 'home') return translate(locale, 'workbench:common.home')
  const workspace = workspaces.find((item) => item.id === tab.workspaceId)
  return workspace ? workspaceDisplayName(workspace, locale) : translate(locale, 'workbench:common.workspace')
}

/* ───────────────── 工作会话（= AgentSession） ───────────────── */

export type WorkSessionStatus = 'running' | 'idle' | 'done'

export const WORK_SESSION_STATUS_META: Record<WorkSessionStatus, { labelKey: string }> = {
  running: { labelKey: 'workbench:status.running' },
  idle: { labelKey: 'workbench:status.idle' },
  done: { labelKey: 'workbench:status.done' },
}

/** 看板/工作列表共用的状态归一：interrupted 也归入已结束（可点开继续对话）。 */
export function workSessionStatus(session: AgentSession): WorkSessionStatus {
  if (session.status === 'running') return 'running'
  if (session.status === 'closed' || session.status === 'interrupted') return 'done'
  return 'idle'
}

/** 侧栏会话排序：运行中优先，然后按更新时间倒序。 */
export function sortWorkbenchSessions(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => {
    const leftRunning = left.status === 'running' ? 1 : 0
    const rightRunning = right.status === 'running' ? 1 : 0
    if (leftRunning !== rightRunning) return rightRunning - leftRunning
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  })
}

export function sessionsOfWorkspace(
  sessions: readonly AgentSession[],
  workspaceId: string | null,
): AgentSession[] {
  if (!workspaceId) return []
  return sortWorkbenchSessions(sessions.filter((session) => session.workspaceId === workspaceId))
}

export function runningSessionCount(
  sessions: readonly AgentSession[],
  workspaceId: string | null,
): number {
  if (!workspaceId) return 0
  return sessions.filter((session) => session.workspaceId === workspaceId && session.status === 'running').length
}

/** 会话显示标题：未命名会话用于草稿态的占位。 */
export function sessionDisplayTitle(
  session: AgentSession | null | undefined,
  t: Translate = translateZh,
): string {
  const title = session?.title?.trim()
  if (title) return title
  return t('workbench:common.newWork')
}

/** 相对时间：侧栏、概览动态、列表共用（刚刚 / 5 分钟 / 2 小时 / 昨天 / 10月20日）。 */
export function relativeTimeLabel(
  iso: string | null | undefined,
  t: Translate = translateZh,
): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const delta = Date.now() - time
  if (delta < 60_000) return t('workbench:time.justNow')
  if (delta < 60 * 60_000) return t('workbench:time.minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 24 * 60 * 60_000) return t('workbench:time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
  if (delta < 48 * 60 * 60_000) return t('workbench:time.yesterday')
  const date = new Date(time)
  return t('workbench:time.monthDay', { month: date.getMonth() + 1, day: date.getDate() })
}

/** 「MM/DD」短日期（概览 meta 行的开始日）。 */
export function shortDateLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** run 耗时（概览动态行尾的小徽标）：45s / 3 分钟 / 2.5 小时，向上取整。 */
export function durationLabel(
  seconds: number | null | undefined,
  t: Translate = translateZh,
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return t('workbench:time.durationSeconds', { count: Math.ceil(seconds) })
  if (seconds < 3600) return t('workbench:time.durationMinutes', { count: Math.ceil(seconds / 60) })
  return t('workbench:time.durationHours', { count: Math.round((seconds / 3600) * 10) / 10 })
}

/* ───────────────── 标签持久化 ───────────────── */

export interface PersistedWorkspaceTab {
  workspaceId: string
}

export const TABS_STORAGE_KEY = 'everroom:workbench:tabs:v1'

/** 只持久化「打开过的工作空间」与激活标签（文件不再独立开标签，无恢复问题）。 */
export interface PersistedTabsState {
  workspaceIds: string[]
  activeTabId: string | null
}

export function readPersistedTabs(): PersistedTabsState {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    if (!raw) return { workspaceIds: [], activeTabId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedTabsState>
    return {
      workspaceIds: Array.isArray(parsed.workspaceIds)
        ? parsed.workspaceIds.filter((value): value is string => typeof value === 'string')
        : [],
      activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
    }
  } catch {
    return { workspaceIds: [], activeTabId: null }
  }
}

export function writePersistedTabs(state: PersistedTabsState): void {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
}
