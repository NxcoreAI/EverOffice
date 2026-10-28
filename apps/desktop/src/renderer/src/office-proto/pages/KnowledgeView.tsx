import React, { useState } from 'react'
import { ChevronLeft, Plus } from 'lucide-react'

import {
  type OfficeFile, files, knowledgeBases, sourceMeta,
} from '../data'
import { PageHead } from './parts'

export function KnowledgeView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [kbId, setKbId] = useState<string | null>(null)
  const kb = knowledgeBases.find((k) => k.id === kbId)

  if (!kb) {
    return (
      <>
        <PageHead title="知识库" hint="把邮件、会议、网页与文档汇成可引用的记忆">
          <button
            className="op-primary-btn"
            type="button"
            onClick={() => onToast('新建知识库（原型占位）')}
          >
            <Plus size={13} /> 新建知识库
          </button>
        </PageHead>
        <div className="op-room-row">
          {knowledgeBases.map((k) => (
            <button key={k.id} type="button" className="op-room-card" onClick={() => setKbId(k.id)}>
              <span className="op-room-icon">{k.icon}</span>
              <span className="op-room-title">{k.title}</span>
              <span className="op-room-meta">{k.sources.length} 个来源 · 更新于 {k.updatedLabel}</span>
            </button>
          ))}
        </div>
      </>
    )
  }

  const docSources = kb.sources.filter((s) => s.fileId)
  const memoryTotal = docSources.reduce((sum, s) => {
    const f = files.find((x) => x.id === s.fileId)
    return sum + (f?.memoryCount ?? 0)
  }, 0)

  return (
    <>
      <div className="op-kb-back">
        <button type="button" onClick={() => setKbId(null)}>
          <ChevronLeft size={14} /> 返回知识库
        </button>
      </div>
      <PageHead title={`${kb.icon} ${kb.title}`} hint={`来源 ${kb.sources.length} · 文档 ${docSources.length} · 记忆 ${memoryTotal} 条`} />
      <div className="op-list-card">
        {kb.sources.map((s) => {
          const meta = sourceMeta[s.kind]
          return (
            <button
              key={s.id}
              type="button"
              className="op-src-row"
              onClick={() => {
                const f = s.fileId ? files.find((x) => x.id === s.fileId) : undefined
                if (f) onOpenFile(f)
                else onToast('该来源暂不支持预览（原型）')
              }}
            >
              <span className="op-mem-kind" style={{ color: meta.color, background: `${meta.color}14` }}>
                {meta.label}
              </span>
              <span className="op-src-title">{s.title}</span>
              <span className="op-src-time">{s.timeLabel}</span>
              <span className={`op-src-status${s.status === 'syncing' ? ' syncing' : ''}`}>
                {s.status === 'indexed' ? '已索引' : '同步中'}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}
