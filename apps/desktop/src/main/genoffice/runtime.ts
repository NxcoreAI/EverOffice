import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

import { resolveGenOfficeRuntimeRoot } from '../runtime/genoffice-root'

/**
 * GenOffice 原生编辑器运行时的宿主接口（类型裁剪自 EverOffice apps/desktop 的
 * office-runtime.ts；运行时本体是 EverOffice build/genoffice-runtime 的产物，
 * 由 prepare-genoffice-runtime.mjs 从 Apache-2.0 fork 固定构建）。
 */
export interface GenOfficeDocsRuntime {
  configureDocsRuntime(config: { preloadPath: string; rendererFile: string }): void
  createDocsView(
    openPath?: string,
    options?: {
    },
  ): WebContentsView
  registerDocsIpc(): void
  requestDocsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  docsQueryDirty(contents: WebContents): Promise<boolean>
  setActiveDocsResolver(resolve: (() => WebContents | null) | null): void
  setDocsShellWindow(window: BrowserWindow | null): void
  teardownDocsRenderer(contents: WebContents): void
}

export interface GenOfficeSheetsRuntime {
  configureSheetsRuntime(config: {
    preloadPath: string
    rendererFile: string
    sidecarPath: string
  }): void
  createSheetsView(options?: {
  }): WebContentsView
  queueWorkbookForView(contents: WebContents, path: string): void
  registerSheetsIpc(): void
  requestSheetsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSheetsWebContents(contents: WebContents | null): void
  setSheetsShellWindow(window: BrowserWindow | null): void
  stopSheetsSidecar(): void
}

export interface GenOfficeSlidesRuntime {
  configureSlidesRuntime(config: { preloadPath: string; rendererFilePath?: string }): void
  createSlidesView(
    openPath?: string | null,
    options?: { readonly?: boolean },
  ): WebContentsView
  registerSlidesIpc(): void
  requestSlidesClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSlidesWebContents(contents: WebContents | null): void
  setSlidesShellWindow(window: BrowserWindow | null): void
  slidesIsDirty(webContentsId: number): boolean
}

export interface GenOfficePdfRuntime {
  configurePdfRuntime(config: { preloadPath: string; rendererFile?: string }): void
  createPdfView(
    openPath?: string | null,
    options?: { readonly?: boolean },
  ): WebContentsView
  registerPdfIpc(): void
  pdfIsDirty(webContentsId: number): boolean
}

export interface PreparedGenOfficeRuntime {
  docs: GenOfficeDocsRuntime
  sheets: GenOfficeSheetsRuntime
  slides: GenOfficeSlidesRuntime
  pdf: GenOfficePdfRuntime
  root: string
}

/**
 * 运行时根目录：开发态读 apps/desktop/build/genoffice-runtime（prepare:genoffice 产物），
 * 打包态读 extraResources 落点 <app>/Contents/Resources/genoffice；GENOFFICE_RUNTIME_ROOT
 * 可显式覆盖（指向 EverOffice 的 build/genoffice-runtime）。
 */
function genOfficeRuntimeRoot(): string {
  return resolveGenOfficeRuntimeRoot({
    envRoot: process.env.GENOFFICE_RUNTIME_ROOT,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

let cached: PreparedGenOfficeRuntime | null = null

export function loadGenOfficeRuntime(): PreparedGenOfficeRuntime {
  if (cached) return cached
  const root = genOfficeRuntimeRoot()
  const docsMain = join(root, 'docs', 'main', 'embed.js')
  const docsPreload = join(root, 'docs', 'preload', 'index.js')
  const docsRenderer = join(root, 'docs', 'renderer', 'index.html')
  const sheetsMain = join(root, 'sheets', 'main', 'embed.js')
  const sheetsPreload = join(root, 'sheets', 'preload', 'index.js')
  const sheetsRenderer = join(root, 'sheets', 'renderer', 'index.html')
  const slidesMain = join(root, 'slides', 'main', 'embed.js')
  const slidesPreload = join(root, 'slides', 'preload', 'index.js')
  const slidesRenderer = join(root, 'slides', 'renderer', 'index.html')
  const pdfMain = join(root, 'pdf', 'main', 'embed.js')
  const pdfPreload = join(root, 'pdf', 'preload', 'index.js')
  const pdfRenderer = join(root, 'pdf', 'renderer', 'index.html')
  const sidecar = join(root, 'native', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
  for (const path of [
    docsMain, docsPreload, docsRenderer,
    sheetsMain, sheetsPreload, sheetsRenderer,
    slidesMain, slidesPreload, slidesRenderer,
    pdfMain, pdfPreload, pdfRenderer,
    sidecar,
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        app.isPackaged
          ? `GenOffice runtime 不完整（缺 ${path}）。安装包资源不完整，请重新安装 EverOffice；也可用 GENOFFICE_RUNTIME_ROOT 指向 EverOffice 的 build/genoffice-runtime。`
          : `GenOffice runtime 不完整（缺 ${path}）。可用 GENOFFICE_RUNTIME_ROOT 指向 EverOffice 的 build/genoffice-runtime。`,
      )
    }
  }

  // runtime 独立于本工程打包，必须经由它自己的入口 require，不进 electron-vite 依赖图。
  const docs = createRequire(docsMain)(docsMain) as GenOfficeDocsRuntime
  docs.configureDocsRuntime({ preloadPath: docsPreload, rendererFile: docsRenderer })
  const sheets = createRequire(sheetsMain)(sheetsMain) as GenOfficeSheetsRuntime
  sheets.configureSheetsRuntime({ preloadPath: sheetsPreload, rendererFile: sheetsRenderer, sidecarPath: sidecar })
  const slides = createRequire(slidesMain)(slidesMain) as GenOfficeSlidesRuntime
  slides.configureSlidesRuntime({ preloadPath: slidesPreload, rendererFilePath: slidesRenderer })
  const pdf = createRequire(pdfMain)(pdfMain) as GenOfficePdfRuntime
  pdf.configurePdfRuntime({ preloadPath: pdfPreload, rendererFile: pdfRenderer })

  cached = { docs, sheets, slides, pdf, root }
  return cached
}

export function genOfficeRuntimeAvailable(): boolean {
  try {
    loadGenOfficeRuntime()
    return true
  } catch {
    return false
  }
}
