import {
  markdownDocumentTitle,
  parseMarkdownDocument,
} from '@/components/office-editor/editor/markdownImport'
import type { KnowledgeFileDto } from '../../../../shared/knowledge'

const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/i

/** md 判定（自动转文档/应用内预览 vs 原生打开的分流依据）。 */
export function isMarkdownFileName(fileName: string): boolean {
  return MARKDOWN_FILE_PATTERN.test(fileName)
}

/** 已转文档的 (roomId, fileId)：轮询/补跑重复触发时跳过（标题去重兜底）。 */
const importedFileKeys = new Set<string>()

/** 原件隐藏判定用的标题：去扩展名；不套「无标题文档」兜底，避免空名原件被误隐藏。 */
function strippedMarkdownTitle(fileName: string): string {
  return fileName.replace(MARKDOWN_FILE_PATTERN, '').trim()
}

/**
 * md 原件是否已转为云文档：以「Room 内存在同名（去扩展名）云文档」为准，
 * 与转换侧的幂等去重同一条规则——用户删除该云文档后原件自然回显。
 */
export function isConvertedMarkdownFile(
  originalName: string,
  documentTitles: ReadonlySet<string>,
): boolean {
  return isMarkdownFileName(originalName)
    && documentTitles.has(strippedMarkdownTitle(originalName))
}

/** 文件清单视图用：隐藏已转云文档的 md 原件，其余（含未转换 md）原样保留。 */
export function filterConvertedMarkdownFiles<T extends { originalName: string }>(
  files: T[],
  documentTitles: ReadonlySet<string>,
): T[] {
  return files.filter((file) => !isConvertedMarkdownFile(file.originalName, documentTitles))
}

/**
 * Room 归属文件清单（隐藏已转换 md 原件）。文档清单不可用时保守不过滤，
 * 避免 API 抖动导致原件反复闪现。转换入口（importRoomMarkdownFiles）继续
 * 使用原始 listRoomFiles——它必须能看见原件才能转换。
 */
export async function listRoomFilesExcludingConverted(roomId: string): Promise<KnowledgeFileDto[]> {
  const knowledge = window.nxcore?.knowledge
  const documents = window.nxcore?.documents
  if (!knowledge) return []
  const [fileList, documentList] = await Promise.all([
    knowledge.listRoomFiles(roomId),
    documents ? documents.list(roomId).catch(() => null) : Promise.resolve(null),
  ])
  if (!documentList) return fileList.items
  return filterConvertedMarkdownFiles(fileList.items, new Set(documentList.map((document) => document.title)))
}

/**
 * 晋升完成后把 Room 归属的 md 上传文件转为可编辑云文档：
 * 与文档面板「导入本地 Markdown」同形态（parseMarkdownDocument → documents.import）。
 * 幂等：processed Set + 同名文档跳过；单文件失败不标记、不影响其余，留待下次触发重试。
 */
export async function importRoomMarkdownFiles(roomId: string): Promise<number> {
  const knowledge = window.nxcore?.knowledge
  const documents = window.nxcore?.documents
  if (!knowledge || !documents) return 0

  const { items } = await knowledge.listRoomFiles(roomId)
  const markdownFiles = items.filter((file) => MARKDOWN_FILE_PATTERN.test(file.originalName))
  if (!markdownFiles.length) return 0

  const existingTitles = new Set(
    (await documents.list(roomId)).map((document) => document.title),
  )
  let created = 0
  for (const file of markdownFiles) {
    // \u0000 分隔：id 不含 NUL，避免拼接歧义（转义写法，不往源文件写裸 NUL 字节）
    const key = `${roomId}\u0000${file.id}`
    if (importedFileKeys.has(key)) continue
    const title = markdownDocumentTitle(file.originalName)
    if (existingTitles.has(title)) {
      importedFileKeys.add(key)
      continue
    }
    try {
      const { markdown } = await knowledge.readFileMarkdown(file.id)
      await documents.import({
        id: crypto.randomUUID(),
        roomId,
        title,
        contentJson: parseMarkdownDocument(markdown),
      })
      existingTitles.add(title)
      importedFileKeys.add(key)
      created += 1
    } catch {
      // 单文件失败：不进 processed Set，下次触发重试
    }
  }
  return created
}

/** 转换产生了新文档才广播：各文件清单消费方据此重新拉取并隐藏原件。 */
function announceMarkdownImports(created: number): void {
  if (created > 0) window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
}

/** 晋升完成触发的导入入口：立即跑一次 + 1.5s 补跑（路由决策异步落库窗口）。 */
export function scheduleRoomMarkdownImport(roomId: string | null): void {
  if (!roomId) return
  void importRoomMarkdownFiles(roomId).then(announceMarkdownImports).catch(() => undefined)
  window.setTimeout(() => {
    void importRoomMarkdownFiles(roomId).then(announceMarkdownImports).catch(() => undefined)
  }, 1_500)
}

/** 网关就绪重试：knowledge 服务启动是异步的，未就绪时按固定间隔重试。 */
const SWEEP_READY_ATTEMPTS = 10
const SWEEP_READY_DELAY_MS = 5_000

async function listKnowledgeRoomIdsWithRetry(attempts: number, delayMs: number): Promise<string[] | null> {
  const knowledge = window.nxcore?.knowledge
  if (!knowledge?.listRooms) return null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { items } = await knowledge.listRooms()
      return items.map((room) => room.id)
    } catch {
      if (attempt === attempts) return null
      await new Promise((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  return null
}

/**
 * 启动补扫：晋升完成事件只有推荐面板在场才会触发 md 转换——应用没开时
 * 完成的晋升（面板没观察到 promoting→completed）将永远遗漏。逐 Room 重跑
 * 转换，幂等由 processed Set + 同名跳过保证。覆盖 user/auto 全量 Room，
 * Room 内上传的 md 也一并补转。
 */
export async function sweepRoomMarkdownImports(options?: {
  readyAttempts?: number
  readyDelayMs?: number
}): Promise<number> {
  const roomIds = await listKnowledgeRoomIdsWithRetry(
    options?.readyAttempts ?? SWEEP_READY_ATTEMPTS,
    options?.readyDelayMs ?? SWEEP_READY_DELAY_MS,
  )
  if (!roomIds) return 0
  let created = 0
  for (const roomId of roomIds) {
    created += await importRoomMarkdownFiles(roomId).catch(() => 0)
  }
  announceMarkdownImports(created)
  return created
}

/** 每应用会话只补扫一次；网关未就绪由内部重试兜住。 */
let sweepScheduled = false
export function scheduleRoomMarkdownSweep(): void {
  if (sweepScheduled) return
  sweepScheduled = true
  void sweepRoomMarkdownImports().catch(() => undefined)
}
