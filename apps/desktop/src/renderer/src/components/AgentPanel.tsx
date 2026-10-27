import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentModelPreference, AgentNavigationTarget, AgentRoomReference, AgentSessionLink, ExternalConversationSummary } from '@nxcore/agent-contract'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentDraftPreviewDialog } from '@/components/agent/AgentDraftPreviewDialog'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
import {
  agentSessionLinkDestination,
  navigationKey,
  navigationRequiresSessionHandoff,
  parseAgentNavigationTarget,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { useAgentSession } from '@/components/agent/useAgentSession'
import { LocalAgentAdapterWizard } from '@/components/agent/LocalAgentAdapterWizard'
import type { MentionedAgent, MentionedItem } from '@/components/agent/agentMentions'
import type { LocalAgentAdapterCheck } from '../../../shared/sources'
import type { LocalAgentInstallation } from '../../../shared/local-agents'
import {
  loadConversationSuggestionSettings,
  onConversationSuggestionSettingsChanged,
  type ConversationSuggestionSettings,
} from '@/state/conversationSuggestionSettings'
import type { PageId } from '@/data/navigation'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { useActiveDocument } from '@/state/ActiveDocumentContext'
import {
  buildAgentDocumentSelectionRunRequest,
  type AgentDocumentSelectionSubmission,
} from '@/components/agent/agentDocumentSelection'

import './agent/AgentPanel.css'
import './agent/AgentChat.css'

const NO_ROOMS: AgentRoomReference[] = []

export function AgentPanel({
  pageId,
  pageLabel,
  navigationRequest,
  sessionRouteRequest,
  askRequest,
  prefillRequest,
  onPrefillConsumed,
  onNavigate,
  onNavigatePage,
  onNavigationConsumed,
  onOpenSessionLink,
  onSessionRouteConsumed,
  onAskConsumed,
  onOpenMentionFile,
  focusRequest = 0,
}: {
  pageId: PageId
  pageLabel: string
  navigationRequest: AgentNavigationRequest | null
  sessionRouteRequest: AgentSessionRouteRequest | null
  askRequest: { key: string; message: string; displayMessage?: string } | null
  /** 统一搜索「加入上下文/交给 Agent」预填：注入文本与可选附件，不自动发送。 */
  prefillRequest: {
    key: string
    text: string
    attachment?: { fileId: string; fileName: string } | null
  } | null
  onPrefillConsumed?: (key: string) => void
  onNavigate: (request: AgentNavigationRequest) => void
  /** 应用级页面跳转（与 Sidebar 同源）；用于「去设置」类提示动作。 */
  onNavigatePage?: (page: PageId) => void
  onNavigationConsumed: (key: string) => void
  onOpenSessionLink: (link: AgentSessionLink, destination: 'source' | 'target') => void
  onSessionRouteConsumed: (key: string) => void
  onAskConsumed: (key: string) => void
  onOpenMentionFile?: (fileId: string) => void
  focusRequest?: number
}) {
  // 工作区级会话：Room 已从网关与渲染层移除，Agent 会话不再有 Room 作用域。
  // useAgentSession 的 Room 参数随 Agent 运行时那一轮一并收窄。
  const workspaceRoomScope: AgentRoomReference[] = NO_ROOMS
  const { t, locale } = useLocale()
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pendingNavigationByRun, setPendingNavigationByRun] = useState<Record<string, AgentNavigationTarget>>({})
  const [composerResetKey, setComposerResetKey] = useState(0)
  const [localAgents, setLocalAgents] = useState<LocalAgentInstallation[]>([])
  const [selectedExternalConversation, setSelectedExternalConversation] = useState<ExternalConversationSummary | null>(null)
  const [pendingExternalAttachment, setPendingExternalAttachment] = useState<{ fileId: string; fileName: string } | null>(null)
  const [notificationRunTarget, setNotificationRunTarget] = useState<{ key: string; runId: string } | null>(null)
  /** 幻灯片内容稿的只读预览：SlidesProgressCard「打开草稿」传入 documentId 后打开弹窗。 */
  const [draftPreviewDocumentId, setDraftPreviewDocumentId] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const previousSessionIdRef = useRef<string | null>(null)
  const handledNavigationKeysRef = useRef(new Set<string>())
  const handledPrefillKeysRef = useRef(new Set<string>())
  const handledRequestKeysRef = useRef(new Set<string>())
  const handledSessionRouteKeysRef = useRef(new Set<string>())
  const handledAskKeysRef = useRef(new Set<string>())
  const session = useAgentSession(pageLabel, null, workspaceRoomScope)
  const agentAvailable = Boolean(window.nxcore?.agent)
  // 「重试」仅用于强制重渲染以重读 agent 桥可用性；桥就绪/恢复后引导 effect 会因 api 变化自动重跑。
  const [, setAvailabilityNonce] = useState(0)

  const [conversationSuggestionSettings, setConversationSuggestionSettings] =
    useState<ConversationSuggestionSettings>(loadConversationSuggestionSettings)
  const [composerSuggestion, setComposerSuggestion] = useState<{ key: string; text: string } | null>(null)
  const [starterPrompts, setStarterPrompts] = useState<string[] | null>(null)
  // 同一对话快照只在定时器真正触发时标记（清理掉的调度下次 effect 重排，StrictMode/依赖抖动不再永久丢失）；Esc 丢弃按快照 key 记忆；命中缓存立即回显（5 分钟 TTL），切对话往返不重复生成。
  const ghostContextKeyRef = useRef<string | null>(null)
  const ghostDismissedKeysRef = useRef<Set<string>>(new Set())
  const ghostCacheRef = useRef<Map<string, { text: string; at: number }>>(new Map())
  const starterPromptsCacheRef = useRef<{ key: string; prompts: string[]; at: number } | null>(null)
  useEffect(() => onConversationSuggestionSettingsChanged(setConversationSuggestionSettings), [])

  const lastMessage = session.messages.length ? session.messages[session.messages.length - 1] : null
  const ghostContextKey = `${session.sessionId ?? 'draft'}:${session.messages.length}:${lastMessage?.id ?? ''}`
  const ghostSuggestion = composerSuggestion?.key === ghostContextKey ? composerSuggestion.text : null

  useEffect(() => {
    const api = window.nxcore?.agent
    if (!api?.suggestConversationPrompt || !conversationSuggestionSettings.completionEnabled) {
      setComposerSuggestion(null)
      return
    }
    if (session.activeRunId) {
      setComposerSuggestion(null)
      return
    }
    const recentMessages = session.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      // 运行刚创建时列表里会出现还没内容的助手占位消息，带进建议请求会被
      // 网关 text minLength 1 校验拒绝（body/messages/N/text must NOT have fewer than 1 characters）。
      .filter((message) => message.content.trim().length > 0)
      .slice(-8)
      .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.content.slice(0, 4000) }))
    // 空会话（新对话）走开场问题变体：等会话清单就绪后再取。
    if (recentMessages.length === 0 && !session.scopeReady) return
    if (ghostDismissedKeysRef.current.has(ghostContextKey)) return
    const cached = ghostCacheRef.current.get(ghostContextKey)
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      setComposerSuggestion({ key: ghostContextKey, text: cached.text })
      return
    }
    if (ghostContextKeyRef.current === ghostContextKey) return
    const timer = window.setTimeout(() => {
      ghostContextKeyRef.current = ghostContextKey
      const recentSessions = [...session.sessions]
        .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
        .slice(0, 8)
        .map((item) => ({ title: item.title, updatedAt: item.updatedAt }))
      api.suggestConversationPrompt({
        sessionId: session.sessionId,
        pageLabel,
        roomTitle: null,
        messages: recentMessages,
        ...(recentMessages.length === 0 ? { recentSessions } : {}),
        language: locale,
      })
        .then(({ suggestion }) => {
          if (!suggestion?.trim()) return
          ghostCacheRef.current.set(ghostContextKey, { text: suggestion, at: Date.now() })
          if (ghostCacheRef.current.size > 100) {
            const oldest = ghostCacheRef.current.keys().next().value
            if (oldest !== undefined) ghostCacheRef.current.delete(oldest)
          }
          setComposerSuggestion({ key: ghostContextKey, text: suggestion })
        })
        .catch(() => undefined)
    }, 400)
    return () => { window.clearTimeout(timer) }
  }, [conversationSuggestionSettings.completionEnabled, session.activeRunId, session.messages, session.sessionId, session.sessions, session.scopeReady, ghostContextKey, pageLabel, locale])

  // 新对话空态：按最近会话标题生成开场推荐（5 分钟 TTL 缓存，失败静默回退静态文案）。
  const newConversationEmpty = session.scopeReady && session.messages.length === 0
  useEffect(() => {
    const api = window.nxcore?.agent
    if (!api?.suggestStarterPrompts || !conversationSuggestionSettings.starterPromptsEnabled || !newConversationEmpty) return
    const recentSessions = [...session.sessions]
      .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
      .slice(0, 8)
      .map((item) => ({ title: item.title, updatedAt: item.updatedAt }))
    const key = `${pageLabel}|${locale}|${recentSessions.map((item) => item.title ?? '').join('/')}`
    const cached = starterPromptsCacheRef.current
    if (cached && cached.key === key && Date.now() - cached.at < 5 * 60_000) {
      setStarterPrompts(cached.prompts)
      return
    }
    let cancelled = false
    api.suggestStarterPrompts({
      pageLabel,
      roomTitle: null,
      recentSessions,
      language: locale,
    })
      .then(({ prompts }) => {
        if (cancelled || !prompts?.length) return
        starterPromptsCacheRef.current = { key, prompts, at: Date.now() }
        setStarterPrompts(prompts)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [conversationSuggestionSettings.starterPromptsEnabled, newConversationEmpty, session.sessions, session.scopeReady, pageLabel, locale])

  const { activeDocument, prepareActiveDocumentRun } = useActiveDocument()
  const agentNamesById = useMemo(() => Object.fromEntries(
    localAgents.map((agent) => [agent.id, agent.displayName]),
  ), [localAgents])

  const handleNotificationRunLocated = useCallback((key: string) => {
    setNotificationRunTarget((current) => current?.key === key ? null : current)
  }, [])

  const focusComposer = (attention = false) => {
    window.requestAnimationFrame(() => {
      const composer = composerRef.current
      composer?.focus()
      if (!attention || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

      composer?.closest<HTMLElement>('.agent-prompt')?.animate?.(
        [
          { transform: 'scale(1)', boxShadow: '0 2px 12px rgba(15, 23, 42, 0.07)' },
          { transform: 'scale(1.018)', boxShadow: '0 10px 28px rgba(59, 130, 246, 0.18)' },
          { transform: 'scale(1)', boxShadow: '0 2px 12px rgba(15, 23, 42, 0.07)' },
        ],
        { duration: 460, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      )
    })
  }

  useEffect(() => {
    if (!focusRequest) return
    focusComposer(true)
  }, [focusRequest])

  const acceptGhost = useCallback(() => {
    setComposerSuggestion((current) => {
      if (current) setDraft(current.text)
      return null
    })
    focusComposer()
  }, [focusComposer])

  const dismissGhost = useCallback(() => {
    ghostDismissedKeysRef.current.add(ghostContextKey)
    if (ghostDismissedKeysRef.current.size > 50) ghostDismissedKeysRef.current.clear()
    setComposerSuggestion(null)
  }, [ghostContextKey])

  useEffect(() => {
    void window.nxcore?.agent.discoverLocalAgents?.()
      .then(setLocalAgents)
      .catch(() => setLocalAgents([]))
  }, [])

  useEffect(() => {
    setComposerResetKey((current) => current + 1)
  }, [pageLabel])

  useEffect(() => {
    if (previousSessionIdRef.current === session.sessionId) return
    if (previousSessionIdRef.current !== null) {
      setDraft('')
      setComposerResetKey((current) => current + 1)
    }
    previousSessionIdRef.current = session.sessionId
    setSelectedExternalConversation(null)
    setPendingNavigationByRun({})
  }, [session.sessionId])

  const selectExternalConversation = useCallback((conversation: ExternalConversationSummary | null) => {
    setSelectedExternalConversation(conversation)
  }, [])

  /** 消息区点击 @ 条目跳转：文件跳文件页聚焦，本应用会话切回该对话。 */
  const openMention = useCallback((item: MentionedItem) => {
    if (item.kind === 'file') {
      onOpenMentionFile?.(item.id)
      return
    }
    if (item.kind === 'conversation' && item.provider !== undefined && item.provider !== 'everroom') return
    void session.selectSessionById(item.id).catch(() => {
      showToast({ title: t('surface:agentChat.mentionTargetUnavailable') })
    })
  }, [onOpenMentionFile, session, t])


  useEffect(() => {
    if (!session.sessionId || navigationRequest) return
    const tools = Object.values(session.toolCallsByRun).flat()
    for (const tool of tools) {
      if (tool.status !== 'completed') continue
      const target = parseAgentNavigationTarget(tool.result)
      if (!target) continue
      const key = navigationKey(tool, target)
      if (handledNavigationKeysRef.current.has(key)) continue
      const alreadyLinked = session.sessionLinks.some((link) => (
        link.sourceSessionId === session.sessionId
        && link.sourceRunId === tool.runId
        && link.target.pageId === target.pageId
        && (link.target.roomId ?? null) === (target.roomId ?? null)
        && (link.target.objectId ?? '') === (target.objectId ?? '')
      ))
      if (alreadyLinked) {
        handledNavigationKeysRef.current.add(key)
        continue
      }
      // 历史工具调用只在面板重挂载/换会话后回放：只有当前活跃 run 的工具触发实时跳转。
      if (tool.runId !== session.activeRunId) {
        handledNavigationKeysRef.current.add(key)
        continue
      }
      handledNavigationKeysRef.current.add(key)
      onNavigate({
        key,
        source: {
          sessionId: session.sessionId,
          pageId,
          pageLabel,
          roomId: null,
          runId: tool.runId,
        },
        target,
      })
      return
    }
  }, [navigationRequest, onNavigate, pageId, pageLabel, session.activeRunId, session.sessionId, session.sessionLinks, session.toolCallsByRun])

  useEffect(() => {
    if (!navigationRequest || navigationRequest.target.pageId !== pageId) return
    if (handledRequestKeysRef.current.has(navigationRequest.key)) return
    if (!navigationRequiresSessionHandoff(navigationRequest)) {
      handledRequestKeysRef.current.add(navigationRequest.key)
      onNavigationConsumed(navigationRequest.key)
      return
    }
    if (!session.scopeReady || session.loading || session.activeRunId || submitting) return
    handledRequestKeysRef.current.add(navigationRequest.key)
    setSubmitting(true)
    void (async () => {
      const reusableSession = session.sessions.length === 1
        && session.currentSession?.id === session.sessionId
        && !session.currentSession.title?.trim()
        && session.messages.length === 0
        && session.sessionLinks.length === 0
      const targetSession = reusableSession ? session.currentSession! : await session.createSession()
      const targetSessionId = targetSession.id
      await session.renameSession(targetSessionId, navigationRequest.target.title.trim().slice(0, 120))
      await session.createSessionLink({
        sourceSessionId: navigationRequest.source.sessionId,
        targetSessionId,
        sourceRunId: navigationRequest.source.runId,
        sourcePageId: navigationRequest.source.pageId,
        sourcePageLabel: navigationRequest.source.pageLabel,
        sourceRoomId: navigationRequest.source.roomId,
        target: navigationRequest.target,
      })
      onNavigationConsumed(navigationRequest.key)
    })()
      .catch(() => {
        onNavigationConsumed(navigationRequest.key)
      })
      .finally(() => setSubmitting(false))
  }, [navigationRequest, onNavigationConsumed, pageId, session, submitting])

  useEffect(() => {
    if (!sessionRouteRequest || sessionRouteRequest.pageId !== pageId) return
    if (session.loading) return
    if (!session.sessions.some((item) => item.id === sessionRouteRequest.sessionId)) return
    if (handledSessionRouteKeysRef.current.has(sessionRouteRequest.key)) return
    handledSessionRouteKeysRef.current.add(sessionRouteRequest.key)
    setNotificationRunTarget(sessionRouteRequest.runId
      ? { key: sessionRouteRequest.key, runId: sessionRouteRequest.runId }
      : null)
    void session.selectSessionById(sessionRouteRequest.sessionId)
      .then(() => onSessionRouteConsumed(sessionRouteRequest.key))
      .catch(() => {
        handledSessionRouteKeysRef.current.delete(sessionRouteRequest.key)
        setNotificationRunTarget((current) => current?.key === sessionRouteRequest.key ? null : current)
      })
  }, [onSessionRouteConsumed, pageId, session, sessionRouteRequest])

  const [adapterWizard, setAdapterWizard] = useState<{
    checks: LocalAgentAdapterCheck[]
    resolve: (proceed: boolean) => void
  } | null>(null)
  // 发送含 @ 本机 Agent 的消息前检查 ACP 适配器是否已安装；缺失时弹安装向导。
  // 检测本身失败不拦发送（gateway 侧 spawn 失败仍有兜底错误）。
  const ensureLocalAgentAdapters = async (agents: MentionedAgent[]): Promise<boolean> => {
    const check = window.nxcore?.agent?.checkLocalAgentAdapters
    if (!check) return true
    let results: LocalAgentAdapterCheck[]
    try {
      results = (await check(agents.map((agent) => agent.id))) ?? []
    } catch {
      return true
    }
    if (!results.some((item) => !item.adapter.installed)) return true
    return new Promise<boolean>((resolve) => {
      setAdapterWizard({ checks: results, resolve })
    })
  }

  const sendPrompt = async (
    prompt: string,
    replaceRunId?: string,
    files: File[] = [],
    mentioned: MentionedItem[] = [],
    /** 用户可见文案：prompt 是技术指令时用它渲染气泡/标题。 */
    displayPrompt?: string,
  ) => {
    if ((!prompt.trim() && files.length === 0) || !agentAvailable) return
    const mentionedAgents: MentionedAgent[] = mentioned
      .filter((item) => item.kind === 'agent')
      .map((item) => ({ id: item.id, displayName: item.displayName }))
    if (mentionedAgents?.length && !await ensureLocalAgentAdapters(mentionedAgents)) return
    // @ 引用的对话记录：取最后一条作为 referencedConversationId 注入运行上下文。
    const mentionedConversationId = [...mentioned].reverse().find((item) => item.kind === 'conversation')?.id
    const mentionedFileIds = mentioned.filter((item) => item.kind === 'file').map((item) => item.id)
    const submittedPrompt = prompt.trim()
    setDraft('')
    setSubmitting(true)
    try {
      const externalConversation = selectedExternalConversation
      const activeDocumentContext = await prepareActiveDocumentRun(submittedPrompt)
      let attachments = undefined
      if (files.length > 0) {
        const filesApi = window.nxcore?.files
        if (!filesApi) throw new Error(t('surface:agentComposer.filesServiceUnavailable'))
        const outcomes = await filesApi.importDropped(files)
        const imported = outcomes?.filter((item) => item.fileId && item.fileVersionId && !item.error) ?? []
        if (imported.length !== files.length) {
          throw new Error(t('surface:agentComposer.someFilesFailedToImport'))
        }
        attachments = imported.map((item) => ({
          fileId: item.fileId!,
          fileVersionId: item.fileVersionId!,
          fileName: item.filename,
          status: 'processing' as const,
        }))
      }
      if (mentionedFileIds.length) {
        const filesApi = window.nxcore?.files
        if (!filesApi) throw new Error(t('surface:agentComposer.filesServiceUnavailable'))
        const referenced = await Promise.all(mentionedFileIds.map(async (fileId) => {
          const entry = await filesApi.catalogEntry(fileId)
          if (!entry?.currentVersionId) throw new Error(t('surface:agentComposer.mentionedFileUnavailable'))
          return {
            fileId,
            fileVersionId: entry.currentVersionId,
            fileName: entry.displayName ?? entry.sharedTitle ?? entry.originalName,
            status: (entry.processingState === 'ready' ? 'ready' : 'processing') as 'ready' | 'processing',
          }
        }))
        const known = new Set((attachments ?? []).map((item) => item.fileId))
        attachments = [...(attachments ?? []), ...referenced.filter((item) => !known.has(item.fileId))]
      }
      if (pendingExternalAttachment) {
        const filesApi = window.nxcore?.files
        if (filesApi) {
          const entry = await filesApi.catalogEntry(pendingExternalAttachment.fileId)
          if (entry?.currentVersionId) {
            const known = new Set((attachments ?? []).map((item) => item.fileId))
            if (!known.has(pendingExternalAttachment.fileId)) {
              attachments = [...(attachments ?? []), {
                fileId: pendingExternalAttachment.fileId,
                fileVersionId: entry.currentVersionId,
                fileName: pendingExternalAttachment.fileName,
                status: (entry.processingState === 'ready' ? 'ready' : 'processing') as 'ready' | 'processing',
              }]
            }
          }
        }
      }
      await session.sendPrompt(
        submittedPrompt || t('surface:agentComposer.analyzeUploadedFiles'),
        '',
        undefined,
        activeDocumentContext,
        replaceRunId,
        attachments,
        undefined,
        externalConversation?.id ?? mentionedConversationId,
        mentionedAgents,
        mentioned,
        displayPrompt,
      )
      if (externalConversation) setSelectedExternalConversation(null)
      setPendingExternalAttachment(null)
      setComposerResetKey((current) => current + 1)
    } catch {
      // 失败回填用用户能看懂的那句，不把内部指令塞回输入框。
      setDraft((displayPrompt ?? prompt).trim())
    } finally {
      setSubmitting(false)
    }
  }

  /** 确定性入口：hiddenPrompt 只交给运行时，displayText 渲染成用户气泡。 */
  const sendAgentAction = async (hiddenPrompt: string, displayText: string): Promise<void> => {
    await sendPrompt(hiddenPrompt, undefined, [], [], displayText)
  }

  // slides「AI 修改」转发注入：会话就绪后自动发送（key 去重防重放）。
  // message 是内部指令（runtime 用），displayMessage 是用户能看懂的人话（气泡用）。
  useEffect(() => {
    if (!askRequest || session.loading) return
    if (handledAskKeysRef.current.has(askRequest.key)) return
    handledAskKeysRef.current.add(askRequest.key)
    void sendAgentAction(askRequest.message, askRequest.displayMessage ?? askRequest.message)
      .then(() => onAskConsumed(askRequest.key))
      .catch(() => handledAskKeysRef.current.delete(askRequest.key))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest, session.loading])

  // 停止/中断回执：中性提示（info toast），不伪装成失败。
  useEffect(() => {
    if (!session.runNotice) return
    showToast({
      title: t('surface:agentExecutionTimeline.stopped'),
      message: session.runNotice.message,
    })
  }, [session.runNotice, t])

  // 统一搜索预填注入：填文本（追加）+挂附件（发送时解析版本），由用户手动发送。
  useEffect(() => {
    if (!prefillRequest || handledPrefillKeysRef.current.has(prefillRequest.key)) return
    handledPrefillKeysRef.current.add(prefillRequest.key)
    setDraft((current) => (current.trim() ? `${current}\n${prefillRequest.text}` : prefillRequest.text))
    if (prefillRequest.attachment) setPendingExternalAttachment(prefillRequest.attachment)
    onPrefillConsumed?.(prefillRequest.key)
    composerRef.current?.focus()
  }, [prefillRequest, onPrefillConsumed])

  const selectDocument = async ({ document, originalPrompt }: AgentDocumentSelectionSubmission) => {
    setSubmitting(true)
    try {
      const documents = window.nxcore?.documents
      if (!documents) throw new Error(t('surface:agent.documentServiceUnavailable'))
      const snapshot = await documents.get(document.documentId)
      const request = buildAgentDocumentSelectionRunRequest(originalPrompt, snapshot)
      await session.sendPrompt(request.prompt, undefined, undefined, request.activeDocument)
    } catch {
      // useAgentSession exposes the request error inside the conversation.
    } finally {
      setSubmitting(false)
    }
  }

  const openSessionLink = async (link: AgentSessionLink) => {
    const destination = agentSessionLinkDestination(link, session.sessionId)
    if (!destination) return
    setSubmitting(true)
    try {
      if (destination === 'source') await session.markSessionLinkReturned(link.id)
      onOpenSessionLink(link, destination)
    } finally {
      setSubmitting(false)
    }
  }

  // 档位可用性：lite 配置了 model 才显示档位；primary 缺连接要素时仍显示但点击提示去设置
  // （网关约定：model 空＝未配置＝档位隐藏；primary 空＝强模型档不可用）。
  const loadTierAvailability = useCallback(async (): Promise<{ lite: boolean; primary: boolean }> => {
    try {
      const snapshot = await window.nxcore?.runtimeConfig?.get()
      const config = snapshot?.config as {
        lite?: { model?: unknown }
        primary?: { provider?: unknown; model?: unknown; baseUrl?: unknown }
      } | undefined
      const lite = typeof config?.lite?.model === 'string' && config.lite.model.trim() !== ''
      const primary = ['provider', 'model', 'baseUrl'].every((key) => {
        const value = config?.primary?.[key as keyof NonNullable<typeof config.primary>]
        return typeof value === 'string' && value.trim() !== ''
      })
      return { lite, primary }
    } catch {
      return { lite: false, primary: false }
    }
  }, [])

  const modelTierLocked = Boolean(session.sessionId)
  const effectiveModelPreference: AgentModelPreference = session.currentSession?.modelPreference ?? session.modelPreferenceDefault
  // 渠道与档位同一把锁：会话已创建＝读会话锁定渠道（无渠道则 null），
  // 未创建＝读全局默认渠道。
  const effectiveChannelAgentId = session.sessionId
    ? session.currentSession?.channelAgentId ?? null
    : session.channelAgentIdDefault

  const composer = (
    <AgentComposer
      ref={composerRef}
      resetKey={composerResetKey}
      selectedExternalConversation={selectedExternalConversation}
      localAgents={localAgents}
      modelPreference={effectiveModelPreference}
      modelPreferenceLocked={modelTierLocked}
      contextUsage={session.contextUsage}
      contextCompacting={session.contextCompacting}
      loadModelAvailability={loadTierAvailability}
      onSelectModelPreference={session.setModelPreferenceDefault}
      channelAgentId={effectiveChannelAgentId}
      onSelectChannelAgent={session.setChannelAgentIdDefault}
      permissionMode={session.permissionMode}
      permissionModeAvailable={session.permissionModeAvailable}
      onSelectPermissionMode={session.setSessionPermissionMode}
      onOpenSettings={onNavigatePage ? () => onNavigatePage('settings') : undefined}
      ghostSuggestion={ghostSuggestion}
      onAcceptGhost={acceptGhost}
      onDismissGhost={dismissGhost}
      queuedSubmissions={session.queuedSubmissions}
      onRemoveQueuedSubmission={session.removeQueuedSubmission}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading || submitting}
      available={agentAvailable}
      onChange={setDraft}
      onSelectExternalConversation={selectExternalConversation}
      onStop={() => void session.stop()}
      onSubmit={(files, mentioned) => void sendPrompt(draft, undefined, files, mentioned)}
    />
  )

  return (
    <aside className="agent-panel">
      <AgentToolbar>
        <AgentSessionSwitcher
          activeRunId={session.activeRunId}
          connected={session.connected}
          displayTitle={navigationRequest?.target.title ?? session.displayTitle}
          sessionId={session.sessionId}
          sessions={session.sessions}
          onCreate={async () => {
            setNotificationRunTarget(null)
            setDraft('')
            setComposerResetKey((current) => current + 1)
            // 懒创建：只回到草稿态，首条消息发出时才用当前档位/渠道默认建会话。
            return session.startNewConversation()
          }}
          onDelete={session.deleteSession}
          onRename={session.renameSession}
          onSelect={async (selectedSession) => {
            setNotificationRunTarget(null)
            setDraft('')
            setComposerResetKey((current) => current + 1)
            await session.selectSession(selectedSession)
          }}
        />
      </AgentToolbar>

      {!agentAvailable ? (
        <div className="agent-availability-banner" role="alert" data-testid="agent-panel-unavailable">
          <div className="agent-availability-copy">
            <strong>{t('surface:agentPanel.unavailableTitle')}</strong>
            <span>{t('surface:agentPanel.unavailableBody')}</span>
          </div>
          <button
            type="button"
            className="agent-availability-retry"
            onClick={() => {
              setAvailabilityNonce((nonce) => nonce + 1)
              session.reload()
            }}
          >{t('surface:agentComposer.retry')}</button>
        </div>
      ) : null}

      <AgentChatView
        activeDocument={activeDocument}
        activeRunId={session.activeRunId}
        agentIdByRun={session.agentIdByRun}
        agentNamesById={agentNamesById}
        activityByRun={session.activityByRun}
        composer={composer}
        currentSessionId={session.sessionId}
        scopeReady={session.scopeReady}
        starterPrompts={newConversationEmpty ? starterPrompts : null}
        draftHasContent={Boolean(draft.trim())}
        error={session.error}
        loading={session.loading}
        messages={session.messages}
        notificationRunTarget={notificationRunTarget}
        onNotificationRunLocated={handleNotificationRunLocated}
        onRetryError={() => session.reload()}
        pendingApprovals={session.pendingApprovals}
        onRetryPrompt={(prompt, runId) => void sendPrompt(prompt, runId)}
        onOpenSessionLink={(link) => void openSessionLink(link)}
        onOpenDraft={(documentId) => {
          // 打开草稿 = 真实只读预览（工作区文稿），不再弹「不在当前 Room」的 toast 死路。
          setDraftPreviewDocumentId(documentId)
        }}
        onSlidesAction={(prompt, displayText) => void sendAgentAction(prompt, displayText)}
        cancelledRunIds={session.cancelledRunIds}
        interruptedRunIds={session.interruptedRunIds}
        onOpenMention={openMention}
        onSelectDocument={(selection) => void selectDocument(selection)}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          focusComposer()
        }}
        pendingNavigationByRun={pendingNavigationByRun}
        reasoningByRun={session.reasoningByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        resolvingApprovalIds={session.resolvingApprovalIds}
        sessionLinks={session.sessionLinks}
        submitting={submitting}
        toolCallsByRun={session.toolCallsByRun}
        onResolveApproval={(approvalId, decision, feedback) => void session.resolveApproval(approvalId, decision, feedback)}
        composerNotice={adapterWizard ? (
          <LocalAgentAdapterWizard
            initialChecks={adapterWizard.checks}
            onProceed={() => {
              adapterWizard.resolve(true)
              setAdapterWizard(null)
            }}
            onCancel={() => {
              adapterWizard.resolve(false)
              setAdapterWizard(null)
            }}
          />
        ) : undefined}
      />

      {draftPreviewDocumentId ? (
        <AgentDraftPreviewDialog
          documentId={draftPreviewDocumentId}
          onClose={() => setDraftPreviewDocumentId(null)}
        />
      ) : null}
    </aside>
  )
}
