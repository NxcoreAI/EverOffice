import React, { useEffect, useState } from 'react'
import {
  Clock, FolderOpen, Bot, Library, Plug, Settings, X, Home, Plus,
} from 'lucide-react'

import everroomAppIcon from '@/assets/everroom-app-icon.png'

import { type MenuKey, type OfficeFile, blankFile } from './data'
import { FileTypeIcon } from './pages/parts'
import { RecentView } from './pages/RecentView'
import { AllFilesView } from './pages/AllFilesView'
import { AgentView } from './pages/AgentView'
import { KnowledgeView } from './pages/KnowledgeView'
import { ConnectorsView } from './pages/ConnectorsView'
import { EditorView } from './EditorView'

export function OfficeProto() {
  // 标签栏状态：activeId 为 null 表示停在主页 tab。
  const [tabs, setTabs] = useState<OfficeFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  const openFile = (file: OfficeFile) => {
    setTabs((prev) => (prev.some((t) => t.id === file.id) ? prev : [...prev, file]))
    setActiveId(file.id)
  }

  const closeTab = (id: string) => {
    // 先过主进程的脏关闭守卫（GenOffice 保存对话框里点取消 → 保留标签）。
    void window.desktop?.office.close(id).then((closed) => {
      if (closed === false) return
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id)
        const next = prev.filter((t) => t.id !== id)
        if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null)
        return next
      })
    })
  }

  return (
    <div className="op-root">
      {/* 标签栏是窗口级最顶层；侧边栏属于「主页」标签页内部 */}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onHome={() => setActiveId(null)}
        onActivate={setActiveId}
        onClose={closeTab}
        onAdd={() => openFile(blankFile('docx'))}
      />
      <div className="op-window-body">
        <div className={activeId === null ? 'op-tabpane active' : 'op-tabpane'}>
          <HomeView onOpenFile={openFile} onToast={setToast} />
        </div>
        {tabs.map((t) => (
          <div key={t.id} className={t.id === activeId ? 'op-tabpane active' : 'op-tabpane'}>
            <EditorView file={t} onToast={setToast} />
          </div>
        ))}
      </div>
      {toast && <div className="op-toast">{toast}</div>}
    </div>
  )
}

function TabBar({
  tabs, activeId, onHome, onActivate, onClose, onAdd,
}: {
  tabs: OfficeFile[]
  activeId: string | null
  onHome: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div className="op-tabbar">
      <div className="op-win-dots" aria-hidden>
        <span className="red" /><span className="yellow" /><span className="green" />
      </div>
      <button
        className={`op-tab home${activeId === null ? ' active' : ''}`}
        type="button"
        onClick={onHome}
        title="主页"
      >
        <Home size={15} />
        <span>主页</span>
      </button>
      <div className="op-tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`op-tab${activeId === t.id ? ' active' : ''}`}
            onClick={() => onActivate(t.id)}
            title={t.name}
          >
            <span className="op-tab-icon">
              <FileTypeIcon kind={t.kind} size={15} />
            </span>
            <span className="op-tab-name">{t.name}</span>
            <button
              className="op-tab-close"
              type="button"
              title="关闭标签"
              onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button className="op-tab-add" type="button" title="新建文字文档" onClick={onAdd}>
        <Plus size={15} />
      </button>
    </div>
  )
}

/** 主页标签页内部的侧边栏（品牌 + 五个一级菜单 + 账户），不分组。 */
function Sidebar({ active, onSelect }: { active: MenuKey; onSelect: (k: MenuKey) => void }) {
  const menus: { key: MenuKey; label: string; icon: React.ReactNode }[] = [
    { key: 'recent', label: '最近', icon: <Clock size={18} /> },
    { key: 'files', label: '所有文件', icon: <FolderOpen size={18} /> },
    { key: 'agent', label: 'Agent', icon: <Bot size={18} /> },
    { key: 'kb', label: '知识库', icon: <Library size={18} /> },
    { key: 'connectors', label: '连接器', icon: <Plug size={18} /> },
  ]
  return (
    <aside className="op-sidebar">
      <div className="op-brand">
        {/* EverRoomMac 品牌标：项目原有 app 图标（原型占位 "E" 字方块已替换） */}
        <img className="op-brand-mark" src={everroomAppIcon} alt="" aria-hidden="true" draggable={false} />
        <div className="op-brand-text">
          <span className="op-brand-name">EverRoom</span>
          <span className="op-brand-sub">Office</span>
        </div>
      </div>

      <nav className="op-nav">
        <div className="op-nav-section">
          {menus.map((m) => (
            <NavItem
              key={m.key}
              icon={m.icon}
              label={m.label}
              active={active === m.key}
              onClick={() => onSelect(m.key)}
            />
          ))}
        </div>
      </nav>
      <div className="op-sidebar-foot">
        <button className="op-userbar" type="button" title="账户与设置">
          <div className="op-avatar">王</div>
          <span className="op-userbar-name">王小雨</span>
          <span className="op-userbar-gear"><Settings size={15} /></span>
        </button>
      </div>
    </aside>
  )
}

function NavItem({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button className={`op-nav-item${active ? ' active' : ''}`} type="button" onClick={onClick}>
      <span className="op-nav-icon">{icon}</span>
      <span className="op-nav-label">{label}</span>
    </button>
  )
}

function HomeView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [view, setView] = useState<MenuKey>('recent')

  return (
    <div className="op-home">
      <Sidebar active={view} onSelect={setView} />
      <div className="op-home-main">
        <div className="op-scroll">
          {view === 'recent' && (
            <RecentView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'files' && (
            <AllFilesView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'agent' && (
            <AgentView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'kb' && (
            <KnowledgeView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'connectors' && (
            <ConnectorsView onToast={onToast} />
          )}
        </div>
      </div>
    </div>
  )
}
