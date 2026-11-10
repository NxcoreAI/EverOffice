import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type { FileApplication } from '../../shared/sources'

/**
 * 系统文件关联（「打开方式」）查询与外部应用启动。
 *
 * macOS 用 osascript + JXA 直接问 LaunchServices：`URLsForApplicationsToOpenURL`
 * 拿到系统按优先级排好的全部打开应用，`URLForApplicationToOpenURL` 标出默认应用，
 * 并从 `.app` 图标渲染 32px PNG（data URL）给卡片/菜单直接用。这套查询与 DSH 的
 * 产物卡同源，因此列表中也会出现宿主应用自身（「默认」打开就是走系统关联）。
 *
 * Windows/Linux 暂不提供关联列表（界面据此隐藏外部打开入口），默认打开仍走
 * 各自的既有链路。查询结果按扩展名缓存：同一类型的多个文件共用一次探测，
 * 图标提取较慢（首次约 2s）但只发生一次。
 */

const execFileAsync = promisify(execFile)

const OSASCRIPT_PATH = '/usr/bin/osascript'
const OPEN_PATH = '/usr/bin/open'

const QUERY_TIMEOUT_MS = 20_000
const OPEN_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const CACHE_TTL_MS = 5 * 60_000

/** 一次原生命令的调用口（argv，不经过 shell；测试注入假实现）。 */
export type FileApplicationCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string }>

const defaultRunner: FileApplicationCommandRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, [...args], {
    timeout: options?.timeoutMs ?? QUERY_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })
  return { stdout }
}

/** 默认应用之外还带上 bundle id / 版本号，用于把同一应用的多个副本折叠成一个。 */
export interface NativeFileApplication extends FileApplication {
  bundle: string | null
  version: string | null
}

/**
 * JXA 脚本：路径从 argv 传入（绝不拼进脚本源码）。参数 1 = `icons` 时才渲染图标，
 * 启动校验只需要 handler 路径，可省掉一整轮图标提取。
 */
export const MAC_APPLICATIONS_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var image = null;
    if (argv[1] === 'icons') {
      var icon = workspace.iconForFile(path);
      var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      thumbnail.lockFocus;
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      thumbnail.unlockFocus;
      var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      image = png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    }
    var bundle = $.NSBundle.bundleWithURL(url);
    var bundleId = bundle.isNil() || bundle.bundleIdentifier.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: image,
      bundle: bundleId,
      version: version === null || version.isNil() ? null : String(ObjC.unwrap(version))
    });
  }
  return JSON.stringify(apps);
}
`

function textField(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Invalid native application entry')
  return value
}

/**
 * 校验 JXA 返回的应用列表：id/name 必须是非空字符串，default 是布尔，icon 是
 * PNG/SVG data URL 或 null。任何一条坏数据都整批拒绝（与 DSH 的严格解析一致），
 * 避免把半截条目渲染成不可点的菜单项。
 */
export function parseMacApplications(value: unknown): NativeFileApplication[] {
  if (!Array.isArray(value)) throw new Error('Invalid native application list')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid native application entry')
    const record = entry as Record<string, unknown>
    const id = textField(record.id)
    const name = textField(record.name)
    if (!id || !name) throw new Error('Invalid native application entry')
    if (typeof record.default !== 'boolean') throw new Error('Invalid native application entry')
    const icon = textField(record.icon)
    if (icon !== null && !/^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(icon)) {
      throw new Error('Invalid native application icon')
    }
    return {
      id,
      name,
      default: record.default,
      icon,
      bundle: textField(record.bundle),
      version: textField(record.version),
    }
  })
}

/** 按点分版本号数值比较；非数字段按 0，缺版本排最低。 */
export function compareVersions(left: string | null, right: string | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (Number(a[index]) || 0) - (Number(b[index]) || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * 折叠同一应用的重复注册：自更新应用会在磁盘上留下多份副本
 * （`.AppName.app.installing...`、按版本并存），LaunchServices 每一份都会登记，
 * 原样渲染菜单会出现一串同名项。与 Finder 一致：bundle id + 显示名相同的副本
 * 折成一项，优先系统默认、否则取最高版本，位置保持该组首次出现处。
 */
export function dedupeMacApplications(applications: readonly NativeFileApplication[]): NativeFileApplication[] {
  const order: NativeFileApplication[] = []
  const groups = new Map<string, number>()
  for (const application of applications) {
    if (application.bundle === null) {
      order.push(application)
      continue
    }
    const key = `${application.bundle}\u0000${application.name}`
    const index = groups.get(key)
    if (index === undefined) {
      groups.set(key, order.length)
      order.push(application)
      continue
    }
    const held = order[index]!
    if (held.default) continue
    if (application.default || compareVersions(application.version, held.version) > 0) {
      order[index] = application
    }
  }
  return order
}

/** 去掉仅供折叠用的元数据，得到可安全跨 IPC 的展示条目。 */
export function toFileApplications(applications: readonly NativeFileApplication[]): FileApplication[] {
  return applications.map(({ id, name, default: preferred, icon }) => ({
    id,
    name,
    default: preferred,
    icon,
  }))
}

function assertUsableFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('文件路径为空')
  if (!isAbsolute(filePath)) throw new Error('文件路径必须是绝对路径')
  if (!existsSync(filePath)) throw new Error('文件不存在或已被删除')
}

export interface FileApplicationsServiceOptions {
  platform?: NodeJS.Platform
  run?: FileApplicationCommandRunner
  cacheTtlMs?: number
  now?: () => number
}

export class FileApplicationsService {
  private readonly platform: NodeJS.Platform
  private readonly run: FileApplicationCommandRunner
  private readonly cacheTtlMs: number
  private readonly now: () => number
  /** 扩展名 → 最近一次探测结果（同一类型共用；空数组也缓存，避免反复撞失败）。 */
  private readonly cache = new Map<string, { expiresAt: number; applications: FileApplication[] }>()
  /** 同类型的并发探测合并成一次 osascript（多个卡片同时挂载时）。 */
  private readonly inflight = new Map<string, Promise<FileApplication[]>>()

  constructor(options: FileApplicationsServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? defaultRunner
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 列出该文件可用的外部应用（含默认应用与图标）。查询失败返回空数组
   * （界面隐藏外部打开入口），不向渲染层抛错——打开文件本身仍可继续。
   *
   * filePath 必须带原始扩展名：LaunchServices 按 UTI/扩展名判类型。对象库的
   * 无扩展名路径不能直接传进来，先经 OpenWithStaging 落成同名副本。
   */
  async applicationsFor(filePath: string): Promise<FileApplication[]> {
    if (this.platform !== 'darwin') return []
    assertUsableFilePath(filePath)
    const key = extname(filePath).toLowerCase() || '*'
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.applications
    const pending = this.inflight.get(key)
    if (pending) return pending
    const loading = this.load(filePath)
      .then((applications) => {
        this.cache.set(key, { expiresAt: this.now() + this.cacheTtlMs, applications })
        return applications
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, loading)
    return loading
  }

  /**
   * 用外部应用打开文件：applicationId 省略 = 系统默认应用；否则必须是本轮
   * 系统报告过、能打开该文件的应用路径（重新查一遍 handler，拒绝任意可执行文件）。
   */
  async openWith(filePath: string, applicationId?: string): Promise<'default' | 'application'> {
    assertUsableFilePath(filePath)
    if (this.platform !== 'darwin') throw new Error('当前系统暂不支持选择外部应用打开')
    if (!applicationId) {
      await this.run(OPEN_PATH, [filePath], { timeoutMs: OPEN_TIMEOUT_MS })
      return 'default'
    }
    if (!isAbsolute(applicationId)) throw new Error('应用标识不合法')
    const registered = await this.queryHandlers(filePath)
    if (!registered.some((application) => application.id === applicationId)) {
      throw new Error('该应用未注册打开此文件类型')
    }
    await this.run(OPEN_PATH, ['-a', applicationId, filePath], { timeoutMs: OPEN_TIMEOUT_MS })
    return 'application'
  }

  private async load(filePath: string): Promise<FileApplication[]> {
    try {
      const applications = await this.queryHandlers(filePath, true)
      const visible = toFileApplications(dedupeMacApplications(applications))
      console.info('[file-applications] 文件关联应用', extname(filePath).toLowerCase() || '(无扩展名)', visible.length)
      return visible
    } catch (error) {
      console.warn('[file-applications] 查询文件关联应用失败', filePath, error)
      return []
    }
  }

  private async queryHandlers(filePath: string, icons = false): Promise<NativeFileApplication[]> {
    const { stdout } = await this.run(OSASCRIPT_PATH, [
      '-l', 'JavaScript',
      '-e', MAC_APPLICATIONS_SCRIPT,
      filePath,
      icons ? 'icons' : 'handlers',
    ])
    return parseMacApplications(JSON.parse(stdout))
  }
}