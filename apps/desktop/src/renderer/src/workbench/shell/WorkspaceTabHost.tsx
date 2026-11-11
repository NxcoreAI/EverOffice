import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import { useLocale } from '@/i18n/LocaleContext'
import { cloudDocumentToOfficeFileById, type OfficeFile } from '@/office-proto/data'

import { ConversationPane } from '../conversation/ConversationPane'
import { useWorkbenchStore, useWorkspaceSessions, useWorkspace } from '../state/store'
import { cn } from '../ui/cn'
import {
  type WorkspacePageKey,
  type WorkspaceTab,
  sessionDisplayTitle,
} from '../types'
import { Hint, IconButton } from '../ui/primitives'
import { BubbleWindow } from '../workspace/BubbleWindow'
import { LibraryPage } from '../workspace/LibraryPage'
import { OverviewPage } from '../workspace/OverviewPage'
import { OutputsPage } from '../workspace/OutputsPage'
import { PlanPage } from '../workspace/PlanPage'
import { useWorkspaceBubble } from '../workspace/useBubble'
import type { WorkspacePageProps } from '../workspace/contracts'
import { workbenchToast } from '../shell/toast'
import {
  isWorkspaceBubbleTarget,
  OPEN_AGENT_FILE_EVENT,
  OPEN_CLOUD_DOCUMENT_EVENT,
  type OpenAgentFileDetail,
  type OpenCloudDocumentDetail,
} from '../shell/openAgentFile'
import '../workspace/workspace.css'

/**
 * 工作空间标签的内容宿主：
 * - 功能页（概览/资料库/产物/计划）与工作会话二选一显示；
 * - 会话只在该标签激活时挂载（网关同一时刻只维护一个 agent 订阅），切标签会重新拉快照；
 * - 右侧文件气泡窗由本组件持有，跨页面切换保留。
 */
export function WorkspaceTabHost({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const { t } = useLocale()
  const workspace = useWorkspace(tab.workspaceId)
  const sessions = useWorkspaceSessions(tab.workspaceId)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const bubble = useWorkspaceBubble(tab.id)
  /** 气泡窗是否已拖到铺满整个工作区（由 BubbleWindow 实测容器后回报）。 */
  const [bubbleFull, setBubbleFull] = useState(false)

  // ⌘J：面板收起时打开「资料与文件」浏览（没有文件也能开），已展开时收起。
  useEffect(() => {
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      if (detail !== tab.id || !active) return
      if (bubble.visible) bubble.minimize()
      else bubble.openBrowser()
    }
    window.addEventListener('everroom:workbench-toggle-bubble', onToggle)
    return () => window.removeEventListener('everroom:workbench-toggle-bubble', onToggle)
  }, [active, bubble, tab.id])

  // Agent 产物就绪（Workbench 按 workspaceId 定向派发）：气泡窗自动展开并打开
  // 该文件——任务完成的「结果展示」一步到位，用户不必自己去产物库找。
  // 非激活标签只收事件不展开（激活时气泡窗才可见），避免后台空间互相打扰。
  useEffect(() => {
    const onOpenAgentFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenAgentFileDetail>).detail
      if (!isWorkspaceBubbleTarget(detail, tab.id) || !active) return
      bubble.openFile(detail.file)
    }
    window.addEventListener(OPEN_AGENT_FILE_EVENT, onOpenAgentFile)
    return () => window.removeEventListener(OPEN_AGENT_FILE_EVENT, onOpenAgentFile)
  }, [active, bubble, tab.id])

  // Agent 回复里的云文档卡：点击派发窗口事件（不带 tabId）。当前激活标签把它换成
  // 伪 OfficeFile 交给气泡窗——云文档没有文件库条目，打开后由 EditorView 路由到
  // 云文档编辑器。后台标签收到也不抢，避免在不可见空间里开文件。
  useEffect(() => {
    const onOpenCloudDocument = (event: Event) => {
      if (!active) return
      const detail = (event as CustomEvent<OpenCloudDocumentDetail>).detail
      if (!detail?.documentId) return
      bubble.openFile(cloudDocumentToOfficeFileById(detail.documentId, detail.title))
    }
    window.addEventListener(OPEN_CLOUD_DOCUMENT_EVENT, onOpenCloudDocument)
    return () => window.removeEventListener(OPEN_CLOUD_DOCUMENT_EVENT, onOpenCloudDocument)
  }, [active, bubble])

  // 「在工作空间里打开文件」（openFileInWorkspace 写入 store 的交接载荷）：
  // 挂载/激活时取走一次并交给气泡窗。非激活标签不抢——store 里只有一份，
  // 等目标标签激活后消费，避免后台空间替别人开文件。
  const consumePendingBubbleFile = useWorkbenchStore((state) => state.consumePendingBubbleFile)
  const pendingBubbleFile = useWorkbenchStore((state) => state.pendingBubbleFile)
  useEffect(() => {
    if (!active || !pendingBubbleFile) return
    if (pendingBubbleFile.tabId !== tab.id) return
    const file = consumePendingBubbleFile(tab.id)
    if (file) bubble.openFile(file)
  }, [active, pendingBubbleFile, consumePendingBubbleFile, bubble, tab.id])

  // 激活标签时刷新一次会话列表（后台 run 的标题/状态可能已经变了）。
  const refreshSessions = useWorkbenchStore((state) => state.refreshSessions)
  useEffect(() => {
    if (!active) return
    void refreshSessions()
  }, [active, refreshSessions])

  if (!workspace) {
    return <div className="wb-ws-missing">{t('workbench:tabHost.missing')}</div>
  }

  const pageProps: WorkspacePageProps = {
    tab,
    workspace: workspace as AgentWorkspace,
    sessions,
    onOpenSession: (sessionId) => setWorkspaceView(tab.id, { kind: 'session', sessionId }),
    onOpenFile: (file: OfficeFile) => bubble.openFile(file),
    onOpenPage: (page: WorkspacePageKey) => setWorkspaceView(tab.id, { kind: 'page', page }),
    onNewWork: () => setWorkspaceView(tab.id, { kind: 'draft' }),
    onToast: workbenchToast,
  }

  const view = tab.view
  const session = view.kind === 'session'
    ? sessions.find((item) => item.id === view.sessionId) ?? null
    : null
  const chatTitle = view.kind === 'draft'
    ? t('workbench:common.newWork')
    : view.kind === 'session'
      ? sessionDisplayTitle(session, t)
      : ''
  const renderPage = () => {
    if (view.kind !== 'page') return null
    switch (view.page) {
      case 'overview': return <OverviewPage {...pageProps} />
      case 'library': return <LibraryPage {...pageProps} />
      case 'outputs': return <OutputsPage {...pageProps} />
      case 'plan': return <PlanPage {...pageProps} />
      default: return null
    }
  }

  return (
    <div className={cn(
      'wb-ws',
      // 最大化覆盖层显示期间隐藏主区（对话区）；退场开始就摘掉，
      // 让对话区随覆盖层淡出逐渐显现。仅会话/草稿视图有对话区可覆盖，
      // 功能页（资料库/产物/计划）下面同样被盖住，行为一致。
      bubble.bubble.maximized && bubble.visible && !bubble.exitKind && 'has-max-bubble',
      // 气泡窗被拖过「对话区保底宽度」后，对话区需要能继续让位到 0（铺满整页时完全不可见）。
      // 退场期间保持放开，否则面板还在收窄、对话区却已恢复 min-width 会把布局顶溢出。
      bubble.bubble.cover && bubble.visible && 'has-bubble-cover',
      // 铺满态 = 视觉上完全盖住对话区（同最大化覆盖层）：对话区让出无障碍树。
      bubble.visible && bubbleFull && 'has-full-bubble',
    )}>
      <div className="wb-ws-main">
        {view.kind === 'page' ? renderPage() : null}
        {/* 对话区：右上角一个图标入口，点开右侧「资料与文件」面板（无文字，保持极简）。 */}
        {active && (view.kind === 'session' || view.kind === 'draft') ? (
          <div className="wb-chat">
            <header className="wb-chat-head">
              <span className="wb-chat-head-title" title={chatTitle}>{chatTitle}</span>
              <div className="wb-chat-head-actions">
                {/* 面板打开时它自己有浏览/收起/关闭按钮；这里保留同一个按钮的位置（仅隐藏），
                    避免收起/展开最后一步因「按钮出现/消失」把标题挤动一下。 */}
                <span className={bubble.visible ? 'wb-chat-files-slot is-hidden' : 'wb-chat-files-slot'}>
                  <Hint label={t('workbench:tabHost.filesShortcut')}>
                    <IconButton
                      label={t('workbench:tabHost.files')}
                      size="sm"
                      icon={<FolderOpen size={15} />}
                      aria-expanded={bubble.visible}
                      aria-hidden={bubble.visible}
                      tabIndex={bubble.visible ? -1 : 0}
                      onClick={() => bubble.openBrowser()}
                    />
                  </Hint>
                </span>
              </div>
            </header>
            {/* 待发送批注徽章由 ConversationPane 渲染（紧贴输入框上方的浮层行）。 */}
            {view.kind === 'session' ? (
              <ConversationPane
                key={`session:${view.sessionId}`}
                tabId={tab.id}
                workspaceId={tab.workspaceId}
                sessionId={view.sessionId}
              />
            ) : (
              <ConversationPane
                key={`draft:${tab.id}`}
                tabId={tab.id}
                workspaceId={tab.workspaceId}
                sessionId={null}
              />
            )}
          </div>
        ) : null}
        {!active && (view.kind === 'session' || view.kind === 'draft') ? (
          <div className="wb-ws-inactive-hint">
            {view.kind === 'draft' ? t('workbench:tabHost.newWorkDraft') : t('workbench:tabHost.workSession')}
          </div>
        ) : null}
      </div>

      {bubble.visible ? (
        <BubbleWindow
          exiting={bubble.exitKind}
          bubble={bubble.exitKind ? { ...bubble.bubble, mode: 'open' } : bubble.bubble}
          onResize={bubble.setWidth}
          onMinimize={bubble.minimize}
          onToggleMax={bubble.toggleMaximize}
          onClose={bubble.close}
          onActivateFile={bubble.activateFile}
          onCloseFile={(fileId) => { void bubble.closeFile(fileId) }}
          onBrowse={bubble.openBrowser}
          onOpenFile={bubble.openFile}
          onToast={workbenchToast}
          workspaceId={workspace.id}
          onFullChange={setBubbleFull}
        />
      ) : null}
    </div>
  )
}
