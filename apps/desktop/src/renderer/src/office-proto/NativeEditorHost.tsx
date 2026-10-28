import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

/**
 * GenOffice 原生编辑器宿主。原生 WebContentsView 永远画在 DOM 之上，z-index
 * 管不了它，只能靠「矩形上报 + 显隐时序」对齐（时序规则取自 EverRoom 的
 * officeViewport.ts，原型去掉遮挡扫描）：
 * 1. 挂载后先 open 实例；宿主矩形非零时先 activate 再报矩形
 * 2. 宿主矩形归零（切标签/收面板）上报零尺寸隐藏
 * 3. ResizeObserver + 窗口 resize + 捕获阶段 scroll 全部重报
 */

export type NativeSpec =
  | { kind: 'docx'; blocks: Array<{ type: 'h1' | 'h2' | 'p' | 'quote'; text: string; cite?: { label: string; source: string } }> }
  | { kind: 'xlsx'; columns: string[]; rows: string[][] }
  | { kind: 'pptx'; slides: Array<{ title: string; bullets: string[] }> }
  | { kind: 'pdf'; paragraphs: string[] }

const ZERO = { x: 0, y: 0, width: 0, height: 0 }

export function NativeEditorHost({
  fileId, title, spec,
}: {
  fileId: string
  title: string
  spec: NativeSpec
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'opening' | 'ready' | 'error'>('opening')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('opening')
    void window.desktop?.office.open({ fileId, title, spec }).then((result) => {
      if (cancelled) return
      if (result.ok) setStatus('ready')
      else {
        setStatus('error')
        setError(result.error ?? '未知错误')
      }
    })
    return () => {
      cancelled = true
    }
    // 实例按 fileId 幂等打开；spec 来自静态 mock，不随渲染变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let visible = false
    let raf = 0

    const report = async () => {
      const rect = host.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        if (!visible) {
          visible = true
          await window.desktop?.office.activate(fileId)
        }
        window.desktop?.office.sendBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      } else if (visible) {
        visible = false
        window.desktop?.office.sendBounds(ZERO)
      }
    }

    const observer = new ResizeObserver(() => void report())
    const onResize = () => void report()
    const onScroll = () => void report()
    observer.observe(host)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    raf = requestAnimationFrame(() => requestAnimationFrame(() => void report()))

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      cancelAnimationFrame(raf)
      if (visible) window.desktop?.office.sendBounds(ZERO)
    }
  }, [fileId])

  return (
    <div className="op-native-wrap">
      <div className="op-native-host" ref={hostRef}>
        {status === 'opening' && (
          <div className="op-native-status"><Loader2 size={16} className="op-spin-icon" /> 正在启动 GenOffice 原生编辑器…</div>
        )}
        {status === 'error' && (
          <div className="op-native-status error">
            <AlertTriangle size={16} /> GenOffice 运行时不可用
            <div className="op-native-error-detail">{error}</div>
            <div className="op-native-error-hint">请确认 EverRoom 仓库已执行 prepare:genoffice，或设置 GENOFFICE_RUNTIME_ROOT 指向 genoffice-runtime 目录。</div>
          </div>
        )}
      </div>
    </div>
  )
}
