import { existsSync } from 'node:fs'

import type { OpenWithStaging } from './open-with-staging'

/**
 * 解析「用外部应用打开」的落盘目标。
 *
 * 必须用 storage 路由（`/v1/files/:id/storage`）取字节路径：旧的
 * `GET /v1/files/:id` 只覆盖 uploadedFiles 表，资料库/产物/Agent 产物都是
 * file_entries 目录条目，走它必 404，外部打开入口会静默消失。目录条目用
 * `/v1/files/catalog/:id` 取原始文件名；老条目才回退旧文件表。
 */
export interface OpenWithTargetPorts {
  /** `/v1/files/:id/storage`：目录条目与旧上传条目都支持。 */
  storagePath: (fileId: string) => Promise<string>
  /** `/v1/files/catalog/:id`：目录条目元数据（原始文件名）。 */
  catalogEntry: (fileId: string) => Promise<{ originalName: string }>
  /** `/v1/files/:id`：仅旧 uploadedFiles 条目，作为原始名兜底。 */
  legacyFile: (fileId: string) => Promise<{ originalName: string }>
}

export async function resolveOpenWithTarget(
  ports: OpenWithTargetPorts,
  staging: Pick<OpenWithStaging, 'associationTarget' | 'openTarget'>,
  fileId: string,
  mode: 'association' | 'open',
): Promise<string> {
  const [storagePath, entry] = await Promise.all([
    ports.storagePath(fileId),
    ports.catalogEntry(fileId).catch(() => null),
  ])
  const legacy = entry ? null : await ports.legacyFile(fileId).catch(() => null)
  const originalName = entry?.originalName?.trim() || legacy?.originalName?.trim() || fileId
  // 网关对已删除条目可能回空/失效 storagePath：不要拿空路径去造占位/副本。
  if (!storagePath || !existsSync(storagePath)) throw new Error('文件不存在或已被清理')
  return mode === 'association'
    ? staging.associationTarget(storagePath, fileId, originalName)
    : staging.openTarget(storagePath, fileId, originalName)
}