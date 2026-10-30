import { Brain } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

function reasoningParagraphs(content: string): string[] {
  // 思考流是纯文本增量：按空行分段渲染，不走 Markdown 解析
  //（流式期间每帧全量重解析长思考串会把主线程打满，参考 FormattedAgentText 的教训）。
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Agent 思考过程（reasoning.delta 累积文本）：默认折叠的 <details>，
 * summary 运行中显示「思考中…」、结束后显示「思考过程 · N 字」。
 * 默认折叠、绝不自动展开；用户展开且 run 仍在进行时，内容自动跟随流式滚到底部。
 */
export const ReasoningBlock = memo(function ReasoningBlock({
  active = false,
  content,
}: {
  /** run 仍在进行（reasoning.delta 还在流式到达）。 */
  active?: boolean
  content: string
}) {
  const { t } = useLocale()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const paragraphs = reasoningParagraphs(content)
  const charCount = content.trim().length

  useEffect(() => {
    const details = detailsRef.current
    const element = contentRef.current
    // details 关闭时内容 display:none，scrollTop 不生效；只在展开 + 运行中跟随。
    if (!details?.open || !element || !active) return
    element.scrollTop = element.scrollHeight
  }, [active, paragraphs])

  if (charCount === 0) return null

  return (
    <details className="agent-reasoning" data-active={String(active)} ref={detailsRef}>
      <summary>
        <Brain aria-hidden="true" strokeWidth={1.8} />
        {active
          ? t('surface:agentChat.thinking')
          : t('surface:agentChat.reasoningProcess', { count: charCount })}
      </summary>
      <div className="agent-reasoning-content" ref={contentRef}>
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </details>
  )
})
