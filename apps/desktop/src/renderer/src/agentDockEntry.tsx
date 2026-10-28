// GenOffice 内嵌停靠栏 Agent 标签的装载页。宿主 bridge 以 docksrc 参数把
// 本页（/agent-dock.html?kind=docx&file=…）装进停靠栏 iframe；页面渲染移植的
// EverRoom 聊天（AgentChatDock），与外壳 md 路径的 SideDock 共用同一实现。
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { AgentChatDock } from './office-proto/AgentChatDock'
import { type FileKind, type OfficeFile } from './office-proto/data'
import './office-proto/agentDockPage.css'

const params = new URLSearchParams(window.location.search)
const kind = (params.get('kind') ?? 'docx') as FileKind
const fileName = params.get('file') ?? '当前文档'

const file: OfficeFile = {
  id: `agent-dock-${kind}`,
  name: fileName,
  kind,
  roomId: null,
  sizeLabel: '',
  updatedLabel: '',
  memoryCount: 0,
  content: { type: 'md', source: '' },
}

function Page() {
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <div className="agent-dock-page">
      <AgentChatDock file={file} onToast={setToast} />
      {toast && <div className="agent-dock-toast">{toast}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
)
