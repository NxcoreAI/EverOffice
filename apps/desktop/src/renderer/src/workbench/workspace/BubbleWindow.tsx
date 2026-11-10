import {
  FolderOpen,
  Maximize2,
  Minimize2,
  Minus,
  X,
} from 'lucide-react'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { EditorView } from '@/office-proto/EditorView'
import type { OfficeFile, RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'
import { FileOpenWithControl } from '@/components/files/FileOpenWithControl'
import { cn } from '../ui/cn'
import { Hint, IconButton, Spinner } from '../ui/primitives'
import { isArtifactFile } from './fileBrowser'
import { useFileLibrary } from './useFileLibrary'
import {
  BUBBLE_DEFAULT_WIDTH,
  resolveBubbleDrag,
  resolveBubbleGeometry,
} from './bubbleGeometry'
import type { BubbleExitKind, BubbleState } from './useBubble'

import './bubble.css'

/**
 * 工作空间右侧文件气泡窗：参与 flex 布局挤压内容栏、内部多文件标签、可拖宽。
 *
 * 两种内容态：
 * - 「资料与文件」浏览态（activeFileId === null）：列出文件库，点文件在气泡内打开；
 * - 文档态：只挂载激活文件的编辑器。
 *
 * 最大化态切到绝对定位覆盖层铺满整个工作区，对话区在其下整块隐藏（wb-ws 的
 * has-max-bubble），还原时回到停靠宽度。
 *
 * 拖宽：左缘把手能把面板拖到「铺满整个工作区」——越过对话区保底宽度后进入 cover 档，
 * 对话区让位到 0、面板去掉停靠留白与卡片描边，视觉上等同最大化覆盖层；反向拖回
 * 恢复常规停靠分栏。渲染宽度按容器实测宽度收敛（窗口变窄/变宽后拖拽也不会跳）。
 *
 * 原生编辑器（WebContentsView）永远盖在 DOM 之上：切文件/切浏览态时旧宿主卸载 → 矩形归零 →
 * 主进程隐藏旧实例；同时分发一次 resize 事件让新宿主立刻重报矩形，避免迟到的 ZERO 把新实例也藏掉。
 */
export function BubbleWindow({
  bubble, exiting = null, onResize, onMinimize, onToggleMax, onClose,
  onActivateFile, onCloseFile, onBrowse, onOpenFile, onToast, workspaceId, onFullChange,
}: {
  bubble: BubbleState
  /** 退场动画中：DOM 保留但禁用交互，动画结束后由宿主卸载（'close' 关闭 / 'minimize' 收起）。 */
  exiting?: BubbleExitKind | null
  onResize: (width: number, cover?: boolean) => void
  onMinimize: () => void
  onToggleMax: () => void
  onClose: () => void
  onActivateFile: (fileId: string) => void
  onCloseFile: (fileId: string) => void
  /** 切到「资料与文件」浏览态（activeFileId=null 的推导由 host 负责）。 */
  onBrowse: () => void
  /** 从浏览列表里打开文件（加进气泡标签并切到文档态）。 */
  onOpenFile: (file: OfficeFile) => void
  onToast: (message: string) => void
  /** 浏览列表按工作空间过滤（资料库/产物库独立）。 */
  workspaceId?: string
  /**
   * 是否已经铺满整个工作区（铺满态视觉等同最大化覆盖层）。
   * 宿主据此把对话区 visibility 关掉，避免键盘/读屏还能 Tab 进宽度为 0 的不可见控件。
   */
  onFullChange?: (full: boolean) => void
}) {
  const { t } = useLocale()
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  /**
   * 内层内容冻结宽度：
   * 面板宽度动画（展开/收起/关闭）期间，如果让内部列表跟着逐帧重排，文字会不断换行，看起来在抖。
   * 这里在动画期间把内层固定成动画开始时的宽度、由外层 overflow 裁剪，文字不再重排，只做平移/裁剪。
   */
  const sectionRef = useRef<HTMLElement>(null)
  const [freezeWidth, setFreezeWidth] = useState<number | null>(null)

  /**
   * 工作区可用宽度（section 的父级 .wb-ws）：拖宽上限、铺满宽度都由它决定。
   * 窗口变窄/变宽、侧栏收展都会改它，实测后重算渲染宽度，记忆宽度不跟着跳。
   */
  const [containerWidth, setContainerWidth] = useState(0)
  /**
   * 容器刚在变化（拖窗口 / 侧栏收展）：这段时间里渲染宽度是被动重排，必须关掉
   * 240ms 宽度过渡，否则面板会缓动追着窗口走（橡皮筋）。用状态而不是 rAF 改 style：
   * 连续 resize 期间一直保持，稳定一小会儿后再交还给 CSS 过渡。
   */
  const [containerAdjusting, setContainerAdjusting] = useState(false)
  useLayoutEffect(() => {
    const container = sectionRef.current?.parentElement
    if (!container) return undefined
    const measure = () => {
      setContainerWidth(container.clientWidth)
      setContainerAdjusting(true)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!containerAdjusting) return undefined
    // 容器尺寸稳定 140ms 后恢复 CSS 过渡（交互式 resize 期间会不断重新计时）。
    const timer = window.setTimeout(() => setContainerAdjusting(false), 140)
    return () => window.clearTimeout(timer)
  }, [containerAdjusting, containerWidth])

  // 渲染宽度 = 记忆宽度按容器收敛；cover 档位下允许继续长到铺满整个工作区。
  const geometry = resolveBubbleGeometry({
    width: bubble.width || BUBBLE_DEFAULT_WIDTH,
    containerWidth,
    cover: bubble.cover,
  })

  // 铺满态视觉等同最大化覆盖层：通知宿主把对话区 visibility 关掉。
  // 只把对话区压到 width 0 挡不住键盘 Tab / 读屏，visibility:hidden 才能让出无障碍树。
  useEffect(() => {
    onFullChange?.(!bubble.maximized && geometry.full)
    return () => onFullChange?.(false)
  }, [bubble.maximized, geometry.full, onFullChange])

  /** 最新几何：冻结宽度要取「当前实际渲染宽度」，但冻结时机只跟面板自身宽度变化走。 */
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry

  // 退场：dock 态直接用已知宽度冻结（别量，能量到动画第一帧的中间值 → 内层会跳一下）；
  // 最大化覆盖层退场走整体淡出（宽度不可插值），内层保持 100% 宽，不需要冻结。
  // 依赖故意用 bubble.width（记忆宽度）而不是 geometry.width：窗口缩放时渲染宽度会被
  // 容器收敛，但那是「被动重新布局」，不该触发冻结（is-settling 会隐藏原生编辑器 280ms）。
  useLayoutEffect(() => {
    if (!exiting) return
    if (!bubble.maximized) {
      setFreezeWidth(geometryRef.current.width)
      return
    }
    setFreezeWidth(null)
  }, [exiting, bubble.maximized, bubble.width])

  // 宽度过渡（展开 / 还原 / 拖拽改宽）期间把内层冻结成「目标宽度」，
  // 面板只做裁剪动画，列表/文字不逐帧重排，避免动画中的抖动。
  // 最大化是绝对定位全屏覆盖（无宽度动画），解冻让内层跟随 100% 宽。
  // 同样只跟记忆宽度/容器「主动改宽」走，窗口缩放带来的容器收敛不冻结（见上）。
  useEffect(() => {
    if (exiting) return
    if (bubble.maximized) {
      setFreezeWidth(null)
      return
    }
    setFreezeWidth(geometryRef.current.width)
    const timer = window.setTimeout(() => setFreezeWidth(null), 280)
    return () => window.clearTimeout(timer)
    // 依赖只用记忆宽度与最大化/退场：容器缩放是被动重排，不触发冻结。
  }, [exiting, bubble.maximized, bubble.width])

  const startResize = (event: React.PointerEvent) => {
    if (bubble.maximized) return
    event.preventDefault()
    resizingRef.current = true
    setResizing(true)
    const startX = event.clientX
    /**
     * 拖拽起点必须用「实测渲染宽度」而不是状态里的记忆宽度：窗口被拖窄/拖宽后
     * 面板实际宽度已被容器收敛，从记忆宽度起算会在第一次 pointermove 时跳一下。
     */
    const measured = sectionRef.current?.getBoundingClientRect().width ?? 0
    const startWidth = measured > 0 ? measured : geometry.width
    const drag = (deltaX: number) => resolveBubbleDrag({
      startWidth,
      deltaX,
      softMax: geometry.softMax,
      coverWidth: geometry.coverWidth,
    })
    const onMove = (moveEvent: PointerEvent) => {
      // deltaX 以「向右为正」：向左拖 deltaX 为负，面板变宽。
      const next = drag(moveEvent.clientX - startX)
      onResize(next.width, next.cover)
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

  const browsing = bubble.activeFileId === null
  const active = bubble.files.find((file) => file.id === bubble.activeFileId) ?? null

  return (
    <section
      ref={sectionRef}
      className={cn(
        'wb-bubble',
        bubble.maximized && 'is-maximized',
        resizing && 'is-resizing',
        // 拖过对话区保底宽度后：对话区继续让位；铺满时去掉停靠留白与卡片描边，
        // 视觉上与最大化覆盖层一致（但仍是停靠态，左缘把手可以再拖回来）。
        !bubble.maximized && geometry.covering && 'is-covering',
        !bubble.maximized && geometry.full && 'is-full-cover',
        // 宽度过渡（入场/最大化/还原）期间的原生区由 CSS 隐藏：native view 跟随 IPC
        // 重定位会滞后，否则会短暂画到对话区上（视口遮挡）。
        freezeWidth !== null && 'is-settling',
        exiting === 'close' && 'is-closing',
        exiting === 'minimize' && 'is-minimizing',
      )}
      // 宽度按容器实测值收敛（不用 CSS max-width：铺满态要能长到容器宽度，且窗口
      // 变化后渲染宽度必须跟着重算，否则拖拽起点会比实际宽、第一次拖动跳一下）。
      style={bubble.maximized
        ? undefined
        : {
            width: geometry.width,
            ...(containerAdjusting || containerWidth <= 0 ? { transition: 'none' } : null),
          }}
      aria-label={t('workbench:workspace.bubble.title')}
    >
      {!bubble.maximized ? (
        <div
          className="wb-bubble-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workbench:workspace.bubble.resize')}
          onPointerDown={startResize}
        />
      ) : null}

      <div
        className="wb-bubble-inner"
        style={freezeWidth ? { width: freezeWidth } : undefined}
      >
      <div className="wb-bubble-head">
        <Hint label={browsing
          ? t('workbench:workspace.bubble.browsingNow')
          : t('workbench:workspace.bubble.browse')}
        >
          <IconButton
            label={t('workbench:workspace.bubble.browse')}
            size="sm"
            icon={<FolderOpen size={14} />}
            active={browsing}
            aria-expanded={browsing}
            onClick={browse}
          />
        </Hint>
        <div className="wb-bubble-tabs" role="tablist" aria-label={t('workbench:workspace.bubble.tabs')}>
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
                title={t('workbench:workspace.bubble.closeFile')}
                aria-label={t('workbench:workspace.bubble.closeFileNamed', { name: file.name })}
                onClick={(event) => { event.stopPropagation(); onCloseFile(file.id) }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        {!browsing && active?.realCatalog ? (
          <FileOpenWithControl
            fileId={active.realCatalog.id}
            fileName={active.name}
            compact
            className="wb-bubble-open-with"
          />
        ) : null}
        <div className="wb-bubble-ctl">
          <Hint label={t('workbench:workspace.bubble.minimize')}>
            <IconButton
              label={t('workbench:workspace.bubble.minimize')}
              size="sm"
              icon={<Minus size={13} />}
              onClick={onMinimize}
            />
          </Hint>
          <Hint label={bubble.maximized
            ? t('workbench:workspace.bubble.restore')
            : t('workbench:workspace.bubble.maximize')}
          >
            <IconButton
              label={bubble.maximized
                ? t('workbench:workspace.bubble.restore')
                : t('workbench:workspace.bubble.maximize')}
              size="sm"
              icon={bubble.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              onClick={onToggleMax}
            />
          </Hint>
          <Hint label={t('workbench:workspace.bubble.close')}>
            <IconButton
              label={t('workbench:workspace.bubble.close')}
              size="sm"
              tone="danger"
              icon={<X size={13} />}
              onClick={onClose}
            />
          </Hint>
        </div>
      </div>

      <div className="wb-bubble-body">
        {browsing ? (
          <BubbleBrowser onOpenFile={onOpenFile} workspaceId={workspaceId} />
        ) : active ? (
          <div className="wb-bubble-doc" key={active.id}>
            <EditorView file={active} onToast={onToast} hideSideDock />
          </div>
        ) : (
          <div className="wb-bubble-empty">{t('workbench:workspace.bubble.empty')}</div>
        )}
      </div>
      </div>
    </section>
  )
}

/* ───────────────── 气泡内的「资料与文件」列表 ───────────────── */

type BrowserScope = 'all' | 'material' | 'output'

const SCOPES: ReadonlyArray<{ key: BrowserScope; labelKey: string }> = [
  { key: 'all', labelKey: 'workbench:workspace.bubble.scope.all' },
  { key: 'material', labelKey: 'workbench:workspace.bubble.scope.material' },
  { key: 'output', labelKey: 'workbench:workspace.bubble.scope.output' },
]

/**
 * 窄面板里的文件库列表：资料/产物筛选 + 点开即进气泡标签。
 * workspaceId 传入时按工作空间过滤（资料库/产物库独立）；缺省拉全库。
 */
function BubbleBrowser({ onOpenFile, workspaceId }: {
  onOpenFile: (file: OfficeFile) => void
  workspaceId?: string
}) {
  const { t } = useLocale()
  const library = useFileLibrary(workspaceId)
  const [scope, setScope] = useState<BrowserScope>('all')

  const items = useMemo(() => {
    if (scope === 'all') return library.items
    return library.items.filter((item) => isArtifactFile(item) === (scope === 'output'))
  }, [library.items, scope])

  const counts = useMemo(() => ({
    all: library.items.length,
    material: library.items.filter((item) => !isArtifactFile(item)).length,
    output: library.items.filter((item) => isArtifactFile(item)).length,
  }), [library.items])

  return (
    <div className="wb-bubble-browser">
      <div className="wb-bubble-browser-scopes" role="group" aria-label={t('workbench:workspace.bubble.scopeLabel')}>
        {SCOPES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={scope === item.key}
            className={cn('wb-bubble-scope', scope === item.key && 'is-active')}
            onClick={() => setScope(item.key)}
          >
            {t(item.labelKey)}
            <span>{counts[item.key]}</span>
          </button>
        ))}
      </div>

      <div className="wb-bubble-browser-list" role="list">
        {library.state === 'loading' ? (
          <div className="wb-bubble-browser-state"><Spinner size={13} /></div>
        ) : null}
        {library.state === 'unavailable' ? (
          <div className="wb-bubble-browser-state">{t('workbench:workspace.common.filesUnavailable')}</div>
        ) : null}
        {library.state === 'ready' && items.length === 0 ? (
          <div className="wb-bubble-browser-state">{t('workbench:workspace.file.noMatches')}</div>
        ) : null}
        {library.state === 'ready' ? items.map((item) => (
          <BubbleBrowserRow key={item.file.id} item={item} onOpen={onOpenFile} />
        )) : null}
      </div>

      {library.state === 'ready' && library.total > library.items.length ? (
        <div className="wb-bubble-browser-note">
          {t('workbench:workspace.bubble.note', { shown: library.items.length, total: library.total })}
        </div>
      ) : null}
    </div>
  )
}

function BubbleBrowserRow({ item, onOpen }: { item: RealOfficeFile; onOpen: (file: OfficeFile) => void }) {
  const meta = [item.catalog.sourceLabel, item.file.updatedLabel, item.file.sizeLabel]
    .filter((part) => part && part !== '—')
    .join(' · ')
  return (
    <div role="listitem" className="wb-bubble-browser-row" title={item.file.name}>
      <button
        type="button"
        className="wb-bubble-browser-row-main"
        aria-label={`打开 ${item.file.name}`}
        onClick={() => onOpen(item.file)}
      >
        <FileTypeIcon kind={item.file.kind} size={24} />
        <span className="wb-bubble-browser-row-copy">
          <span className="wb-bubble-browser-row-name">{item.file.name}</span>
          <span className="wb-bubble-browser-row-meta">{meta}</span>
        </span>
      </button>
      <FileOpenWithControl fileId={item.catalog.id} fileName={item.file.name} compact />
    </div>
  )
}
