import { FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import type { OfficeFile } from '@/office-proto/data'

import { ConversationPane } from '../conversation/ConversationPane'
import { useWorkbenchStore, useWorkspaceSessions, useWorkspace } from '../state/store'
import {
  type WorkspacePageKey,
  type WorkspaceTab,
  sessionDisplayTitle,
} from '../types'
import { Hint, IconButton } from '../ui/primitives'
import { AgentsPage } from '../workspace/AgentsPage'
import { SetupWizard } from '../workspace/SetupWizard'
import { BubbleWindow } from '../workspace/BubbleWindow'
import { LibraryPage } from '../workspace/LibraryPage'
import { OverviewPage } from '../workspace/OverviewPage'
import { OutputsPage } from '../workspace/OutputsPage'
import { PlanPage } from '../workspace/PlanPage'
import { useWorkspaceBubble } from '../workspace/useBubble'
import type { WorkspacePageProps } from '../workspace/contracts'
import { workbenchToast } from '../shell/toast'
import '../workspace/workspace.css'

/**
 * 工作空间标签的内容宿主：
 * - 功能页（概览/资料库/产物/智能体/计划）与工作会话二选一显示；
 * - 会话只在该标签激活时挂载（网关同一时刻只维护一个 agent 订阅），切标签会重新拉快照；
 * - 右侧文件气泡窗由本组件持有，跨页面切换保留。
 */
export function WorkspaceTabHost({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const workspace = useWorkspace(tab.workspaceId)
  const sessions = useWorkspaceSessions(tab.workspaceId)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const pendingSetupWorkspaceId = useWorkbenchStore((state) => state.pendingSetupWorkspaceId)
  const finishWorkspaceSetup = useWorkbenchStore((state) => state.finishWorkspaceSetup)
  const bubble = useWorkspaceBubble(tab.id)

  // 气泡窗的退场动画：state 先变 closed，再保留 160ms 播放完 fade/slide-out 才卸载。
  const [bubbleMounted, setBubbleMounted] = useState(false)
  const [bubbleClosing, setBubbleClosing] = useState(false)
  // 「收起（最小化）」也播一段向右收拢的退场动画，再切成右缘把手，避免面板瞬间消失。
  const [bubbleMinimizing, setBubbleMinimizing] = useState(false)
  const previousBubbleMode = useRef(bubble.bubble.mode)
  const bubbleMode = bubble.bubble.mode
  useEffect(() => {
    const previous = previousBubbleMode.current
    previousBubbleMode.current = bubbleMode
    if (previous === 'open' && bubbleMode === 'minimized') {
      setBubbleMinimizing(true)
      const timer = window.setTimeout(() => setBubbleMinimizing(false), 150)
      return () => window.clearTimeout(timer)
    }
  }, [bubbleMode])
  useEffect(() => {
    if (bubbleMode !== 'closed') {
      setBubbleMounted(true)
      setBubbleClosing(false)
      return
    }
    if (!bubbleMounted) return
    setBubbleClosing(true)
    const timer = window.setTimeout(() => {
      setBubbleClosing(false)
      setBubbleMounted(false)
    }, 170)
    return () => window.clearTimeout(timer)
  }, [bubbleMode, bubbleMounted])

  // ⌘J：与旧版文件面板一致——收起时打开「资料与文件」浏览（没有文件也能开），
  // 已展开时在「最小化 ↔ 还原」之间切换。
  useEffect(() => {
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      if (detail !== tab.id || !active) return
      if (bubble.bubble.mode === 'closed') {
        bubble.openBrowser()
        return
      }
      if (bubble.bubble.mode === 'minimized') bubble.restore()
      else bubble.minimize()
    }
    window.addEventListener('everroom:workbench-toggle-bubble', onToggle)
    return () => window.removeEventListener('everroom:workbench-toggle-bubble', onToggle)
  }, [active, bubble, tab.id])

  // 激活标签时刷新一次会话列表（后台 run 的标题/状态可能已经变了）。
  const refreshSessions = useWorkbenchStore((state) => state.refreshSessions)
  useEffect(() => {
    if (!active) return
    void refreshSessions()
  }, [active, refreshSessions])

  if (!workspace) {
    return <div className="wb-ws-missing">工作空间不存在或已删除</div>
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
    ? '新工作'
    : view.kind === 'session'
      ? sessionDisplayTitle(session)
      : ''
  const renderPage = () => {
    if (view.kind !== 'page') return null
    switch (view.page) {
      case 'overview': return <OverviewPage {...pageProps} />
      case 'library': return <LibraryPage {...pageProps} />
      case 'outputs': return <OutputsPage {...pageProps} />
      case 'agents': return <AgentsPage {...pageProps} />
      case 'plan': return <PlanPage {...pageProps} />
      default: return null
    }
  }

  return (
    <div className="wb-ws">
      <div className="wb-ws-main">
        {view.kind === 'page' ? renderPage() : null}
        {/* 对话区：右上角一个图标入口，点开右侧「资料与文件」面板（无文字，保持极简）。 */}
        {active && (view.kind === 'session' || view.kind === 'draft') ? (
          <div className="wb-chat">
            <header className="wb-chat-head">
              <span className="wb-chat-head-title" title={chatTitle}>{chatTitle}</span>
              <div className="wb-chat-head-actions">
                <Hint label={
                  bubbleMode === 'minimized'
                    ? '展开资料与文件（⌘J）'
                    : bubbleMode === 'open' && bubble.bubble.activeFileId === null
                      ? '收起资料与文件（⌘J）'
                      : '资料与文件（⌘J）'
                }>
                  <IconButton
                    label="资料与文件"
                    size="sm"
                    icon={<FolderOpen size={15} />}
                    active={bubbleMode === 'open' && bubble.bubble.activeFileId === null && !bubbleClosing}
                    aria-expanded={bubbleMode === 'open' && bubble.bubble.activeFileId === null && !bubbleClosing}
                    onClick={() => {
                      if (bubble.bubble.mode === 'closed') bubble.openBrowser()
                      else if (bubble.bubble.mode === 'minimized') bubble.restore()
                      else if (bubble.bubble.activeFileId === null) bubble.close()
                      else bubble.openBrowser()
                    }}
                  />
                </Hint>
              </div>
            </header>
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
            {view.kind === 'draft' ? '新工作草稿' : '工作会话'} · 切回此标签继续
          </div>
        ) : null}
      </div>

      {pendingSetupWorkspaceId === workspace.id ? (
        <SetupWizard workspace={workspace as AgentWorkspace} onDone={finishWorkspaceSetup} />
      ) : null}

      {bubbleMounted ? (
        <BubbleWindow
          closing={bubbleClosing}
          minimizing={bubbleMinimizing}
          bubble={bubbleMinimizing ? { ...bubble.bubble, mode: 'open' } : bubble.bubble}
          onResize={bubble.setWidth}
          onMinimize={bubble.minimize}
          onToggleMax={bubble.toggleMaximize}
          onRestore={bubble.restore}
          onClose={bubble.close}
          onActivateFile={bubble.activateFile}
          onCloseFile={(fileId) => { void bubble.closeFile(fileId) }}
          onBrowse={bubble.openBrowser}
          onOpenFile={bubble.openFile}
          onToast={workbenchToast}
        />
      ) : null}
    </div>
  )
}
