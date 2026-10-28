import React, { useEffect, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'

import {
  type Connector, connectorCategories, connectors,
} from '../data'
import { BrandMark } from '../brandLogos'
import { PageHead, Seg } from './parts'

export function ConnectorsView({ onToast }: { onToast: (msg: string) => void }) {
  const [items, setItems] = useState(connectors)
  const [cat, setCat] = useState<string>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const shown = cat === 'all' ? items : items.filter((c) => c.category === cat)
  const cur = items.find((c) => c.id === openId)

  // Esc 关闭抽屉
  useEffect(() => {
    if (!openId) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [openId])

  const toggle = (c: Connector) => {
    setItems((prev) => prev.map((x) => (
      x.id === c.id
        ? { ...x, connected: !x.connected, lastSyncLabel: x.connected ? undefined : '刚刚' }
        : x
    )))
    onToast(c.connected ? `已断开「${c.name}」` : `「${c.name}」已连接`)
  }

  const filters = [
    { key: 'all', label: '全部' },
    ...connectorCategories.map((c) => ({ key: c, label: c })),
  ]

  return (
    <>
      <PageHead title="连接器" hint={`连接后，Agent 可读取这些来源并写入记忆 · 已连接 ${items.filter((c) => c.connected).length}/${items.length}`} />

      <Seg items={filters} value={cat} onChange={setCat} />

      <div className="op-conn-grid">
        {shown.map((c) => (
          <button key={c.id} type="button" className="op-conn-card" onClick={() => setOpenId(c.id)}>
            <span className="op-conn-tile"><BrandMark slug={c.slug} color={c.color} size={28} /></span>
            <span className="op-conn-info">
              <span className="op-conn-name">{c.name}</span>
              <span className="op-conn-desc">{c.desc}</span>
            </span>
            <span
              className={`op-conn-state${c.connected ? ' on' : ''}`}
              title={c.connected ? `已连接 · 上次同步 ${c.lastSyncLabel ?? '—'}` : '未连接'}
            >
              {c.connected ? <Check size={14} /> : <Plus size={14} />}
            </span>
          </button>
        ))}
        {shown.length === 0 && <div className="op-empty">该分类下没有连接器</div>}
      </div>

      {cur && (
        <>
          <div className="op-drawer-mask" onClick={() => setOpenId(null)} />
          <aside className="op-drawer" aria-label={`${cur.name} 详情`}>
            <button className="op-drawer-close" type="button" onClick={() => setOpenId(null)} aria-label="关闭">
              <X size={14} />
            </button>
            <div className="op-drawer-hero">
              <span className="op-conn-tile lg"><BrandMark slug={cur.slug} color={cur.color} size={32} /></span>
              <div>
                <div className="op-drawer-name">{cur.name}</div>
                <div className="op-drawer-cat">{cur.category}</div>
              </div>
            </div>
            <p className="op-drawer-desc">{cur.desc}</p>
            <div className="op-drawer-block">
              <div className="op-drawer-label">权限范围</div>
              <div className="op-chips">
                {cur.scopes.map((s) => <span key={s} className="op-chip">{s}</span>)}
              </div>
            </div>
            <div className="op-drawer-block">
              <div className="op-drawer-label">状态</div>
              <div className="op-drawer-status">
                <i className={`op-dot${cur.connected ? ' on' : ''}`} />
                {cur.connected ? `已连接 · 上次同步 ${cur.lastSyncLabel ?? '—'}` : '未连接'}
              </div>
            </div>
            <button
              type="button"
              className={cur.connected ? 'op-danger-btn' : 'op-primary-btn'}
              onClick={() => toggle(cur)}
            >
              {cur.connected ? '断开连接' : '连接'}
            </button>
          </aside>
        </>
      )}
    </>
  )
}
