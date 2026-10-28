import React, { useState } from 'react'
import { MoreHorizontal, Search, List, LayoutGrid, ChevronDown, X } from 'lucide-react'

import { type FileKind, type OfficeFile, kindMeta } from '../data'

/* ───────────── WPS 风格文件类型图标 ─────────────
   渐变圆角方块（squircle）+ 白色类型字母 + 顶部高光，
   配色与「新建」tiles 一致：W=文档 S=表格 P=演示，PDF / MD 小尺寸收成单字母。 */

const ftThemes: Record<FileKind, { from: string; to: string; letters: string }> = {
  docx: { from: '#4aa3ff', to: '#0a6fe8', letters: 'W' },
  xlsx: { from: '#4cc478', to: '#1f9450', letters: 'S' },
  pptx: { from: '#ffb340', to: '#ef7d0e', letters: 'P' },
  pdf: { from: '#ff6f61', to: '#e0362a', letters: 'PDF' },
  md: { from: '#b9bbc2', to: '#83868f', letters: 'MD' },
}

export function FileTypeIcon({ kind, size = 28 }: { kind: FileKind; size?: number }) {
  const th = ftThemes[kind]
  const gid = `ftg-${kind}`
  // 小尺寸（标签栏）下多字母会糊成一片，收成首字母靠颜色区分
  const letters = size < 24 && th.letters.length > 1 ? th.letters[0] : th.letters
  const fs = letters.length > 1 ? 12.5 : 20
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="op-ft-icon">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={th.from} />
          <stop offset="1" stopColor={th.to} />
        </linearGradient>
        <linearGradient id={`${gid}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="11.5" fill={`url(#${gid})`} />
      <path d="M1.5 13 A11.5 11.5 0 0 1 13 1.5 H35 A11.5 11.5 0 0 1 46.5 13 V21 H1.5 Z" fill={`url(#${gid}-g)`} />
      <text
        x="24" y="25.5" textAnchor="middle" dominantBaseline="central"
        fill="#fff" fontWeight="800" fontSize={fs}
        letterSpacing={letters.length > 1 ? 0.8 : 0}
        fontFamily="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
      >
        {letters}
      </text>
    </svg>
  )
}

/** 文件行（表格式单行）：图标 + 文件名 + 修改时间 + 大小 + 悬停更多。 */
export function FileRow({
  file, onOpen, onMore,
}: {
  file: OfficeFile
  onOpen: () => void
  onMore?: () => void
}) {
  return (
    <div
      className="op-file-grid op-file-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <FileTypeIcon kind={file.kind} size={36} />
      <span className="op-file-name">{file.name}</span>
      <span className="op-file-time">{file.updatedLabel}</span>
      <span className="op-file-size">{file.sizeLabel}</span>
      {onMore && (
        <button
          className="op-file-more"
          type="button"
          title="更多操作"
          onClick={(e) => { e.stopPropagation(); onMore() }}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    </div>
  )
}

/** 文件列表卡（WPS 式）：搜索框 + 视图切换 + 类型筛选标签 + 表头 + 单行行。 */
export function FileTable({
  files, onOpenFile, onToast,
}: {
  files: OfficeFile[]
  onOpenFile: (f: OfficeFile) => void
  onToast?: (msg: string) => void
}) {
  const [kindFilter, setKindFilter] = useState<FileKind | 'all'>('all')
  const [q, setQ] = useState('')

  const shown = files.filter((f) => {
    if (kindFilter !== 'all' && f.kind !== kindFilter) return false
    if (q && !f.name.toLowerCase().includes(q.trim().toLowerCase())) return false
    return true
  })

  const tabs: { key: FileKind | 'all'; label: string }[] = [
    { key: 'all', label: '全部' },
    ...(['docx', 'xlsx', 'pptx', 'pdf', 'md'] as FileKind[]).map(
      (k) => ({ key: k, label: kindMeta[k].label }),
    ),
  ]

  return (
    <div className="op-file-list">
      <div className="op-ft-bar">
        <Seg items={tabs} value={kindFilter} onChange={setKindFilter} />
        <div className="op-ft-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名…" />
          {q && (
            <button className="op-ft-search-clear" type="button" title="清空" onClick={() => setQ('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="op-ft-views">
          <button className="active" type="button" title="列表视图"><List size={15} /></button>
          <button
            type="button"
            title="网格视图"
            onClick={() => onToast?.('网格视图（原型暂未开放）')}
          >
            <LayoutGrid size={15} />
          </button>
        </div>
      </div>

      <div className="op-file-grid op-file-head">
        <span />
        <span>文件名</span>
        <span className="op-file-sort">修改时间 <ChevronDown size={11} /></span>
        <span>大小</span>
        <span />
      </div>

      {shown.map((f) => (
        <FileRow
          key={f.id}
          file={f}
          onOpen={() => onOpenFile(f)}
          onMore={onToast ? () => onToast('文件菜单：重命名 / 移动 / 分享（原型）') : undefined}
        />
      ))}
      {shown.length === 0 && <div className="op-empty">没有匹配的文件</div>}
    </div>
  )
}

export function PageHead({
  title, hint, children,
}: {
  title: string
  hint?: string
  children?: React.ReactNode
}) {
  return (
    <header className="op-page-head">
      <div className="op-page-head-text">
        <h1>{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
      {children && <div className="op-page-head-actions">{children}</div>}
    </header>
  )
}

/** 页内标签栏（类型筛选 / Agent 六标签 / 连接器分类共用，样式统一）。 */
export function Seg<T extends string>({
  items, value, onChange,
}: {
  items: { key: T; label: string }[]
  value: T
  onChange: (k: T) => void
}) {
  return (
    <div className="op-seg" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={value === it.key}
          className={`op-seg-btn${value === it.key ? ' active' : ''}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
