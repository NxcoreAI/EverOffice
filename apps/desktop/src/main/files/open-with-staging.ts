import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * 「用外部应用打开」的落盘目标。
 *
 * 文件库的对象库路径是内容寻址的 `files/sha256/xx/<hash>`，没有扩展名：
 * 直接拿它查 LaunchServices 只会得到「文本编辑/归档实用工具」这类通用程序，
 * Word 也不会被当作 Word 打开。因此对这类条目，先按原始文件名复制一份
 * 到应用私有目录（带正确扩展名），再查询关联 / 启动应用。
 *
 * 来源本身就是磁盘上的真实文件（local-folder，storagePath 与 originalName
 * 扩展名一致）时直接用它：既省一次复制，也让外部应用的保存写回真实文件。
 * 对象库副本上的外部编辑不会回写文件库（与「导出定位」语义相同）。
 */

/** 按 UTF-8 字节数截断（文件名上限按字节算，中文按 3 字节/字）。 */
function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

/** 去掉路径成分与非法字符，保留扩展名；空名/超长名退回安全占位。 */
export function safeFileName(originalName: string): string {
  const normalized = basename(originalName.replace(/\\/g, '/')).trim()
  const cleaned = normalized
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+$/, '')
  if (!cleaned) return 'file'
  const extension = extname(cleaned)
  // 文件名按字节计上限 255；给 fileId 前缀与扩展名预留余量。
  const stem = truncateUtf8(cleaned.slice(0, cleaned.length - extension.length), 160) || 'file'
  return `${stem}${extension}`
}

/** 同一 fileId 的目标副本名：原始名 + 前缀，重复打开复用同一路径（覆盖内容）。 */
export function stagedFileName(fileId: string, originalName: string): string {
  const safe = safeFileName(originalName)
  const shortId = fileId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'file'
  return `${shortId}-${safe}`
}

/** 存储路径本身就是同扩展名的真实文件（local-folder 等），可直接作为打开目标。 */
export function isDirectOpenTarget(storagePath: string, originalName: string): boolean {
  const storedExtension = extname(storagePath).toLowerCase()
  const namedExtension = extname(safeFileName(originalName)).toLowerCase()
  return storedExtension !== '' && storedExtension === namedExtension && existsSync(storagePath)
}

export class OpenWithStaging {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  /** 该条目的目标副本路径（不保证已存在；只做路径计算，便于测试）。 */
  targetFor(fileId: string, originalName: string): string {
    return join(this.directory, stagedFileName(fileId, originalName))
  }

  /**
   * 关联查询用路径：只需要「带正确扩展名的文件存在」即可，LaunchServices
   * 按扩展名判类型，不读内容。所以首次创建空占位，避免为了显示菜单复制大文件。
   * 存储路径已是真实同类型文件时直接返回它。
   */
  async associationTarget(storagePath: string, fileId: string, originalName: string): Promise<string> {
    if (isDirectOpenTarget(storagePath, originalName)) return storagePath
    const target = this.targetFor(fileId, originalName)
    if (existsSync(target)) return target
    await mkdir(this.directory, { recursive: true })
    await writeFile(target, '')
    return target
  }

  /**
   * 启动外部应用前准备真实内容：对象库条目复制成同名副本（原子替换，避免
   * 应用正在读取时副本被截断）；真实文件直接原样返回。
   */
  async openTarget(storagePath: string, fileId: string, originalName: string): Promise<string> {
    if (isDirectOpenTarget(storagePath, originalName)) return storagePath
    const target = this.targetFor(fileId, originalName)
    await mkdir(this.directory, { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await copyFile(storagePath, temporary)
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return target
  }

  /** 启动时清理上一轮的外部打开副本（期间已打开的应用持有自己的文件句柄）。 */
  async cleanup(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }
}