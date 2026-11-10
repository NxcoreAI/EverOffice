import type { NxcoreDesktopApi } from '@/shared/sources'

/**
 * 旧文稿编辑器（`components/office-editor/**`）直接取 `window.nxcore.documents`
 * 与 `window.nxcore.externalDocuments` 两个 IPC 面。主进程的文稿 UI/IPC 链路在
 * 2026-11 下线后已没有对应 handler，这里加一层可替换的 API 取用点：
 *
 * - 工作空间侧栏里的 Markdown 文件编辑器在挂载时注册一份「文件库支撑」的实现
 *   （见 `office-proto/fileBackedDocumentsApi.ts`），旧编辑器代码无需改用另一种
 *   数据源；
 * - 没有注册时仍回落到窗口桥（例如未来恢复真实文稿后端时，行为与原先一致）。
 */
export type DocumentsApi = NxcoreDesktopApi['documents']
export type ExternalDocumentsApi = NxcoreDesktopApi['externalDocuments']

let documentsOverride: DocumentsApi | null = null
let externalDocumentsOverride: ExternalDocumentsApi | null = null

/** 注册（或清除）当前挂载的文件库文稿实现。 */
export function registerDocumentsApi(api: DocumentsApi | null): void {
  documentsOverride = api
}

/** 注册（或清除）外部导入/导出实现（文件库侧不存在对应后端时可传 null）。 */
export function registerExternalDocumentsApi(api: ExternalDocumentsApi | null): void {
  externalDocumentsOverride = api
}

/** 当前生效的文稿 API：优先已注册实现，否则回落到 preload 窗口桥。 */
export function documentsApi(): DocumentsApi | undefined {
  return documentsOverride ?? window.nxcore?.documents
}

/** 当前生效的外部导入/导出 API。 */
export function externalDocumentsApi(): ExternalDocumentsApi | undefined {
  return externalDocumentsOverride ?? window.nxcore?.externalDocuments
}