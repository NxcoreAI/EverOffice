import { ChevronRight, FileText, FolderOpen, Link2, Presentation, Table2 } from 'lucide-react'
import { useState } from 'react'

import { startDocFlow } from './docFlowRequest'

import './docflow.css'

export const DOC_TYPE_OPTIONS = [
  { id: 'report', label: '分析报告', ext: '.docx', active: true },
  { id: 'proposal', label: '项目立项书', ext: '.docx', active: true },
  { id: 'prd', label: 'PRD', ext: '.docx', active: true },
  { id: 'ppt', label: '汇报 PPT', ext: '.pptx', active: false },
  { id: 'sheet', label: '数据测算表', ext: '.xlsx', active: false },
] as const

const AUDIENCES = ['管理层', '项目组', '客户', '全员'] as const

export const DOC_FLOW_SOURCES = [
  { id: 's1', name: 'Q3 OKR 复盘.docx', kind: 'upload' as const, meta: '上传 · 2 天前 · 12 KB' },
  { id: 's2', name: '产品周报 7-9 月合集.pdf', kind: 'upload' as const, meta: '上传 · 上周 · 1.8 MB' },
  { id: 's3', name: '用户增长数据 2026Q3.xlsx', kind: 'upload' as const, meta: '上传 · 昨天 · 96 KB' },
  { id: 's4', name: '飞书 · 产品知识库', kind: 'feishu' as const, meta: '已连接 · 46 篇文档' },
  { id: 's5', name: '本地文件夹 · 数据月报', kind: 'local' as const, meta: '已连接 · 23 个文件' },
]

const KIND_ICON = { upload: FileText, feishu: Link2, local: FolderOpen } as const

/** 首页「你要做什么文件」任务卡：独立入口，不是侧边聊天框。 */
export function DocTaskCard({ onStart }: { onStart: () => void }) {
  const [brief, setBrief] = useState('给下周三的管理层会做一份 Q3 进展汇报，用我传的这几份材料')
  const [docType, setDocType] = useState<string>('report')
  const [audience, setAudience] = useState<string>('管理层')
  const [picked, setPicked] = useState<string[]>(['s1', 's2', 's3'])

  const togglePick = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const start = () => {
    startDocFlow({ brief: brief.trim(), docType, audience, sourceIds: picked })
    onStart()
  }

  return (
    <section className="df-task-card" data-testid="doc-task-card">
      <h2>你要做什么文件？</h2>
      <p className="df-task-sub">说清要什么、给谁看、用哪些资料 —— Agent 分步交活，直接拿到能交的文件。</p>

      <label className="df-field-label">要做什么</label>
      <textarea
        className="df-brief"
        value={brief}
        rows={2}
        onChange={(event) => setBrief(event.target.value)}
        placeholder="比如：给下周三的管理层会做一份 Q3 进展汇报，用我传的这几份材料"
      />

      <label className="df-field-label">交出来是什么</label>
      <div className="df-doc-types">
        {DOC_TYPE_OPTIONS.map((type) => (
          <button
            key={type.id}
            type="button"
            className="df-doc-type"
            data-active={type.active && docType === type.id}
            data-disabled={!type.active}
            onClick={() => type.active && setDocType(type.id)}
          >
            {type.id === 'ppt' ? <Presentation aria-hidden="true" /> : type.id === 'sheet' ? <Table2 aria-hidden="true" /> : <FileText aria-hidden="true" />}
            <span>{type.label}</span>
            <small>{type.active ? type.ext : '即将支持'}</small>
          </button>
        ))}
      </div>

      <label className="df-field-label">给谁看</label>
      <div className="df-chips">
        {AUDIENCES.map((item) => (
          <button key={item} type="button" className="df-chip" data-active={audience === item} onClick={() => setAudience(item)}>
            {item}
          </button>
        ))}
      </div>

      <label className="df-field-label">用哪些资料</label>
      <div className="df-sources">
        {DOC_FLOW_SOURCES.map((source) => {
          const Icon = KIND_ICON[source.kind]
          const active = picked.includes(source.id)
          return (
            <button key={source.id} type="button" className="df-source" data-active={active} onClick={() => togglePick(source.id)}>
              <Icon aria-hidden="true" strokeWidth={1.8} />
              <span className="df-source-name">{source.name}</span>
              <span className="df-source-meta">{source.meta}</span>
              <span className="df-source-check" data-active={active} />
            </button>
          )
        })}
      </div>

      <button type="button" className="df-primary df-task-start" disabled={!brief.trim() || picked.length === 0} onClick={start}>
        开始生成
        <ChevronRight aria-hidden="true" strokeWidth={2.2} />
      </button>
    </section>
  )
}
