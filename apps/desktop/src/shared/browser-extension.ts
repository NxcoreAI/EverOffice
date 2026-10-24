// 网页剪藏（浏览器扩展 → 网关）落库后的读取契约；扩展本体在 apps/browser-extension，桌面只消费剪藏结果。

export const CLIPPER_ASSET_SCHEME = 'nxcore-clipper-asset'

export interface BrowserExtensionClipperCapture {
  id: string
  fileEntryId: string | null
  fileVersionId: string | null
  sourceUrl: string
  canonicalUrl: string
  title: string
  author: string | null
  publishedAt: string | null
  capturedAt: string
  extractionMode: 'selection' | 'article' | 'full-page'
  status: 'storing' | 'assets_pending' | 'ready' | 'ready_with_missing_assets' | 'failed'
  assetCount: number
  storedAssetCount: number
  failedAssetCount: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  favoritedAt: string | null
  artifact: {
    schemaVersion: number
    excerpt: string
    coverAssetId: string | null
    coverUrl: string | null
    displayMarkdown?: string
  } | null
  understanding: {
    parse: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
    visual: 'pending' | 'processing' | 'ready' | 'partial' | 'skipped' | 'failed' | 'unavailable'
    memory: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
    entities: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
  }
  entities: Array<{
    id: string
    name: string
    kind: string
    status: string
    role: 'primary' | 'mention' | 'manual'
    salience: number
    evidence: string | null
  }>
  assets: Array<{
    id: string
    referenceKey: string
    originalUrl: string
    localUrl: string
    mime: string | null
    byteSize: number | null
    altText: string | null
    width: number | null
    height: number | null
    status: 'pending' | 'stored' | 'failed'
    errorCode: string | null
    visualStatus: 'pending' | 'processing' | 'ready' | 'skipped' | 'failed'
    visualKind: string | null
    visualSummary: string | null
    visualOcrText: string | null
    visualKeyPoints: string[]
    visualEntities: Array<{ name: string; kind: string; evidence: string }>
    visualRelevance: number | null
    visualQuality: number | null
    visualContentRole: 'primary' | 'supporting' | 'noise' | null
    visualNoiseReason: string | null
    coverScore: number | null
  }>
}

