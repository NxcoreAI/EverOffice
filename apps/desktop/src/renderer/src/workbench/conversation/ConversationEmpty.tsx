import { ArrowUp, ClipboardList, FileText, LineChart, Presentation } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'

import { BrandRibbon } from '@/components/ui/BrandRibbon'

/**
 * 主区空态 hero（品牌时刻）：缎带 + 问候 + 大输入框 + 建议 chips。
 *
 * 纯展示组件：输入内容由 ConversationPane 持有（首条发送走 useAgentSession.sendPrompt，
 * 网关侧自动建会话）。会话态改用 AgentComposer，所以这里保持一个简洁 textarea。
 */
export interface ConversationEmptyProps {
  draft: string
  /** 连接中/未就绪时禁用发送。 */
  disabled: boolean
  /** 建议 chips：点击填入输入框（不直接发送，给用户改一改的机会）。 */
  workspaceName: string | null
  onDraftChange: (value: string) => void
  onSubmit: () => void
}

interface HeroSuggestion {
  label: string
  prompt: string
  Icon: typeof FileText
}

const HERO_SUGGESTIONS: HeroSuggestion[] = [
  { label: '写周报', prompt: '帮我写一份本周的工作周报', Icon: FileText },
  { label: '分析数据', prompt: '帮我分析一份数据表，找出关键趋势和异常', Icon: LineChart },
  { label: '做 PPT', prompt: '帮我把这些材料整理成一份演示文稿', Icon: Presentation },
  { label: '整理会议纪要', prompt: '帮我整理会议纪要，提炼结论和待办事项', Icon: ClipboardList },
]

const HERO_PLACEHOLDER = '今天帮你做些什么？@ 添加上下文，/ 调用技能与指令'
const TEXTAREA_MIN_HEIGHT = 76
const TEXTAREA_MAX_HEIGHT = 200

export function ConversationEmpty({
  draft,
  disabled,
  workspaceName,
  onDraftChange,
  onSubmit,
}: ConversationEmptyProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // 随内容长高，最多 200px 后内部滚动。
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, textarea.scrollHeight))}px`
  }, [draft])

  const canSubmit = !disabled && Boolean(draft.trim())

  const submit = () => {
    if (!canSubmit) return
    onSubmit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 中文输入法候选词的回车不能当成发送。
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="wb-conversation-hero">
      <div className="wb-hero">
        <div className="wb-hero-brand">
          <BrandRibbon size={44} animated />
        </div>

        <h1 className="wb-hero-title">EverRoom，我帮你</h1>
        <p className="wb-hero-sub">写文档、查资料、分析数据、做演示——把任务交给我，我一步步做完。</p>

        <div className="wb-hero-input" data-disabled={disabled ? 'true' : undefined}>
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            placeholder={HERO_PLACEHOLDER}
            aria-label="输入任务"
            disabled={disabled}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="wb-hero-actions">
            <span className="wb-hero-hint">Enter 发送 · Shift + Enter 换行</span>
            <button
              type="button"
              className="wb-hero-send"
              title="发送"
              aria-label="发送"
              disabled={!canSubmit}
              onClick={submit}
            >
              <ArrowUp />
            </button>
          </div>
        </div>

        <div className="wb-hero-chips" aria-label="建议任务">
          {HERO_SUGGESTIONS.map(({ label, prompt, Icon }) => (
            <button
              key={label}
              type="button"
              className="wb-hero-chip"
              disabled={disabled}
              onClick={() => {
                onDraftChange(prompt)
                textareaRef.current?.focus()
              }}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <p className="wb-hero-note">
          {workspaceName ? `会话会自动保存到「${workspaceName}」` : '会话会自动保存'}
          {' · 可随时在左侧切换会话'}
        </p>
      </div>
    </div>
  )
}
