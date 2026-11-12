import { memo, useEffect, useState, type ReactNode } from 'react'
import { Check, FileText, LoaderCircle, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkCjkFriendly } from '@/lib/markdown/remarkCjkFriendly'

import { useLocale } from '@/i18n/LocaleContext'
import { dispatchOpenCloudDocument } from '@/workbench/shell/openAgentFile'

import type { PendingShellApproval } from './agentShellApprovals'

/** 决策卡回填：confirm → approved/denied（+反馈）；question → choice/text（作答）。 */
export type AgentCardResolve = (
  approvalId: string,
  decision: 'approved' | 'approved_session' | 'denied',
  feedback?: string,
  choice?: string,
  text?: string,
) => void

// 与气泡/详情区同口径：标题降级、链接新开、无图。卡片空间小，正文行内元素
// 之外不支持块级列表/表格（body 由 gateway 裁到 2000 字，plan/notes 是单行条目）。
const cardInlineMarkdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  h2: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  h3: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  h4: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  h5: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  h6: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  p: ({ children }: { children?: ReactNode }) => <>{children}</>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  img: () => null,
} as const

/** 卡片正文（body）：完整 Markdown 块级渲染；排版样式在 AgentChat.css 的
 *  .agent-decision-card-body 一组规则里（不挂 agent-markdown——那套样式锚定在
 *  .agent-message 气泡内，卡片套上拿不到样式反而误导）。 */
const CardBodyMarkdown = memo(function CardBodyMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-decision-card-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={cardInlineMarkdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** plan/notes 单行条目：按行内 Markdown 渲染（粗体/行内代码/链接），块级降级为行内。 */
const CardLineMarkdown = memo(function CardLineMarkdown({ text }: { text: string }) {
  return (
    <span className="agent-decision-card-line">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={cardInlineMarkdownComponents}>
        {text}
      </ReactMarkdown>
    </span>
  )
})

/**
 * 通用决策卡（agent_confirm 计划确认 / agent_ask_user 提问）。
 * 复用审批卡骨架样式；confirm 展示计划/色板/字体/要点并收「确认/取消+反馈」，
 * question 展示候选按钮与自由输入并收「选项/文本」。
 *
 * confirm 卡带 document（演示文稿计划已落成云文档）时，计划以云文档为主体展示：
 * 卡片到达即自动打开计划文档一次，并给出「打开计划云文档」入口；完整步骤折叠，
 * 避免把十几步计划摊成一面墙。同一 approvalId 只自动打开一次（重渲染/回放不重开）。
 */
const autoOpenedPlanDocuments = new Set<string>()
export function AgentDecisionCard({
  approval,
  busy,
  onResolve,
}: {
  approval: PendingShellApproval
  busy: boolean
  onResolve: AgentCardResolve
}) {
  const { t } = useLocale()
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')
  const card = approval.card
  if (!card) return null

  const isConfirm = card.kind === 'confirm'
  const title = isConfirm ? t('surface:agentChat.cardConfirmTitle') : t('surface:agentChat.cardQuestionTitle')

  const planDocument = card.document
  useEffect(() => {
    if (!planDocument) return
    if (autoOpenedPlanDocuments.has(approval.approvalId)) return
    autoOpenedPlanDocuments.add(approval.approvalId)
    dispatchOpenCloudDocument({ documentId: planDocument.id, title: planDocument.title })
  }, [planDocument, approval.approvalId])

  const submitAnswer = () => {
    const trimmed = answer.trim()
    if (!trimmed) return
    // question 的作答走 choice（与 gateway resolveApproval 的 choice/text 口径一致）；
    // decision 传 approved 让事件流按「已作答」收口（choice 非空即 resolveAgentCard 命中）。
    onResolve(approval.approvalId, 'approved', undefined, trimmed, trimmed)
  }

  const submitOption = (option: string) => {
    onResolve(approval.approvalId, 'approved', undefined, option, option)
  }

  return (
    <section className="agent-shell-approval" aria-label={title}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon">
          {isConfirm ? <ShieldAlert aria-hidden="true" /> : <MessageCircleQuestion aria-hidden="true" />}
        </span>
        <span>
          <strong>{title}</strong>
          <small>{card.title}</small>
        </span>
      </header>

      {planDocument ? (
        <button
          type="button"
          className="agent-decision-card-document"
          onClick={() => dispatchOpenCloudDocument({ documentId: planDocument.id, title: planDocument.title })}
        >
          <FileText size={14} aria-hidden="true" />
          <span>{t('surface:agentChat.cardOpenPlanDocument', { title: planDocument.title })}</span>
        </button>
      ) : null}

      {card.body ? <CardBodyMarkdown text={card.body} /> : null}

      {card.plan && card.plan.length > 0 ? (
        planDocument ? (
          <details className="agent-decision-card-steps">
            <summary>{t('surface:agentChat.cardPlanSteps', { count: card.plan.length })}</summary>
            <ol className="agent-decision-card-plan">
              {card.plan.map((step, index) => (
                <li key={index}><CardLineMarkdown text={step} /></li>
              ))}
            </ol>
          </details>
        ) : (
          <ol className="agent-decision-card-plan">
            {card.plan.map((step, index) => (
              <li key={index}><CardLineMarkdown text={step} /></li>
            ))}
          </ol>
        )
      ) : null}

      {card.palette && card.palette.length > 0 ? (
        <div className="agent-decision-card-swatches">
          {card.palette.map((color) => (
            <span key={color} className="agent-decision-card-swatch">
              <span className="agent-decision-card-swatch-chip" style={{ background: color }} />
              <small>{color}</small>
            </span>
          ))}
        </div>
      ) : null}

      {card.fonts && (card.fonts.heading || card.fonts.body) ? (
        <div className="agent-decision-card-fonts">
          <span>{t('surface:agentChat.cardFonts')}</span>
          {card.fonts.heading ? <code>{card.fonts.heading}</code> : null}
          {card.fonts.body ? <code>{card.fonts.body}</code> : null}
        </div>
      ) : null}

      {card.notes && card.notes.length > 0 ? (
        <ul className="agent-decision-card-notes">
          {card.notes.map((note, index) => (
            <li key={index}><CardLineMarkdown text={note} /></li>
          ))}
        </ul>
      ) : null}

      {isConfirm ? (
        <>
          <textarea
            className="agent-decision-card-input"
            value={feedback}
            placeholder={t('surface:agentChat.cardConfirmFeedbackPlaceholder')}
            rows={2}
            disabled={busy}
            onChange={(event) => { setFeedback(event.target.value) }}
          />
          <footer>
            <button
              type="button"
              className="agent-shell-deny"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'denied', feedback.trim() || undefined, 'denied', feedback.trim() || undefined)}
            >
              <X aria-hidden="true" />
              {t('surface:agentChat.cardCancel')}
            </button>
            <button
              type="button"
              className="agent-shell-approve"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'approved', feedback.trim() || undefined, 'approved', feedback.trim() || undefined)}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              {t('surface:agentChat.cardConfirm')}
            </button>
          </footer>
        </>
      ) : (
        <>
          {card.options && card.options.length > 0 ? (
            <div className="agent-decision-card-options">
              {card.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="agent-decision-card-option"
                  disabled={busy}
                  onClick={() => { submitOption(option) }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {(!card.options || card.options.length === 0 || card.allowText !== false) ? (
            <>
              <textarea
                className="agent-decision-card-input"
                value={answer}
                placeholder={t('surface:agentChat.cardAnswerPlaceholder')}
                rows={2}
                disabled={busy}
                onChange={(event) => { setAnswer(event.target.value) }}
              />
              <footer>
                <button
                  type="button"
                  className="agent-shell-deny"
                  disabled={busy}
                  onClick={() => onResolve(approval.approvalId, 'denied')}
                >
                  <X aria-hidden="true" />
                  {t('surface:agentChat.cardCancel')}
                </button>
                <button
                  type="button"
                  className="agent-shell-approve"
                  disabled={busy || !answer.trim()}
                  onClick={submitAnswer}
                >
                  {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                  {t('surface:agentChat.cardSubmit')}
                </button>
              </footer>
            </>
          ) : (
            <footer>
              <button
                type="button"
                className="agent-shell-deny"
                disabled={busy}
                onClick={() => onResolve(approval.approvalId, 'denied')}
              >
                <X aria-hidden="true" />
                {t('surface:agentChat.cardCancel')}
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  )
}
