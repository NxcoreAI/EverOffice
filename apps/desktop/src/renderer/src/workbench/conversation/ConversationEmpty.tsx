import type { ReactNode } from 'react'
import { ClipboardList, FileText, LineChart, Presentation } from 'lucide-react'

import { BrandRibbon } from '@/components/ui/BrandRibbon'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * 主区空态 hero（品牌时刻）：缎带 + 问候 + 大输入框 + 建议 chips。
 *
 * 纯展示组件：输入内容由 ConversationPane 持有（首条发送走 useAgentSession.sendPrompt，
 * 网关侧自动建会话）。输入框本体已换成 AgentComposer（与会话态同一组件），因此
 * 「智能档位」「+」等底栏控件在草稿态同样可用——这里只保留 hero 版式（缎带/标题/
 * 批注徽章/建议 chips），输入框通过 children 插槽注入。
 */
export interface ConversationEmptyProps {
  /** hero 版式内渲染的大输入框（AgentComposer + 批注徽章）。 */
  children: ReactNode
  /** 渲染在大输入框正上方的附加行（待发送批注徽章）：hero 垂直居中，外挂会飘到很上面。 */
  aboveInput?: ReactNode
  /** 点建议 chip：把建议文案填进输入框（由 ConversationPane 持有草稿）。 */
  onSuggestion?: (prompt: string) => void
}

interface HeroSuggestion {
  id: string
  labelKey: string
  promptKey: string
  Icon: typeof FileText
}

const HERO_SUGGESTIONS: HeroSuggestion[] = [
  { id: 'weekly', labelKey: 'workbench:conversation.suggestWeekly', promptKey: 'workbench:conversation.promptWeekly', Icon: FileText },
  { id: 'data', labelKey: 'workbench:conversation.suggestData', promptKey: 'workbench:conversation.promptData', Icon: LineChart },
  { id: 'slides', labelKey: 'workbench:conversation.suggestSlides', promptKey: 'workbench:conversation.promptSlides', Icon: Presentation },
  { id: 'minutes', labelKey: 'workbench:conversation.suggestMinutes', promptKey: 'workbench:conversation.promptMinutes', Icon: ClipboardList },
]

export function ConversationEmpty({ children, aboveInput, onSuggestion }: ConversationEmptyProps) {
  const { t } = useLocale()

  return (
    <div className="wb-conversation-hero">
      <div className="wb-hero">
        <div className="wb-hero-brand">
          <BrandRibbon size={44} animated />
        </div>

        <h1 className="wb-hero-title">{t('workbench:conversation.heroTitle')}</h1>

        {/* 附加行（待发送批注徽章）与输入框放在**同一个列容器**里：左边缘天然与输入框
            对齐（gap 给出 8px 间距），不再靠两行各自 100% 宽度去"看起来对齐"。 */}
        <div className="wb-hero-input">
          {aboveInput ? <div className="wb-hero-above-input">{aboveInput}</div> : null}
          {children}
        </div>

        <div className="wb-hero-chips" aria-label={t('workbench:conversation.suggestionsLabel')}>
          {HERO_SUGGESTIONS.map(({ id, labelKey, promptKey, Icon }) => (
            <button
              key={id}
              type="button"
              className="wb-hero-chip"
              onClick={() => onSuggestion?.(t(promptKey))}
            >
              <Icon aria-hidden="true" />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
