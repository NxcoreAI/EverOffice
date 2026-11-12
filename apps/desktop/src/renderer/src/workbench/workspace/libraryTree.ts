import type { RoomDocument } from '@nxcore/agent-contract'

import { translateZh, type Translate } from '@/i18n/LocaleContext'
import { cloudDocumentTitle, type RealOfficeFile } from '@/office-proto/data'

import { directoryOf, fileSearchText } from './fileBrowser'

/**
 * 资料页的目录树。
 *
 * 真实文件库没有文件夹实体，层级从 `relativePath` 派生（`docs/api/spec.md`
 * → 资料 / docs / api）。口径与原型「资料」文件管理器一致：
 * 文件夹的「n 项」只算直接子文件，不递归。本模块是纯函数，页面只负责渲染。
 *
 * `.tmp/`（Agent 过程缓存）不进文件库索引，单独走 scratch 清单：
 * 用保留前缀 `TMP_FOLDER_PREFIX` 挂进同一棵树（网关扫描资料根时跳过 `.tmp`，
 * 用户自建同名目录不会与之冲突——scratch 分支只在进入该前缀后启用）。
 */

export interface LibraryFolder {
  /** 从根算起的目录路径，如 `docs/api`（根为空串）。 */
  path: string
  /** 目录名（最后一段）。 */
  name: string
  /** 直接子文件数（不含子文件夹里的文件）。 */
  fileCount: number
}

export interface LibraryCrumb {
  path: string
  name: string
}

export interface LibraryLevel {
  /** 当前目录路径，根为 ''。 */
  path: string
  /** 当前目录的子文件夹，按名称排序。 */
  folders: LibraryFolder[]
  /** 当前目录的文件，保持传入顺序（调用方已按更新时间倒序）。 */
  files: RealOfficeFile[]
}

/** 列表视图的一行：文件夹在前、文件在后（与原型同序）。 */
export type LibraryRow =
  | { kind: 'folder'; path: string; name: string; fileCount: number; location: string }
  | { kind: 'file'; item: RealOfficeFile; location: string }
  /** 工作空间云文档（documents 表）：无文件夹层级、无文件库条目，点开走云文档编辑器。 */
  | { kind: 'cloud-doc'; document: RoomDocument; name: string; location: string }
  /** scratch（`.tmp/`）里的临时文件：不入库索引，只读浏览 + 访达定位。 */
  | { kind: 'scratch'; path: string; name: string; location: string; sizeLabel: string; modifiedLabel: string }

export const LIBRARY_ROOT_KEY = 'workbench:workspace.library.root'

/** scratch（`.tmp/`）子树的保留路径前缀；与真实文件夹命名空间互不混淆。 */
export const TMP_FOLDER_PATH = '.tmp'

export function isTmpPath(path: string): boolean {
  return path === TMP_FOLDER_PATH || path.startsWith(`${TMP_FOLDER_PATH}/`)
}

export function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
}

/** 文件所在目录（`docs/api/spec.md` → `docs/api`，根目录为 ''）。 */
export function folderOf(item: RealOfficeFile): string {
  return normalizeFolderPath(directoryOf(item.catalog.relativePath))
}

export function parentFolderOf(path: string): string {
  const segments = normalizeFolderPath(path).split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

/** 面包屑链（不含根「资料库」）：`docs/api` → [docs, docs/api]。 */
export function folderCrumbs(path: string): LibraryCrumb[] {
  const segments = normalizeFolderPath(path).split('/').filter(Boolean)
  return segments.map((name, index) => ({
    path: segments.slice(0, index + 1).join('/'),
    name,
  }))
}

/** 位置列的展示文案：`docs/api` → `docs / api`，根目录 → 「资料」。 */
export function folderLabel(path: string, t: Translate = translateZh): string {
  const normalized = normalizeFolderPath(path)
  const rootLabel = t(LIBRARY_ROOT_KEY)
  if (normalized === TMP_FOLDER_PATH) return `${rootLabel} / ${TMP_FOLDER_PATH}`
  return normalized ? normalized.split('/').join(' / ') : rootLabel
}

function nameCollator(left: string, right: string): number {
  return left.localeCompare(right, 'zh')
}

/** 某一层目录里的子文件夹 + 文件。 */
export function buildLibraryLevel(
  items: readonly RealOfficeFile[],
  path: string,
): LibraryLevel {
  const current = normalizeFolderPath(path)
  const prefix = current ? `${current}/` : ''
  const files: RealOfficeFile[] = []
  const childNames = new Set<string>()
  const directFileCount = new Map<string, number>()

  for (const item of items) {
    const folder = folderOf(item)
    if (folder === current) {
      files.push(item)
      continue
    }
    if (!folder.startsWith(prefix)) continue
    const rest = folder.slice(prefix.length)
    if (!rest) continue
    const childName = rest.split('/')[0]
    childNames.add(childName)
    if (rest === childName) {
      directFileCount.set(childName, (directFileCount.get(childName) ?? 0) + 1)
    }
  }

  const folders: LibraryFolder[] = [...childNames].sort(nameCollator).map((name) => ({
    path: prefix ? `${prefix}${name}` : name,
    name,
    fileCount: directFileCount.get(name) ?? 0,
  }))

  return { path: current, folders, files }
}

/** 当前层的一行行列表（文件夹在前，文件在后）。 */
export function levelRows(level: LibraryLevel, t: Translate = translateZh): LibraryRow[] {
  const location = folderLabel(level.path, t)
  return [
    ...level.folders.map((folder): LibraryRow => ({
      kind: 'folder',
      path: folder.path,
      name: folder.name,
      fileCount: folder.fileCount,
      location,
    })),
    ...level.files.map((item): LibraryRow => ({ kind: 'file', item, location })),
  ]
}

/* ───────────────── scratch（.tmp/）子树 ───────────────── */

export interface ScratchLevel {
  /** `.tmp` 内的当前目录（树内路径，根为 TMP_FOLDER_PATH）。 */
  path: string
  /** 直接子目录名。 */
  folders: string[]
  /** 当前目录直接文件（path 相对 `.tmp` 根）。 */
  files: Array<{ path: string; name: string; size: number; modifiedAt: string }>
}

/**
 * `.tmp/` 某一层：从 scratch 清单（扁平 path 列表）派生层级，
 * 口径与资料树一致（子文件夹 + 直接文件，不递归计数）。
 */
export function buildScratchLevel(
  entries: ReadonlyArray<{ path: string; size: number; modifiedAt: string }>,
  path: string,
): ScratchLevel {
  const current = normalizeFolderPath(path) || TMP_FOLDER_PATH
  const folders = new Set<string>()
  const files: ScratchLevel['files'] = []
  for (const entry of entries) {
    const normalized = normalizeFolderPath(entry.path)
    if (!normalized) continue
    const relDir = directoryOf(normalized)
    const absDir = relDir ? `${TMP_FOLDER_PATH}/${relDir}` : TMP_FOLDER_PATH
    if (absDir === current) {
      files.push({
        path: normalized,
        name: normalized.split('/').pop()!,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      })
      continue
    }
    if (!absDir.startsWith(`${current}/`)) continue
    const rest = absDir.slice(current.length + 1)
    if (rest) folders.add(rest.split('/')[0])
  }
  return { path: current, folders: [...folders].sort(nameCollator), files }
}

/** scratch 层的行（与 levelRows 同构；文件行 kind='scratch'，文件夹行复用 'folder'）。 */
export function scratchRows(level: ScratchLevel, t: Translate = translateZh): LibraryRow[] {
  const location = folderLabel(level.path, t)
  return [
    ...level.folders.map((name): LibraryRow => ({
      kind: 'folder' as const,
      path: `${level.path}/${name}`,
      name,
      fileCount: 0,
      location,
    })),
    ...level.files.map((file): LibraryRow => ({
      kind: 'scratch',
      path: `${TMP_FOLDER_PATH}/${file.path}`,
      name: file.name,
      location,
      sizeLabel: formatBytes(file.size),
      modifiedLabel: formatScratchTime(file.modifiedAt),
    })),
  ]
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

function formatScratchTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  return new Date(at).toLocaleString()
}

export interface LibrarySearch {
  /** 命中关键字的文件夹（全库范围，忽略当前目录）。 */
  folders: LibraryRow[]
  files: LibraryRow[]
}

/** 全库搜索：文件夹按名称命中，文件按名称/路径/来源/标签命中（与列表搜索同口径）。 */
export function searchLibrary(
  items: readonly RealOfficeFile[],
  keyword: string,
  t: Translate = translateZh,
): LibrarySearch {
  const query = keyword.trim().toLowerCase()
  if (!query) return { folders: [], files: [] }

  const folderFiles = new Map<string, number>()
  const folders = new Set<string>()
  for (const item of items) {
    const folder = folderOf(item)
    if (!folder) continue
    folderFiles.set(folder, (folderFiles.get(folder) ?? 0) + 1)
    const segments = folder.split('/')
    segments.forEach((_, index) => folders.add(segments.slice(0, index + 1).join('/')))
  }

  const folderRows = [...folders]
    .filter((path) => path.split('/').pop()!.toLowerCase().includes(query))
    .sort(nameCollator)
    .map((path): LibraryRow => ({
      kind: 'folder',
      path,
      name: path.split('/').pop()!,
      fileCount: folderFiles.get(path) ?? 0,
      location: folderLabel(parentFolderOf(path), t),
    }))

  const fileRows = items
    .filter((item) => fileSearchText(item).includes(query))
    .map((item): LibraryRow => ({
      kind: 'file',
      item,
      location: folderLabel(folderOf(item), t),
    }))

  return { folders: folderRows, files: fileRows }
}

/* ───────────────── 云文档（documents 表）行 ───────────────── */

/**
 * 云文档行：没有 relativePath 层级，直接平铺在资料根目录的文件行之间
 * （kind='cloud-doc'），不做保留文件夹——用户明确不要额外的「云文档」目录。
 */
export function cloudDocRows(
  documents: readonly RoomDocument[],
  t: Translate = translateZh,
): LibraryRow[] {
  return documents.map((document): LibraryRow => ({
    kind: 'cloud-doc',
    document,
    name: cloudDocumentTitle(document),
    location: folderLabel('', t),
  }))
}

/** 云文档搜索命中（按标题，全库搜索范围与文件一致）。 */
export function searchCloudDocs(
  documents: readonly RoomDocument[],
  keyword: string,
  t: Translate = translateZh,
): LibraryRow[] {
  const query = keyword.trim().toLowerCase()
  if (!query) return []
  return cloudDocRows(
    documents.filter((document) => cloudDocumentTitle(document).toLowerCase().includes(query)),
    t,
  )
}

/** 云文档按更新时间倒序（与文件行同一排序口径）。 */
export function sortCloudDocsByUpdatedDesc(documents: readonly RoomDocument[]): RoomDocument[] {
  return [...documents].sort((left, right) => {
    const leftAt = Date.parse(left.updatedAt)
    const rightAt = Date.parse(right.updatedAt)
    if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return 0
    return rightAt - leftAt
  })
}
