import { useState } from 'react'
import { Wand2 } from 'lucide-react'
import { PortedContextRoom } from './ported/PortedContextRoom'
import { ThesisStudio } from '../thesis-studio/ThesisStudio'
import type { ContextRoomWorkspaceTab } from './contextRoomTabs'
import './ported/ContextRoom.css'
import './ported/PortedAdapters.css'

export function ContextRoomPage({
  activeRoomId,
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
  homeRequest,
  onDetailFocusChange,
  onOpenRoomTab,
  onRoomsChange,
  onShowHome,
  onFocusAgent,
}: {
  activeRoomId: string | null
  focusedDocumentId: string | null
  focusedBlockId: string | null
  documentFocusRequestId: number | null
  homeRequest: number
  onDetailFocusChange: (focused: boolean) => void
  onOpenRoomTab: (room: ContextRoomWorkspaceTab) => void
  onRoomsChange: (rooms: ContextRoomWorkspaceTab[]) => void
  onShowHome: () => void
  onFocusAgent: () => void
}) {
  const [studioOpen, setStudioOpen] = useState(false)

  return (
    <div className="context-room-operation-shell">
      <PortedContextRoom
        activeRoomId={activeRoomId}
        focusedDocumentId={focusedDocumentId}
        focusedBlockId={focusedBlockId}
        documentFocusRequestId={documentFocusRequestId}
        homeRequest={homeRequest}
        onDetailFocusChange={onDetailFocusChange}
        onOpenRoomTab={onOpenRoomTab}
        onRoomsChange={onRoomsChange}
        onShowHome={onShowHome}
        onFocusAgent={onFocusAgent}
      />
      {activeRoomId ? (
        <>
          <button
            type="button"
            className="thesis-studio-launcher"
            title="打开智能排版工作台"
            onClick={() => setStudioOpen(true)}
          >
            <Wand2 size={15} aria-hidden="true" />
            <span>智能排版</span>
          </button>
          {studioOpen ? <ThesisStudio roomId={activeRoomId} onClose={() => setStudioOpen(false)} /> : null}
        </>
      ) : null}
    </div>
  )
}
