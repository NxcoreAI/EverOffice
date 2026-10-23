import { useEffect, useRef, useState } from 'react'

import { useLocale } from '../../../../../i18n/LocaleContext'
import { KnowledgeFileExternalCard } from '../detail-panels/KnowledgeFileExternalCard'
import { releaseEmbeddedOffice, setEmbeddedOffice } from '@/components/office-editor/embeddedOffice'
import { attachOfficeViewport, type OfficeViewportAttachment } from '@/components/office-editor/officeViewport'
import type { ContextRoomKnowledgeFileResource, ContextRoomRecord } from '@/components/office-editor/types'

/** 内嵌预览失败的三类真实来源；渲染时再翻译，effect 不依赖 locale。 */
type PreviewFailure =
  | { code: 'bridge' }
  | { code: 'external' }
  | { code: 'error'; detail?: string }

/**
 * Room 右区内嵌的 Office 预览宿主（OOXML 可编辑预览，pdf/legacy 只读）。
 * 真正的文档是主进程 WebContentsView 叠在窗口上：这里只渲染占位 div，
 * 挂载时经 files.openOriginal 取实例并登记进 embeddedOffice 仲裁，
 * 矩形上报与弹层遮挡显隐交给 officeViewport（激活由 App 统一裁决）。
 * 打开失败时不再伪装「已用系统应用打开」：回退卡展示真实原因，可重试或主动交给系统应用。
 */
export function EmbeddedOfficePreview({
  room,
  resource,
}: {
  room: ContextRoomRecord
  resource: ContextRoomKnowledgeFileResource
}) {
  const { t } = useLocale()
  const hostRef = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<PreviewFailure | null>(null)
  // 重试计数：改变 deps 让 effect 在宿主 div 重新挂载后再次走打开逻辑。
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    const office = window.nxcore?.office
    const files = window.nxcore?.files
    if (!office || !files) {
      setFailure({ code: 'bridge' })
      return
    }
    // 宿主 div 常驻，正常不会为空；空则如实标失败，不留空白占位。
    if (!host) {
      setFailure({ code: 'error' })
      return
    }
    let disposed = false
    let registered = false
    let attachment: OfficeViewportAttachment | null = null
    // 换文件或重试：先清掉上一次的失败态（宿主 div 始终挂载，hidden 仅视觉隐藏）。
    setFailure(null)
    // 产物编辑：docx/pptx/xlsx 传 editable（主进程注册表据此建可编辑视图并把保存回填版本链）；
    // 其余格式（pdf、legacy .doc/.ppt/.xls）仍只读预览。
    const editable = /\.(docx|pptx|xlsx)$/.test(resource.originalName.toLowerCase())
    void files.openOriginal(
      resource.fileId,
      resource.originalName,
      undefined,
      editable ? { editable: true, roomId: room.id } : undefined,
    )
      .then((result) => {
        if (disposed) return
        if (result?.openedWith !== 'office') {
          // 主进程内嵌预览不可用时会把原件交给系统默认应用；如实标失败并给出原因。
          setFailure({ code: 'external' })
          return
        }
        registered = true
        setEmbeddedOffice({ roomId: room.id, fileId: resource.fileId, instanceId: result.instanceId })
        attachment = attachOfficeViewport(host)
      })
      .catch((error) => {
        console.error('Failed to open the embedded Office preview.', error)
        if (!disposed) {
          setFailure({ code: 'error', detail: error instanceof Error ? error.message : undefined })
        }
      })
    return () => {
      disposed = true
      // 先发零尺寸当帧隐藏原生视图，再让出激活权：App 仲裁的 IPC 慢一步到达。
      attachment?.detach()
      if (registered) releaseEmbeddedOffice(resource.fileId)
    }
  }, [room.id, resource.fileId, resource.originalName, attempt])

  // 失败原因按 code 渲染时翻译，effect 因此不必依赖 locale。
  const failureCodeText = (next: PreviewFailure): string => (
    next.code === 'bridge'
      ? t('contextRoom:knowledgeFileExternal.fileServiceUnavailable')
      : next.code === 'external'
        ? t('contextRoom:knowledgeFileExternal.previewFellBackToSystemApp')
        : next.detail ?? t('contextRoom:knowledgeFileExternal.openFailed')
  )
  return (
    <>
      {failure ? (
        <KnowledgeFileExternalCard
          resource={resource}
          failureReason={failureCodeText(failure)}
          onRetry={() => {
            setFailure(null)
            setAttempt((value) => value + 1)
          }}
        />
      ) : null}
      <div
        ref={hostRef}
        className="context-room-embedded-office-host"
        data-office-file-id={resource.fileId}
        // 宿主常驻以保住 ref：失败卡覆盖其上，重试/换文件时复用同一 div 重新挂载原生视图。
        hidden={failure !== null}
      />
    </>
  )
}
