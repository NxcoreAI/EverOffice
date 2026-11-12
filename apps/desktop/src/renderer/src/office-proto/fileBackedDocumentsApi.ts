/**
 * 文件库支撑的「旧文稿编辑器」API 实现。
 *
 * 背景：`components/office-editor/**` 是 2026-11 从 EverRoom 云文稿时代恢复的
 * 编辑器，它通过 `window.nxcore.documents` / `window.nxcore.externalDocuments`
 * 两个 IPC 面读写文稿。主进程的文稿 UI/IPC 链路已下线，侧栏的 Markdown 文件
 * 改由「文件库」（`window.nxcore.files`）承载，所以这里造一份 `DocumentsApi`
 * 的实现，由 `SidebarDocumentEditor` 在挂载时注册
 * （`registerDocumentsApi`），旧编辑器代码无需改用另一种数据源。
 *
 * 能力边界（与文件库能提供的东西一一对应）：
 * - 读文档 / 列表 / 保存：映射到宿主的 synthetic `RoomDocument` + `files.saveMarkdown`；
 * - 评论、版本历史、速览生成、章节预览、块引用索引、Agent 文稿操作、外部导入导出
 *   这些依赖已下线的文稿后端：读路径返回空结果（避免面板挂载时报错、轮询刷屏），
 *   写路径给出明确的「暂不支持」rejection（只有用户主动点按钮才会触发）。
 */
import type {
  DocumentBlockList,
  DocumentOverviewView,
  DocumentSectionPreviewResult,
  ResolveDocumentBlockReferencesResult,
  RoomDocument,
  SaveRoomDocumentInput,
} from '@nxcore/agent-contract'

import type { DocumentsApi, ExternalDocumentsApi } from '@/components/office-editor/documentApi'
import type { FileCatalogDto } from '@/shared/ingest'

import { documentJsonToMarkdown } from './markdownDocumentAdapter'

/** 以工作空间为键的等价 Room id（旧文稿类型里 roomId 是必填 string）。 */
export function workspaceRoomIdForFile(catalog: FileCatalogDto): string {
  return `workspace-${catalog.workspaceId}`
}

export interface FileBackedDocumentsApiOptions {
  /** 文件库条目 id（= 旧编辑器眼里的 documentId）。 */
  fileId: string
  catalog: FileCatalogDto
  /** 当前文稿快照（宿主持有的 synthetic RoomDocument）。 */
  getDocument: () => RoomDocument
  /** 宿主保存：Markdown 正文落盘（files.saveMarkdown）+ 版本/时间戳自增。 */
  saveDocument: (input: SaveRoomDocumentInput) => Promise<RoomDocument>
  /**
   * 可选：把标题改动同步成文件显示名（`files.rename`）。
   * 宿主若已在 saveDocument 内部处理改名则不必提供；这里只在标题与保存结果
   * 不一致时作为兜底调用，且失败不阻断正文落盘。
   */
  rename?: (title: string) => Promise<void>
}

const COMMENT_UNSUPPORTED = '侧栏文件编辑器暂不支持文档评论（本地 Markdown 文件没有评论后端）。'
const HISTORY_UNSUPPORTED = '侧栏文件编辑器暂不支持版本历史（本地 Markdown 文件没有版本后端）。'
const OVERVIEW_UNSUPPORTED = '速览生成不可用（侧栏文件编辑器没有 AI 速览后端）。'
const OPERATION_UNSUPPORTED = '侧栏文件编辑器暂不支持 Agent 文稿操作（本地 Markdown 文件没有文稿操作后端）。'
const IMAGE_UNSUPPORTED = '侧栏文件编辑器暂不支持图片迁入文稿资产库（本地 Markdown 的图片按原样保留在文件里）。'
const IMPORT_UNSUPPORTED = '侧栏文件编辑器暂不支持导入文稿（当前文件来自本地文件库）。'
const EXPORT_UNSUPPORTED = '侧栏文件编辑器暂不支持导出 PDF（当前文件来自本地文件库）。'
const TRASH_UNSUPPORTED = '侧栏文件编辑器暂不支持文稿回收站操作（当前文件来自本地文件库）。'
const EXTERNAL_UNSUPPORTED = '侧栏文件编辑器暂不支持外部文档导入/导出（当前文件来自本地文件库）。'

function rejectWith(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message))
}

/**
 * 造一份「文件库支撑」的 `DocumentsApi`。
 *
 * 返回值类型就是旧的 `DocumentsApi`，所以我们不做任何 `as` 断言 —— 少实现
 * 一个方法 / 返回形状不对都会在 typecheck 里直接暴露。
 */
export function createFileBackedDocumentsApi(
  options: FileBackedDocumentsApiOptions,
): DocumentsApi {
  const roomId = workspaceRoomIdForFile(options.catalog)
  const currentDocument = () => options.getDocument()

  return {
    /* ── 读：映射到当前文件 ── */
    list: async () => [currentDocument()],
    listTrash: async () => [],
    get: async () => currentDocument(),
    readMarkdown: async () => ({
      markdown: documentJsonToMarkdown(currentDocument().contentJson),
    }),
    listBlocks: async (): Promise<DocumentBlockList> => {
      const document = currentDocument()
      return {
        documentId: document.id,
        roomId,
        version: document.version,
        blocks: [],
      }
    },
    listBlockBacklinks: async (_documentId: string, blockId?: string) => ({
      documentId: _documentId,
      blockId: blockId ?? null,
      backlinks: [],
    }),
    resolveBlockReferences: async (): Promise<ResolveDocumentBlockReferencesResult> => ({
      resolutions: [],
    }),
    listDocumentComments: async () => ({ items: [] }),
    listVersions: async () => [],
    listOperations: async () => [],

    /* ── 速览：返回「不可生成」态，旧编辑器就不会在挂载时自动触发生成 ── */
    getOverview: async (documentId: string): Promise<DocumentOverviewView> => ({
      documentId,
      topic: null,
      points: [],
      conclusion: null,
      generatedAtVersion: null,
      generatedAt: null,
      eligible: false,
      reason: 'empty',
      aiAvailable: false,
    }),
    getSectionPreview: async (
      documentId: string,
      input,
    ): Promise<DocumentSectionPreviewResult> => ({
      documentId,
      blockId: input.blockId,
      preview: '',
      generatedAt: new Date().toISOString(),
      cached: false,
    }),

    /* ── 写：正文保存走文件库，其它写能力明确拒绝 ── */
    save: async (documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument> => {
      // 安全闸：旧编辑器在卸载时会 fire-and-forget 冲刷在途保存。切文件时新文件的
      // shim 已经注册，旧编辑器那次保存会拿到「新文件」的实现——documentId 还是旧
      // 文件的，这里必须拒绝，绝不能把 A 的正文写到 B 的 fileEntry 上。旧编辑器的
      // 卸载清理已先把 pending 写进 localStorage 草稿，重开该文件时可恢复。
      if (documentId !== options.fileId) {
        throw new Error('保存目标与当前侧栏文件不一致（切文件时的在途保存已转为本地草稿）。')
      }
      const saved = await options.saveDocument(input)
      const nextTitle = input.title?.trim()
      // 宿主正常路径已在 saveDocument 里同步改名；这里的 rename 是给「只存正文」的
      // 宿主留的兜底，失败不影响正文已落盘。
      if (nextTitle && nextTitle !== saved.title && options.rename) {
        try {
          await options.rename(nextTitle)
        } catch {
          // 改名是 best-effort：文件显示名没改成功，正文仍然保存了。
        }
      }
      return saved
    },
    createDocumentComment: rejectWith(COMMENT_UNSUPPORTED),
    resolveDocumentComment: rejectWith(COMMENT_UNSUPPORTED),
    deleteDocumentComment: rejectWith(COMMENT_UNSUPPORTED),
    generateOverview: rejectWith(OVERVIEW_UNSUPPORTED),
    getVersionSnapshot: rejectWith(HISTORY_UNSUPPORTED),
    getDiff: rejectWith(HISTORY_UNSUPPORTED),
    versionChangeSummary: rejectWith(HISTORY_UNSUPPORTED),
    restoreVersion: rejectWith(HISTORY_UNSUPPORTED),
    startOperation: rejectWith(OPERATION_UNSUPPORTED),
    getOperation: rejectWith(OPERATION_UNSUPPORTED),
    executeOperationCommand: rejectWith(OPERATION_UNSUPPORTED),
    storeImage: rejectWith(IMAGE_UNSUPPORTED),
    import: rejectWith(IMPORT_UNSUPPORTED),
    delete: rejectWith(TRASH_UNSUPPORTED),
    move: rejectWith(TRASH_UNSUPPORTED),
    moveMany: rejectWith(TRASH_UNSUPPORTED),
    restore: rejectWith(TRASH_UNSUPPORTED),
    deletePermanently: rejectWith(TRASH_UNSUPPORTED),
    emptyTrash: rejectWith(TRASH_UNSUPPORTED),
    exportPdf: rejectWith(EXPORT_UNSUPPORTED),

    /* ── 事件流：本地文件没有文稿事件推送，注册空订阅并立即 ready ── */
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
    onEvent: () => () => undefined,
    onOperationChanged: () => () => undefined,
    onReady: () => () => undefined,
  }
}

/**
 * 外部文档（飞书 / Notion）导入导出 API 的降级实现。
 *
 * 侧栏打开的是本地文件库文件，没有远端绑定；旧编辑器的外部导入/导出入口、
 * 评论面板、导出状态条会读这个 API。读路径返回空结果（导出状态条每 2.5s
 * 轮询 `listExports`，reject 会让状态条一直闪错误），写路径明确拒绝。
 */
export function createUnavailableExternalDocumentsApi(): ExternalDocumentsApi {
  return {
    /* ── 读：空结果（面板渲染成「没有外部内容」） ── */
    activeImportBatch: async () => null,
    importHistory: async () => ({ entries: [], commentDiff: null, comments: [] }),
    importDiff: async () => ({
      candidateTitle: '',
      currentTitle: '',
      appliedVersion: null,
      hunks: [],
      commentsComparable: false,
    }),
    searchExportTargets: async () => ({ items: [] }),
    listExports: async () => ({ items: [] }),

    /* ── 写 / 一次性查询：明确拒绝 ── */
    importSearch: rejectWith(EXTERNAL_UNSUPPORTED),
    importList: rejectWith(EXTERNAL_UNSUPPORTED),
    importBatch: rejectWith(EXTERNAL_UNSUPPORTED),
    importBatchStatus: rejectWith(EXTERNAL_UNSUPPORTED),
    cancelImportBatch: rejectWith(EXTERNAL_UNSUPPORTED),
    importPreview: rejectWith(EXTERNAL_UNSUPPORTED),
    importCommit: rejectWith(EXTERNAL_UNSUPPORTED),
    importRun: rejectWith(EXTERNAL_UNSUPPORTED),
    cancelImportRun: rejectWith(EXTERNAL_UNSUPPORTED),
    importStructuredDiff: rejectWith(EXTERNAL_UNSUPPORTED),
    checkExternalUpdate: rejectWith(EXTERNAL_UNSUPPORTED),
    applyCandidate: rejectWith(EXTERNAL_UNSUPPORTED),
    createExport: rejectWith(EXTERNAL_UNSUPPORTED),
    getExport: rejectWith(EXTERNAL_UNSUPPORTED),
    confirmExport: rejectWith(EXTERNAL_UNSUPPORTED),
    retryExport: rejectWith(EXTERNAL_UNSUPPORTED),
    cancelExport: rejectWith(EXTERNAL_UNSUPPORTED),
  }
}