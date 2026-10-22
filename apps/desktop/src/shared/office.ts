/** Agent 生成 Office 文件的主进程 → 渲染层事件（channel office:agent-file）。 */
export type OfficeAgentFileFormat = 'docx' | 'pptx' | 'xlsx'

export interface OfficeAgentFileEvent {
  type: 'phase' | 'done' | 'error' | 'edited' | 'open-edit'
  title: string
  /** 缺省 docx（旧事件无此字段）。 */
  format?: OfficeAgentFileFormat
  phase?: 'rendering' | 'saved' | 'importing'
  /** done：fileEntryId，渲染层用它自动打开预览。 */
  fileId?: string
  originalName?: string
  roomId?: string | null
  message?: string
  /** done：部分完成（有页失败/退化）——不走「已生成」文案。 */
  partial?: boolean
  /** done：已落定的页数（pptx 逐页落页后的真完成载荷）。 */
  appliedPages?: number
  totalPages?: number
  /** done：失败/退化页 0 起页码。 */
  failedPages?: number[]
}

/** slides「AI 修改」弹层转发的主进程 → 渲染层事件（channel office:agent-ask）。 */
export interface OfficeAgentAskEvent {
  /** 目标 Room：渲染层切到该 Room 并注入对话框。 */
  roomId: string
  /** 已组装好的用户消息（含元素 id 与工具定位提示），直接自动发送。 */
  message: string
  /** 给用户看的人话（聊天层只展示它，不再把内部指令渲染成用户气泡）。 */
  displayMessage?: string
}
