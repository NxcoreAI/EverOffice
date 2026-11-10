import { useState } from 'react'
import { Bot } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'

import { workbenchToast } from '../shell/toast'
import { useAgentPersona } from './useAgentPersona'

/**
 * 主页「Agent」页。
 *
 * **页面代码直接复制自原型 `office-proto/pages/AgentView.tsx`**（页头 / Hero / Seg /
 * `.op-info-card` 卡片），样式全部沿用 `office-proto.css`（`main.tsx` 已全局引入），
 * 这里不另造样式，只做两件事：
 *   1. 把原型里的 mock 数据换成网关真实数据（`useAgentPersona`：人格 / 用户画像 / 经验）；
 *   2. 原型的六个 tab 里，我们在这页有数据源的是「人格 / 用户画像 / 经验」，其余
 *      （知识卡片 / 会话记录 / MCP 工具 / Skills）各有自己的页面，不在这里重复造。
 */

type AgentTab = 'persona' | 'profile' | 'insights'

const agentTabs: { key: AgentTab; labelKey: string }[] = [
  { key: 'persona', labelKey: 'workbench:home.agent.tabPersona' },
  { key: 'profile', labelKey: 'workbench:home.agent.tabProfile' },
  { key: 'insights', labelKey: 'workbench:home.agent.tabInsights' },
]

/* ───────────── 以下两段结构复制自 `office-proto/pages/parts.tsx` ─────────────
   只复制 PageHead / Seg 的 JSX 与类名：parts.tsx 本身 import 了原型的 mock 文件数据，
   整包引进来会把 mock 打进工作台 bundle。 */

function PageHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="op-page-head">
      <div className="op-page-head-text">
        <h1>{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
    </header>
  )
}

function Seg<T extends string>({
  items, value, onChange,
}: {
  items: { key: T; label: string }[]
  value: T
  onChange: (key: T) => void
}) {
  return (
    <div className="op-seg" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={`op-seg-btn${value === item.key ? ' active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/* ───────────── 原型三个 tab 的同一套结构，数据换成真实数据 ───────────── */

/** 人格：原型 `PersonaTab`（`op-info-card op-persona-card` + 技能 chips + 提示词摘要）。 */
function PersonaTab({ persona }: {
  persona: { name: string; tagline: string; skills: string[]; promptSummary: string }
}) {
  const { t } = useLocale()
  return (
    <section className="op-info-card op-persona-card">
      <div className="op-persona-head">
        <div className="op-agent-avatar sm"><Bot size={17} /></div>
        <div className="op-persona-head-text">
          <div className="op-info-title">{persona.name}</div>
        </div>
      </div>
      {persona.skills.length > 0 && (
        <div className="op-chips">
          {persona.skills.map((skill) => <span key={skill} className="op-chip">{skill}</span>)}
        </div>
      )}
      {persona.promptSummary ? (
        <div className="op-persona-prompt">
          <div className="op-persona-prompt-label">{t('workbench:home.agent.promptSummaryLabel')}</div>
          <p>{persona.promptSummary}</p>
        </div>
      ) : null}
    </section>
  )
}

/** 用户画像：原型 `ProfileTab`（`op-profile-grid` + 每组一张 `op-info-card`）。 */
function ProfileTab({ groups }: {
  groups: { title: string; items: { id: string; content: string }[] }[]
}) {
  return (
    <div className="op-profile-grid">
      {groups.map((group) => (
        <section key={group.title} className="op-info-card">
          <div className="op-info-title">{group.title}</div>
          <ul>
            {group.items.map((item) => <li key={item.id}>{item.content}</li>)}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * 读取失败 ≠ 真的没有：接口 400/网络异常时绝不能显示「还没有用户画像」
 * （用户会以为自己的信息没被记住）。样式沿用原型 `.op-empty`，只加一个就地重试。
 */
function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useLocale()
  return (
    <div className="op-empty" role="alert">
      {message}
      <button className="op-ghost-btn" type="button" onClick={onRetry} style={{ marginLeft: 10 }}>{t('workbench:home.common.retry')}</button>
    </div>
  )
}

/** 经验：原型没有这个 tab，沿用同一张 `op-info-card` 与列表结构。 */
function InsightsTab({ items }: { items: { id: string; text: string; whenLabel: string }[] }) {
  const { t } = useLocale()
  return (
    <section className="op-info-card">
      <div className="op-info-title">{t('workbench:home.agent.insightsTitle')}</div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.text}
            {item.whenLabel && <span className="wb-home-exp-meta">{item.whenLabel}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AgentPage() {
  const { t } = useLocale()
  const [tab, setTab] = useState<AgentTab>('profile')
  const { state, reload } = useAgentPersona()

  const persona = state.status === 'ready' ? state.value.persona : null
  const profile = state.status === 'ready' ? state.value.profile : []
  const experiences = state.status === 'ready' ? state.value.experiences : []
  const failed = state.status === 'ready' ? state.value.failed : { profile: false, experiences: false }
  const ready = state.status === 'ready'
  const tabs = agentTabs.map((item) => ({ key: item.key, label: t(item.labelKey) }))

  /** 调试面板是独立窗口：这里只触发主进程开窗（单例），失败给出可读提示。 */
  const openAgentDebug = () => {
    const api = window.nxcore?.agentDebug
    if (!api?.openWindow) {
      workbenchToast(t('workbench:home.agent.debugUnavailable'))
      return
    }
    void api.openWindow().catch((error: unknown) => {
      workbenchToast(error instanceof Error ? error.message : t('workbench:home.agent.debugOpenFailed'))
    })
  }

  return (
    <div className="wb-home-scroll wb-home-agent-host">
      <PageHead title={t('workbench:home.agent.title')} />

      <section className="op-agent-hero">
        <div className="op-agent-avatar"><Bot size={24} /></div>
        <div className="op-agent-hero-text">
          <div className="op-agent-hero-name">
            {persona?.name ?? t('workbench:home.agent.defaultName')}
            <span className={`op-pill${ready ? ' on' : ''}`}>
              <i className={`op-dot${ready ? ' on' : ''}`} />
              {state.status === 'error'
                ? t('workbench:home.agent.statusDisconnected')
                : ready ? t('workbench:home.agent.statusRunning') : t('workbench:home.agent.statusConnecting')}
            </span>
          </div>
        </div>
        <button className="op-ghost-btn" type="button" title={t('workbench:home.agent.debugTitle')} onClick={openAgentDebug}>{t('workbench:home.agent.debug')}</button>
      </section>

      {state.status === 'error' ? (
        <ReadFailed message={t('workbench:home.agent.personaFailed')} onRetry={reload} />
      ) : state.status === 'loading' ? (
        <div className="op-empty">{t('workbench:home.agent.loading')}</div>
      ) : (
        <>
          <Seg items={tabs} value={tab} onChange={setTab} />

          <div className="op-agent-body">
            {tab === 'persona' && (persona
              ? <PersonaTab persona={persona} />
              : <div className="op-empty">{t('workbench:home.agent.noPersona')}</div>)}

            {tab === 'profile' && (failed.profile
              ? <ReadFailed message={t('workbench:home.agent.profileFailed')} onRetry={reload} />
              : profile.length > 0
                ? <ProfileTab groups={profile} />
                : <div className="op-empty">{t('workbench:home.agent.profileEmpty')}</div>)}

            {tab === 'insights' && (failed.experiences
              ? <ReadFailed message={t('workbench:home.agent.experiencesFailed')} onRetry={reload} />
              : experiences.length > 0
                ? <InsightsTab items={experiences} />
                : <div className="op-empty">{t('workbench:home.agent.experiencesEmpty')}</div>)}
          </div>
        </>
      )}
    </div>
  )
}
