import type { OfficeFile } from '@/office-proto/data'

/**
 * 「Agent 产物就绪 → 自动展示」的窗口事件（Workbench 派发，WorkspaceTabHost 消费）。
 *
 * 为什么走窗口事件而不是 store：气泡窗状态机（useWorkspaceBubble）是组件级、
 * 每个工作空间标签一份，store 放不下；已有的 everroom:workbench-toggle-bubble
 * 同因走同一条路。
 *
 * payload 带 tabId 定向：只有产物归属的工作空间标签响应，别的标签不动。
 */
export const OPEN_AGENT_FILE_EVENT = 'everroom:open-agent-file'

export interface OpenAgentFileDetail {
  /** 目标工作空间标签 id（事件只应被该标签消费）。 */
  tabId: string
  /** 归属工作空间 id（校验用；与 tabId 一一对应）。 */
  workspaceId: string
  /** 已转换好的文件对象（realCatalog 形态，气泡窗直接开编辑器）。 */
  file: OfficeFile
}

export function dispatchOpenAgentFile(detail: OpenAgentFileDetail): void {
  window.dispatchEvent(new CustomEvent<OpenAgentFileDetail>(OPEN_AGENT_FILE_EVENT, { detail }))
}

export function isWorkspaceBubbleTarget(
  detail: OpenAgentFileDetail,
  tabId: string,
): boolean {
  return detail.tabId === tabId
}

/**
 * 「从对话里打开工作空间云文档」：Agent 回复的云文档卡点击后派发，当前激活的
 * 工作空间标签（WorkspaceTabHost）收到后用伪 OfficeFile 在气泡窗打开编辑器。
 *
 * 云文档没有文件库条目，也没有 tabId：事件不带目标，只有激活标签消费（后台标签
 * 收到也不抢，避免在不可见的空间气泡窗里开文件）。
 */
export const OPEN_CLOUD_DOCUMENT_EVENT = 'everroom:open-cloud-document'

export interface OpenCloudDocumentDetail {
  /** documents 表文稿 id。 */
  documentId: string
  /** 展示标题（伪文件标签/编辑器标题）。 */
  title: string
}

export function dispatchOpenCloudDocument(detail: OpenCloudDocumentDetail): void {
  window.dispatchEvent(new CustomEvent<OpenCloudDocumentDetail>(OPEN_CLOUD_DOCUMENT_EVENT, { detail }))
}
