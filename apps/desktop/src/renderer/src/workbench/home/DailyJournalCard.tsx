import { RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { JournalActionDto } from '@/shared/sources'

import { Button } from '../ui/primitives'
import { useDailyJournal } from './useDailyJournal'

/**
 * 「今日洞察」卡片（最近页顶部）：当天日记的 headline / summary / 要点 / 动作。
 *
 * 全部文案来自 `window.nxcore.journal.today()`（见 `useDailyJournal`）：
 * 没有桥、网关失败、当天还没生成时各自给一个诚实的空态，**不垫任何 mock 文案**。
 * 动作不自己落地：`onAction` 抛给页面（文件用哪个标签打开、会话开在哪里是页面的事）。
 */

/** 摘要的逐字出现节奏：与 `office-proto/pages/RecentView.tsx` 的 `useTypewriter` 一致。 */
const TYPE_INTERVAL_MS = 24
const TYPE_STEP = 2

function prefersReducedMotion(): boolean {
  // 单测/预览环境可能没有 matchMedia：没有就按「没开减少动效」处理。
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 打字机：`nonce` 变化（换了版本）就从头再打一遍；减少动效偏好下直接全文。 */
function useTypewriter(text: string, nonce: string): string {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setCount(text.length)
      return
    }
    setCount(0)
    const id = window.setInterval(() => {
      setCount((current) => {
        if (current >= text.length) {
          window.clearInterval(id)
          return current
        }
        return Math.min(current + TYPE_STEP, text.length)
      })
    }, TYPE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [text, nonce])

  return text.slice(0, count)
}

export interface DailyJournalCardProps {
  /** 动作按钮的回调：`open-file` / `ask-agent` 的落地在页面里。 */
  onAction?: (action: JournalActionDto) => void
}

export function DailyJournalCard({ onAction }: DailyJournalCardProps) {
  const { t } = useLocale()
  const journal = useDailyJournal()
  const titleId = useId()
  const entry = journal.entry
  const summary = entry?.summary ?? ''
  // 版本号进 nonce：网关重写当天后（version+1）摘要重新逐字出现。
  const shown = useTypewriter(summary, entry ? `${entry.id}#${entry.version}` : '')
  const typing = shown.length < summary.length

  return (
    <section className="wb-journal-card" aria-labelledby={titleId}>
      <header className="wb-journal-head">
        <span className="wb-journal-icon" aria-hidden="true"><Sparkles size={15} /></span>
        {/* 用 div 而不是 span 包 h2：h2 是流内容，塞进 span 里是非法嵌套。 */}
        <div className="wb-journal-title">
          <h2 className="wb-journal-name" id={titleId}>{t('workbench:home.journal.title')}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="wb-journal-refresh"
          title={t('workbench:home.journal.refreshTitle')}
          disabled={journal.refreshing}
          onClick={journal.refresh}
          icon={<RefreshCw size={12} className={journal.refreshing ? 'ui-spin' : undefined} aria-hidden="true" />}
        >
          {journal.refreshing ? t('workbench:home.journal.refreshing') : t('workbench:home.journal.refresh')}
        </Button>
      </header>

      {journal.state === 'loading' ? (
        <div className="wb-journal-state">
          <span className="wb-journal-skel" aria-hidden="true" />
          {t('workbench:home.journal.loading')}
        </div>
      ) : null}

      {journal.state === 'unavailable' ? (
        <div className="wb-journal-state">
          {t('workbench:home.journal.unavailable')}
          <Button variant="ghost" size="sm" onClick={journal.reload}>{t('workbench:home.common.retry')}</Button>
        </div>
      ) : null}

      {journal.state === 'failed' ? (
        <div className="wb-journal-state">
          {journal.lastError ?? t('workbench:home.journal.failed')}
          <Button variant="ghost" size="sm" onClick={journal.reload}>{t('workbench:home.common.retry')}</Button>
        </div>
      ) : null}

      {journal.state === 'empty' ? (
        <p className="wb-journal-empty">{t('workbench:home.journal.empty')}</p>
      ) : null}

      {journal.state === 'ready' && entry ? (
        <>
          <p className="wb-journal-headline">{entry.headline}</p>
          <p className="wb-journal-body">
            {shown}
            {typing ? <span className="wb-journal-caret" aria-hidden="true" /> : null}
          </p>
          {entry.bullets.length > 0 ? (
            <ul className="wb-journal-bullets">
              {entry.bullets.map((bullet, index) => (
                // title 留全文：以后做可追溯来源时，仍需在不解析 sourceIds 的前提下能看全。
                <li key={`${index}:${bullet.text}`} title={bullet.text}>
                  <span className="wb-journal-bullet-dot" aria-hidden="true" />
                  {bullet.text}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.advice && entry.advice.length > 0 ? (
            <ul className="wb-journal-advice" aria-label={t('workbench:home.journal.adviceAria')}>
              {entry.advice.map((line, index) => (
                <li key={`${index}:${line}`}>
                  <span className="wb-journal-advice-tag" aria-hidden="true">{t('workbench:home.journal.adviceTag')}</span>
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {journal.refreshError ? <p className="wb-journal-hint">{journal.refreshError}</p> : null}

      <footer className="wb-journal-foot">
        {entry && entry.actions.length > 0 ? (
          <span className="wb-journal-actions">
            {entry.actions.map((action, index) => (
              <button
                key={`${action.kind}:${action.targetId}:${index}`}
                type="button"
                className="wb-journal-act"
                title={action.label}
                onClick={() => onAction?.(action)}
              >
                {action.label}
              </button>
            ))}
          </span>
        ) : null}
        <span className="wb-journal-sign">{t('workbench:home.journal.sign')}</span>
      </footer>
    </section>
  )
}
