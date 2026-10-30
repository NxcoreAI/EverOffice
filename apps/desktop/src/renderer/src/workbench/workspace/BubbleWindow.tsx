import {
  ChevronLeft,
  FolderOpen,
  Maximize2,
  Minus,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react'
import React, { useMemo, useRef, useState } from 'react'

import { EditorView } from '@/office-proto/EditorView'
import type { OfficeFile, RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'
import { cn } from '../ui/cn'
import { Hint, IconButton, Spinner } from '../ui/primitives'
import { filterLibraryFiles, isArtifactFile } from './fileBrowser'
import { useFileLibrary } from './useFileLibrary'
import { BUBBLE_DEFAULT_WIDTH, type BubbleState } from './useBubble'
import './bubble.css'

/**
 * 工作空间右侧文件气泡窗：参与 flex 布局挤压内容栏、内部多文件标签、可拖宽。
 *
 * 两种内容态：
 * - 「资料与文件」浏览态（activeFileId === null）：列出文件库，点文件在气泡内打开；
 * - 文档态：只挂载激活文件的编辑器。
 *
 * 原生编辑器（WebContentsView）永远盖在 DOM 之上：切文件/切浏览态时旧宿主卸载 → 矩形归零 →
 * 主进程隐藏旧实例；同时分发一次 resize 事件让新宿主立刻重报矩形，避免迟到的 ZERO 把新实例也藏掉。
 */
export function BubbleWindow({
  bubble, closing = false, minimizing = false, onResize, onMinimize, onToggleMax, onRestore, onClose,
  onActivateFile, onCloseFile, onBrowse, onOpenFile, onToast,
}: {
  bubble: BubbleState
  /** 关闭退场动画中：DOM 保留但禁用交互，动画结束后由宿主卸载。 */
  closing?: boolean
  /** 收起（最小化）退场动画中：面板先收拢，再切成右缘把手。 */
  minimizing?: boolean
  onResize: (width: number) => void
  onMinimize: () => void
  onToggleMax: () => void
  onRestore: () => void
  onClose: () => void
  onActivateFile: (fileId: string) => void
  onCloseFile: (fileId: string) => void
  /** 切到「资料与文件」浏览态（activeFileId=null 的推导由 host 负责）。 */
  onBrowse: () => void
  /** 从浏览列表里打开文件（加进气泡标签并切到文档态）。 */
  onOpenFile: (file: OfficeFile) => void
  onToast: (message: string) => void
}) {
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)

  const startResize = (event: React.PointerEvent) => {
    if (bubble.maximized) return
    event.preventDefault()
    resizingRef.current = true
    setResizing(true)
    const startX = event.clientX
    const startWidth = bubble.width
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX)
      onResize(next)
    }
    const onUp = () => {
      resizingRef.current = false
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // 拖拽期间原生宿主被 CSS 隐藏；结束后让 host 重新上报矩形。
      window.setTimeout(() => window.dispatchEvent(new Event('resize')), 40)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activate = (fileId: string) => {
    onActivateFile(fileId)
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
  }

  const browse = () => {
    onBrowse()
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
  }

  if (bubble.mode === 'minimized') {
    const count = bubble.files.length
    return (
      <Hint label={count > 0 ? `展开资料与文件（${count} 个文件）` : '展开资料与文件'} side="left">
        <button type="button" className="wb-bubble-handle" onClick={onRestore} aria-label="展开资料与文件">
          <ChevronLeft size={13} />
          {count > 0 ? <span className="wb-bubble-handle-count">{count}</span> : null}
        </button>
      </Hint>
    )
  }

  const browsing = bubble.activeFileId === null
  const active = bubble.files.find((file) => file.id === bubble.activeFileId) ?? null

  return (
    <section
      className={cn(
        'wb-bubble',
        bubble.maximized && 'is-maximized',
        resizing && 'is-resizing',
        closing && 'is-closing',
        minimizing && 'is-minimizing',
      )}
      style={bubble.maximized ? undefined : { width: bubble.width || BUBBLE_DEFAULT_WIDTH }}
      aria-label="资料与文件"
    >
      {!bubble.maximized ? (
        <div
          className="wb-bubble-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整气泡窗宽度"
          onPointerDown={startResize}
        />
      ) : null}

      <div className="wb-bubble-head">
        <Hint label={browsing ? '当前正在浏览文件库' : '浏览资料与文件'}>
          <IconButton
            label="浏览资料与文件"
            size="sm"
            icon={<FolderOpen size={14} />}
            active={browsing}
            aria-expanded={browsing}
            onClick={browse}
          />
        </Hint>
        <div className="wb-bubble-tabs" role="tablist" aria-label="气泡窗文件">
          {bubble.files.map((file) => (
            <div
              key={file.id}
              role="tab"
              aria-selected={file.id === active?.id}
              tabIndex={0}
              className={cn('wb-bubble-tab', file.id === active?.id && 'is-active')}
              title={file.name}
              onClick={() => activate(file.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activate(file.id)
                }
              }}
            >
              <FileTypeIcon kind={file.kind} size={15} />
              <span className="wb-bubble-tab-name">{file.name}</span>
              <button
                type="button"
                className="wb-bubble-tab-close"
                title="关闭文件"
                aria-label={`关闭 ${file.name}`}
                onClick={(event) => { event.stopPropagation(); onCloseFile(file.id) }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="wb-bubble-ctl">
          <Hint label="收起">
            <IconButton label="收起" size="sm" icon={<Minus size={13} />} onClick={onMinimize} />
          </Hint>
          <IconButton
            label={bubble.maximized ? '还原' : '最大化'}
            size="sm"
            icon={<Maximize2 size={12} />}
            onClick={onToggleMax}
          />
          <Hint label="关闭">
            <IconButton label="关闭" size="sm" tone="danger" icon={<X size={13} />} onClick={onClose} />
          </Hint>
        </div>
      </div>

      <div className="wb-bubble-body">
        {browsing ? (
          <BubbleBrowser onOpenFile={onOpenFile} onToast={onToast} />
        ) : active ? (
          <div className="wb-bubble-doc" key={active.id}>
            <EditorView file={active} onToast={onToast} hideSideDock />
          </div>
        ) : (
          <div className="wb-bubble-empty">还没有打开文件</div>
        )}
      </div>
    </section>
  )
}

/* ───────────────── 气泡内的「资料与文件」列表 ───────────────── */

type BrowserScope = 'all' | 'material' | 'output'

const SCOPES: ReadonlyArray<{ key: BrowserScope; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'material', label: '资料' },
  { key: 'output', label: '产物' },
]

/**
 * 窄面板里的文件库列表：搜索 + 资料/产物筛选 + 点开即进气泡标签。
 * 文件库是全局的（后端没有 workspace 归属列），这里不伪造空间过滤，只在文案上如实说明。
 */
function BubbleBrowser({ onOpenFile, onToast }: {
  onOpenFile: (file: OfficeFile) => void
  onToast: (message: string) => void
}) {
  const library = useFileLibrary()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<BrowserScope>('all')

  const searched = useMemo(
    () => filterLibraryFiles(library.items, query, 'all'),
    [library.items, query],
  )
  const items = useMemo(() => {
    if (scope === 'all') return searched
    return searched.filter((item) => isArtifactFile(item) === (scope === 'output'))
  }, [scope, searched])

  const counts = useMemo(() => ({
    all: searched.length,
    material: searched.filter((item) => !isArtifactFile(item)).length,
    output: searched.filter((item) => isArtifactFile(item)).length,
  }), [searched])

  const importFiles = () => {
    void library.importFiles().then((summary) => {
      if (!summary) {
        onToast('桌面端文件库未就绪')
        return
      }
      if (summary.kind === 'cancelled') return
      const parts = [
        summary.imported ? `导入 ${summary.imported} 个` : null,
        summary.failed ? `失败 ${summary.failed} 个` : null,
        summary.skipped ? `跳过 ${summary.skipped} 个` : null,
      ].filter(Boolean)
      onToast(parts.length ? parts.join(' · ') : '没有可导入的文件')
    }).catch((error: unknown) => {
      onToast(error instanceof Error ? error.message : '导入失败')
    })
  }

  return (
    <div className="wb-bubble-browser">
      <div className="wb-bubble-browser-head">
        <label className="wb-bubble-browser-search">
          <Search size={13} aria-hidden="true" />
          <input
            className="ui-input"
            type="search"
            value={query}
            placeholder="搜索文件"
            aria-label="搜索资料与文件"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Hint label="刷新文件库">
          <IconButton
            label="刷新文件库"
            size="sm"
            icon={<RefreshCw size={13} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
          />
        </Hint>
        <Hint label={library.importing ? '正在导入…' : '导入文件'}>
          <IconButton
            label="导入文件"
            size="sm"
            icon={<Upload size={13} />}
            disabled={library.importing}
            onClick={importFiles}
          />
        </Hint>
      </div>

      <div className="wb-bubble-browser-scopes" role="group" aria-label="资料类型">
        {SCOPES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={scope === item.key}
            className={cn('wb-bubble-scope', scope === item.key && 'is-active')}
            onClick={() => setScope(item.key)}
          >
            {item.label}
            <span>{counts[item.key]}</span>
          </button>
        ))}
      </div>

      <div className="wb-bubble-browser-list" role="list">
        {library.state === 'loading' ? (
          <div className="wb-bubble-browser-state"><Spinner size={13} /> 正在读取文件库…</div>
        ) : null}
        {library.state === 'unavailable' ? (
          <div className="wb-bubble-browser-state">
            文件库暂不可用
            <span>桌面端文件服务未就绪，稍后重试。</span>
          </div>
        ) : null}
        {library.state === 'ready' && items.length === 0 ? (
          <div className="wb-bubble-browser-state">
            没有匹配的文件
            <span>换个关键词或类型，或点右上角「导入」。</span>
          </div>
        ) : null}
        {library.state === 'ready' ? items.map((item) => (
          <BubbleBrowserRow key={item.file.id} item={item} onOpen={onOpenFile} />
        )) : null}
      </div>

      {library.state === 'ready' && library.total > library.items.length ? (
        <div className="wb-bubble-browser-note">
          仅加载最近 {library.items.length} 个文件（文件库共 {library.total} 个）
        </div>
      ) : (
        <div className="wb-bubble-browser-note">文件库为全局库，不按工作空间隔离</div>
      )}
    </div>
  )
}

function BubbleBrowserRow({ item, onOpen }: { item: RealOfficeFile; onOpen: (file: OfficeFile) => void }) {
  const meta = [item.catalog.sourceLabel, item.file.updatedLabel, item.file.sizeLabel]
    .filter((part) => part && part !== '—')
    .join(' · ')
  return (
    <button
      type="button"
      role="listitem"
      className="wb-bubble-browser-row"
      title={item.file.name}
      onClick={() => onOpen(item.file)}
    >
      <FileTypeIcon kind={item.file.kind} size={24} />
      <span className="wb-bubble-browser-row-main">
        <span className="wb-bubble-browser-row-name">{item.file.name}</span>
        <span className="wb-bubble-browser-row-meta">{meta}</span>
      </span>
    </button>
  )
}
