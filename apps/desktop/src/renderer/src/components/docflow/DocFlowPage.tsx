import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  CircleAlert,
  FileDown,
  FileText,
  LoaderCircle,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OfficePreviewTab } from '../../../../shared/sources'
import type { PageId } from '@/data/navigation'
import { useDocFlowRequest } from './docFlowRequest'
import { DOC_FLOW_SOURCES } from './DocTaskCard'

import './docflow.css'

/** ============ 类型 ============ */

type StepStatus = 'waiting' | 'working' | 'review' | 'done'

interface Chapter {
  id: string
  title: string
  note: string
}

interface ChapterMaterial {
  chapterId: string
  matches: Array<{ sourceId: string; excerpt: string }>
  missing?: string
  skipped?: boolean
}

interface Paragraph {
  id: string
  text: string
  cite?: string
  aiGuess?: boolean
  sentToAgent?: boolean
}

interface ChapterContent {
  chapterId: string
  paragraphs: Paragraph[]
}

const STEP_LABELS = ['搭骨架', '找材料', '填内容', '补数据和图', '通篇过一遍', '排版出文件', '出完接着改'] as const
const STEP_HINTS = [
  '按你要的东西拆结构，看一眼就能改',
  '从资料里挑出每部分相关内容，缺料的会告诉你',
  '一部分一部分写，写完一块给看一眼',
  '该算的算、做表、配图，你来核对',
  '说法统一、篇幅合适、出处对得上',
  '套模板落成 .docx，在编辑器里接着改',
  '选中哪段说一句，只重做那一块',
] as const

const TEMPLATES = [
  { id: 'blue', label: '商务蓝', swatch: '#3d6ff6' },
  { id: 'mono', label: '极简黑白', swatch: '#171717' },
  { id: 'brand', label: '公司模板', swatch: '#0aa679' },
] as const

const SUGGESTED_PROMPTS = ['太长了，压到三句', '换个更正式的说法', '数据更新到 9 月'] as const

/** ============ Mock 数据 ============ */

const INITIAL_OUTLINE: Chapter[] = [
  { id: 'c1', title: '一、项目背景与目标', note: '为什么做这件事，目标定在哪' },
  { id: 'c2', title: '二、Q3 关键进展', note: '按三条主线讲清楚做了什么' },
  { id: 'c3', title: '三、数据表现', note: '核心指标对比与环比' },
  { id: 'c4', title: '四、问题与风险', note: '没做成的、卡住的、需要决策的' },
  { id: 'c5', title: '五、Q4 计划', note: '下季度节奏与资源' },
]

const INITIAL_MATERIALS: ChapterMaterial[] = [
  {
    chapterId: 'c1',
    matches: [{ sourceId: 's2', excerpt: '「Q3 启动会上确认目标：DAU 突破 80 万，NPS 回到 40 以上，连接器覆盖 5 个一级场景。」' }],
  },
  {
    chapterId: 'c2',
    matches: [
      { sourceId: 's1', excerpt: '「O1 连接器统一：三条链路并入统一格式层，映射表收口完成。」' },
      { sourceId: 's2', excerpt: '「8 月第 2 周：知识库自动摘要上线，周报整理耗时从 40 分钟降到 8 分钟。」' },
    ],
  },
  {
    chapterId: 'c3',
    matches: [{ sourceId: 's3', excerpt: '「7-8 月 DAU、新增注册、次留完整；9 月数据截至 9/20。」' }],
    missing: '9 月完整增长数据（月度口径）缺失，建议补充「9月增长月报.xlsx」',
  },
  { chapterId: 'c4', matches: [{ sourceId: 's1', excerpt: '「风险：外部连接器 API 配额限流，影响 2 个灰度客户。」' }] },
  { chapterId: 'c5', matches: [], missing: '资料里没有 Q4 计划的直接内容，Agent 将基于 Q3 进展推测，产出会标「待确认」' },
]

const INITIAL_CONTENT: ChapterContent[] = [
  {
    chapterId: 'c1',
    paragraphs: [
      { id: 'p1', text: '本季度项目围绕「让 AI 真正干完一份活」推进，启动会上确认三项核心目标：DAU 突破 80 万、NPS 回到 40 以上、连接器覆盖 5 个一级场景。目标拆解到三条产品主线，由增长、体验、连接器三个小组分别承接。', cite: '产品周报 7-9 月合集' },
    ],
  },
  {
    chapterId: 'c2',
    paragraphs: [
      { id: 'p2', text: '连接器统一：Gmail、日历、云文档三条链路并入统一格式层，映射表三处同值完成收口，外部依赖从 4 个降到 1 个，故障定位平均耗时缩短 60%。', cite: 'Q3 OKR 复盘' },
      { id: 'p3', text: '体验主线：知识库自动摘要 8 月上线后，用户整理周报的平均耗时从 40 分钟降到 8 分钟；9 月完成第二轮内测，覆盖 120 名种子用户。', cite: '产品周报 7-9 月合集' },
      { id: 'p4', text: '增长主线：与市场部联动的内容投放渠道从 2 个扩展到 5 个，其中 2 个渠道的自然量转化率进入团队前五，为 Q4 的渠道预算分配提供了数据依据。', aiGuess: true },
    ],
  },
  {
    chapterId: 'c3',
    paragraphs: [
      { id: 'p5', text: 'Q3 核心指标全线达标：DAU 从 62.4 万增至 81.2 万（目标 80 万），新增注册 41.7 万，次留 48.2%，NPS 从 31 回升至 42。增长主要来自 8 月摘要功能上线后的口碑传播与渠道扩展。', cite: '用户增长数据 2026Q3' },
    ],
  },
  {
    chapterId: 'c4',
    paragraphs: [
      { id: 'p6', text: '外部风险：三家连接器服务商中一家于 9 月启动 API 配额限流，影响 2 个灰度客户的日历同步，已切换备用链路，预计 10 月中旬完全恢复。', cite: 'Q3 OKR 复盘' },
      { id: 'p7', text: '内部风险：数据看板的口径在三季度内调整过一次，历史数据需以 9/20 快照为准，跨季度对比时需注意口径差异。', aiGuess: true },
    ],
  },
  {
    chapterId: 'c5',
    paragraphs: [
      { id: 'p8', text: 'Q4 建议围绕「把跑通的流程沉淀为模板」推进：连接器统一方案扩展到剩余场景，摘要能力开放给全部用户，并启动企业版灰度。资源上建议增长小组保持现状，体验小组补充 1 名数据分析师。节奏上 10 月完成模板化，11 月灰度，12 月全量。', aiGuess: true },
    ],
  },
]

const METRIC_TABLE = {
  header: ['指标', 'Q2', 'Q3', '环比'],
  rows: [
    ['DAU（万）', '62.4', '81.2', '+30.1%'],
    ['新增注册（万）', '28.3', '41.7', '+47.3%'],
    ['次留', '44.5%', '48.2%', '+3.7pp'],
    ['NPS', '31', '42', '+11'],
  ],
}

const CHART_BARS = [
  { label: '7月', value: 11.2 },
  { label: '8月', value: 14.6 },
  { label: '9月', value: 15.9 },
]

const REVIEW_ITEMS = [
  { level: 'ok', text: '前后说法统一：已统一「Q3 / 第三季度」混用 2 处' },
  { level: 'ok', text: '出处核对：14 处事实引用全部对上来源，可点击跳回原文' },
  { level: 'warn', text: '3 处内容来自 Agent 推测（第四、五章），正文已标「待确认」' },
  { level: 'warn', text: '篇幅：第五章偏长（约 150 字），可压缩到 3 句' },
] as const

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

function buildDocHtml(chapters: Chapter[], contents: ChapterContent[]): string {
  const tableHtml = [
    `<table><thead><tr>${METRIC_TABLE.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`,
    `<tbody>${METRIC_TABLE.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
  ].join('')
  return chapters.map((chapter) => {
    const section = contents.find((item) => item.chapterId === chapter.id)
    const paras = (section?.paragraphs ?? [])
      .map((paragraph) => `<p>${escapeHtml(paragraph.text)}${paragraph.cite ? `<em>（来源：${escapeHtml(paragraph.cite)}）</em>` : ''}</p>`)
      .join('')
    const table = chapter.id === 'c3' ? tableHtml : ''
    return `<h2>${escapeHtml(chapter.title)}</h2>${paras}${table}`
  }).join('')
}

function sourceName(id: string): string {
  return DOC_FLOW_SOURCES.find((item) => item.id === id)?.name ?? id
}

function useMockDelay(active: boolean, ms: number) {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    setElapsed(false)
    const timer = window.setTimeout(() => setElapsed(true), ms)
    return () => window.clearTimeout(timer)
  }, [active, ms])
  return elapsed
}

/** ============ 步骤子组件 ============ */

function StepRail({ current, statuses }: { current: number; statuses: StepStatus[] }) {
  return (
    <nav className="df-rail" data-testid="step-rail">
      {STEP_LABELS.map((label, index) => (
        <div key={label} className={`df-rail-item df-rail-item-${statuses[index]}`} data-current={index === current}>
          <span className="df-rail-dot">
            {statuses[index] === 'waiting' ? <i>{index + 1}</i>
              : statuses[index] === 'done' ? <Check aria-hidden="true" strokeWidth={2.4} />
              : statuses[index] === 'working' ? <LoaderCircle aria-hidden="true" className="df-spin" strokeWidth={2} />
              : <i>{index + 1}</i>}
          </span>
          <span className="df-rail-text">
            <strong>{label}</strong>
            <small>{statuses[index] === 'waiting' ? '等待' : statuses[index] === 'working' ? '进行中' : statuses[index] === 'review' ? '等你过目' : '已完成'}</small>
          </span>
        </div>
      ))}
    </nav>
  )
}

function OutlineStep({ chapters, setChapters, onConfirm }: {
  chapters: Chapter[]
  setChapters: (next: Chapter[]) => void
  onConfirm: () => void
}) {
  const update = (id: string, patch: Partial<Chapter>) => {
    setChapters(chapters.map((chapter) => (chapter.id === id ? { ...chapter, ...patch } : chapter)))
  }
  const move = (index: number, delta: number) => {
    const next = [...chapters]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setChapters(next)
  }
  return (
    <div className="df-step-body">
      <div className="df-outline" data-testid="outline-editor">
        {chapters.map((chapter, index) => (
          <div key={chapter.id} className="df-outline-row">
            <span className="df-outline-index">{index + 1}</span>
            <div className="df-outline-main">
              <input value={chapter.title} onChange={(event) => update(chapter.id, { title: event.target.value })} />
              <input
                className="df-outline-note"
                value={chapter.note}
                placeholder="这部分讲什么"
                onChange={(event) => update(chapter.id, { note: event.target.value })}
              />
            </div>
            <div className="df-outline-ops">
              <button type="button" aria-label="上移" onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></button>
              <button type="button" aria-label="下移" onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></button>
              <button type="button" aria-label="删除" onClick={() => setChapters(chapters.filter((item) => item.id !== chapter.id))}><Trash2 aria-hidden="true" /></button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="df-outline-add"
          onClick={() => setChapters([...chapters, { id: `c${Date.now()}`, title: `${chapters.length + 1}、新章节（改个标题）`, note: '' }])}
        >
          <Plus aria-hidden="true" strokeWidth={2} />
          加一章
        </button>
      </div>
      <div className="df-step-actions">
        <span className="df-step-tip">骨架不对就现在改，后面的活不会白做。</span>
        <button type="button" className="df-primary" onClick={onConfirm}>骨架没问题，继续</button>
      </div>
    </div>
  )
}

function MaterialStep({ chapters, materials, setMaterials, onConfirm }: {
  chapters: Chapter[]
  materials: ChapterMaterial[]
  setMaterials: (next: ChapterMaterial[]) => void
  onConfirm: () => void
}) {
  const patch = (chapterId: string, next: Partial<ChapterMaterial>) => {
    setMaterials(materials.map((item) => (item.chapterId === chapterId ? { ...item, ...next } : item)))
  }
  return (
    <div className="df-step-body">
      <div className="df-materials" data-testid="material-map">
        {chapters.map((chapter) => {
          const row = materials.find((item) => item.chapterId === chapter.id)
          if (!row) return null
          const showMissing = Boolean(row.missing && !row.skipped)
          return (
            <div key={chapter.id} className="df-material-row" data-missing={showMissing}>
              <div className="df-material-chapter">
                <strong>{chapter.title}</strong>
                {showMissing && <span className="df-badge df-badge-warn"><CircleAlert aria-hidden="true" />{row.missing}</span>}
                {row.skipped && <span className="df-badge df-badge-muted">已标记：这块不用写</span>}
              </div>
              <ul className="df-material-matches">
                {row.matches.map((match, index) => (
                  <li key={index}>
                    <span className="df-material-src">{sourceName(match.sourceId)}</span>
                    <span className="df-material-excerpt">{match.excerpt}</span>
                  </li>
                ))}
              </ul>
              {showMissing && (
                <div className="df-material-fix">
                  <button type="button" className="df-secondary" onClick={() => patch(chapter.id, {
                    matches: [...row.matches, { sourceId: 's5', excerpt: '「9 月 DAU 81.6 万，新增注册 16.1 万，次留 49.0%，全月口径。」' }],
                    missing: undefined,
                  })}>
                    <Plus aria-hidden="true" strokeWidth={2} />
                    补充「9月增长月报」
                  </button>
                  <button type="button" className="df-secondary" onClick={() => patch(chapter.id, { skipped: true })}>
                    这块不用写
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="df-step-actions">
        <span className="df-step-tip">缺料的章节现在补，或者让 Agent 跳过；Agent 不会硬编。</span>
        <button type="button" className="df-primary" onClick={onConfirm}>材料齐了，开始写</button>
      </div>
    </div>
  )
}

function WriteStep({ outline, contents, writingChapterId, paused, onStop, onContinue, onConfirm }: {
  outline: Chapter[]
  contents: ChapterContent[]
  writingChapterId: string | null
  paused: boolean
  onStop: () => void
  onContinue: () => void
  onConfirm: () => void
}) {
  const allWritten = writingChapterId === null
  return (
    <div className="df-step-body">
      <div className="df-write-list" data-testid="section-writes">
        {contents.map((section) => (
          <div key={section.chapterId} className="df-write-section">
            <div className="df-write-heading">
              <strong>{outline.find((chapter) => chapter.id === section.chapterId)?.title ?? section.chapterId}</strong>
              <span className={`df-badge ${writingChapterId === section.chapterId ? 'df-badge-working' : 'df-badge-ok'}`}>
                {writingChapterId === section.chapterId ? '写ing' : '写好了'}
              </span>
            </div>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph.id} className="df-write-para">
                {paragraph.text}
                {paragraph.cite && <span className="df-cite">{paragraph.cite}</span>}
                {paragraph.aiGuess && <span className="df-badge df-badge-warn">待确认</span>}
              </p>
            ))}
          </div>
        ))}
      </div>
      <div className="df-step-actions">
        {!allWritten ? (
          <>
            <span className="df-step-tip">{paused ? '已暂停，前面的内容都在。' : '写完一块给看一块；方向不对当场叫停，不用整份重来。'}</span>
            {paused
              ? <button type="button" className="df-primary" onClick={onContinue}>接着写</button>
              : <button type="button" className="df-secondary" onClick={onStop}>先停一下</button>}
          </>
        ) : (
          <>
            <span className="df-step-tip">全部写完，每段都标了来源；没来源的标了「待确认」。</span>
            <button type="button" className="df-primary" onClick={onConfirm}>继续，补数据和图</button>
          </>
        )}
      </div>
    </div>
  )
}

function DataStep({ onConfirm }: { onConfirm: () => void }) {
  const max = Math.max(...CHART_BARS.map((bar) => bar.value))
  return (
    <div className="df-step-body">
      <div className="df-data-grid" data-testid="data-assets">
        <div className="df-panel">
          <div className="df-panel-head">
            <strong>表 1 · Q3 核心指标</strong>
            <span className="df-cite">用户增长数据 2026Q3</span>
          </div>
          <table className="df-table">
            <thead>
              <tr>{METRIC_TABLE.header.map((cell) => <th key={cell}>{cell}</th>)}</tr>
            </thead>
            <tbody>
              {METRIC_TABLE.rows.map((row) => (
                <tr key={row[0]}>{row.map((cell, index) => <td key={index} data-num={index > 0}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="df-panel">
          <div className="df-panel-head">
            <strong>图 1 · 新增注册（万）</strong>
            <span className="df-cite">用户增长数据 2026Q3</span>
          </div>
          <div className="df-chart">
            {CHART_BARS.map((bar) => (
              <div key={bar.label} className="df-chart-col">
                <span className="df-chart-value">{bar.value}</span>
                <i style={{ height: `${Math.round((bar.value / max) * 100)}%` }} />
                <span>{bar.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="df-step-actions">
        <span className="df-step-tip">数字和图都来自你给的表格，点出处能跳回原表；对不上就说。</span>
        <button type="button" className="df-primary" onClick={onConfirm}>数没问题，通篇过一遍</button>
      </div>
    </div>
  )
}

function ReviewStep({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div className="df-step-body">
      <ul className="df-review-list" data-testid="review-checklist">
        {REVIEW_ITEMS.map((item, index) => (
          <li key={index} className={`df-review-item df-review-${item.level}`}>
            {item.level === 'ok'
              ? <Check aria-hidden="true" strokeWidth={2.4} />
              : <CircleAlert aria-hidden="true" strokeWidth={2} />}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
      <div className="df-step-actions">
        <span className="df-step-tip">「待确认」的内容不确认就留在原处，不会混进事实里。</span>
        <button type="button" className="df-primary" onClick={onConfirm}>确认，去排版</button>
      </div>
    </div>
  )
}

type GenState =
  | { phase: 'pick' }
  | { phase: 'generating' }
  | { phase: 'done'; fileEntryId: string; originalName: string }
  | { phase: 'error'; message: string }

function LayoutStep({ genState, template, setTemplate, onGenerate, onOpenEditor, onStayRework }: {
  genState: GenState
  template: string
  setTemplate: (id: string) => void
  onGenerate: () => void
  onOpenEditor: () => void
  onStayRework: () => void
}) {
  return (
    <div className="df-step-body">
      {genState.phase === 'pick' && (
        <>
          <div className="df-templates" data-testid="template-picker">
            {TEMPLATES.map((item) => (
              <button key={item.id} type="button" className="df-template" data-active={template === item.id} onClick={() => setTemplate(item.id)}>
                <span className="df-template-swatch" style={{ background: item.swatch }} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="df-step-actions">
            <span className="df-step-tip">选好模板后真实生成 .docx 并入文件库。</span>
            <button type="button" className="df-primary" onClick={onGenerate}>排版出文件</button>
          </div>
        </>
      )}
      {genState.phase === 'generating' && (
        <div className="df-working" data-testid="docx-generating">
          <LoaderCircle aria-hidden="true" className="df-spin" />
          正在套模板、落成 .docx 并入文件库…
        </div>
      )}
      {genState.phase === 'error' && (
        <div className="df-review-item df-review-warn">
          <CircleAlert aria-hidden="true" strokeWidth={2} />
          <span>生成失败：{genState.message}</span>
        </div>
      )}
      {genState.phase === 'done' && (
        <div className="df-done-card" data-testid="file-done-card">
          <span className="df-done-icon"><FileText aria-hidden="true" strokeWidth={1.6} /></span>
          <div>
            <strong>{genState.originalName}</strong>
            <small>已生成并保存到文件库，可在编辑器里继续修改。</small>
          </div>
          <div className="df-done-actions">
            <button type="button" className="df-primary" onClick={onOpenEditor}>
              在编辑器中打开
              <ChevronRight aria-hidden="true" strokeWidth={2.2} />
            </button>
            <button type="button" className="df-secondary" onClick={onStayRework}>先留在这，再改改</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReworkStep({ outline, contents, fileName, onSendToAgent, onExport, exporting }: {
  outline: Chapter[]
  contents: ChapterContent[]
  fileName: string | null
  onSendToAgent: (paragraph: Paragraph, prompt: string) => void
  onExport: () => void
  exporting: boolean
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const selectedPara = useMemo(
    () => contents.flatMap((section) => section.paragraphs).find((paragraph) => paragraph.id === selected) ?? null,
    [contents, selected],
  )
  return (
    <div className="df-step-body df-rework-body">
      <div className="df-doc-preview" data-testid="doc-preview">
        {contents.map((section) => (
          <section key={section.chapterId}>
            <h3>{outline.find((chapter) => chapter.id === section.chapterId)?.title}</h3>
            {section.paragraphs.map((paragraph) => (
              <p
                key={paragraph.id}
                className="df-doc-para"
                data-selected={paragraph.id === selected}
                onClick={() => {
                  setSelected(paragraph.id)
                  setPrompt('')
                }}
              >
                {paragraph.text}
                {paragraph.cite && <span className="df-cite">{paragraph.cite}</span>}
                {paragraph.aiGuess && <span className="df-badge df-badge-warn">待确认</span>}
                {paragraph.sentToAgent && <span className="df-badge df-badge-ok">已交给 Agent</span>}
              </p>
            ))}
          </section>
        ))}
      </div>
      <aside className="df-rework-panel">
        {selectedPara ? (
          <>
            <strong>只改这一段</strong>
            <p className="df-rework-hint">其他部分原样不动。选中内容：{selectedPara.text.slice(0, 40)}…</p>
            <div className="df-chips">
              {SUGGESTED_PROMPTS.map((item) => (
                <button key={item} type="button" className="df-chip" onClick={() => setPrompt(item)}>{item}</button>
              ))}
            </div>
            <textarea rows={2} value={prompt} placeholder="说说这段怎么改" onChange={(event) => setPrompt(event.target.value)} />
            {fileName ? (
              <button
                type="button" className="df-primary" data-testid="send-to-agent"
                disabled={!prompt.trim()}
                onClick={() => onSendToAgent(selectedPara, prompt)}
              >
                发送给 Agent 重做
              </button>
            ) : (
              <p className="df-rework-hint">先在「排版出文件」生成 .docx，才能把段落交给 Agent 改。</p>
            )}
            <p className="df-rework-hint">Agent 在右侧对话区接单，直接改《{fileName ?? '文件'}》里的这一段；这里的预览不跟着变。</p>
          </>
        ) : (
          <>
            <strong>出完接着改</strong>
            <p className="df-rework-hint">点正文里任何一段，说一句怎么改，指令会发给 Agent 只重做那一块，其余原样保留；改完可再导出一版。</p>
          </>
        )}
        <button type="button" className="df-export" disabled={exporting} onClick={onExport}>
          {exporting ? <LoaderCircle aria-hidden="true" className="df-spin" /> : <FileDown aria-hidden="true" strokeWidth={1.8} />}
          {exporting ? '正在导出…' : '导出新一版'}
        </button>
      </aside>
    </div>
  )
}

/** ============ 流程页 ============ */

export function DocFlowPage({ onNavigate, onOpenOfficePreview }: {
  onNavigate: (page: PageId) => void
  onOpenOfficePreview: (tab: OfficePreviewTab) => void
}) {
  const request = useDocFlowRequest()
  const [step, setStep] = useState(0)
  const [statuses, setStatuses] = useState<StepStatus[]>(() => STEP_LABELS.map(() => 'waiting'))
  const [outline, setOutline] = useState(INITIAL_OUTLINE)
  const [materials, setMaterials] = useState(INITIAL_MATERIALS)
  const [written, setWritten] = useState<ChapterContent[]>([])
  const [writingIndex, setWritingIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [template, setTemplate] = useState('blue')
  const [genState, setGenState] = useState<GenState>({ phase: 'pick' })
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const outlineReady = useMockDelay(step === 0 && statuses[0] === 'working', 1400)

  const enterStep = (index: number, status: StepStatus = 'review') => {
    setStep(index)
    setStatuses((prev) => prev.map((item, i) => (i === index ? status : item)))
  }

  const completeStep = (index: number) => {
    setStatuses((prev) => prev.map((item, i) => (i === index ? 'done' : item)))
  }

  // 首次进入：搭骨架进行中。
  useEffect(() => {
    if (request) enterStep(0, 'working')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.requestId])

  // 搭骨架 working → review。
  useEffect(() => {
    if (step === 0 && outlineReady) {
      setStatuses((prev) => prev.map((item, i) => (i === 0 ? 'review' : item)))
    }
  }, [outlineReady, step])

  // 填内容：逐章推进（可暂停、可续写）。activeChapters 用 memo 固定引用，
  // 否则每次渲染都是新数组，effect 反复重跑形成 setState 循环。
  const activeChapters = useMemo(
    () => outline.filter((chapter) => materials.find((item) => item.chapterId === chapter.id)?.skipped !== true),
    [outline, materials],
  )
  useEffect(() => {
    if (step !== 2 || paused) return
    if (writingIndex >= activeChapters.length) {
      setStatuses((prev) => (prev[2] === 'review' ? prev : prev.map((item, i) => (i === 2 ? 'review' : item))))
      return
    }
    const chapterId = activeChapters[writingIndex].id
    const timer = window.setTimeout(() => {
      const section = INITIAL_CONTENT.find((item) => item.chapterId === chapterId)
      if (section) setWritten((prev) => [...prev.filter((item) => item.chapterId !== chapterId), section])
      setWritingIndex((prev) => prev + 1)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [step, writingIndex, paused, activeChapters])

  const generate = useCallback(async (mode: 'first' | 'rework') => {
    const office = window.nxcore?.office
    if (!office?.generateDocxPrototype) {
      setGenState({ phase: 'error', message: '当前客户端版本不支持直接生成。' })
      return
    }
    try {
      const result = await office.generateDocxPrototype({ title: 'Q3 进展汇报', html: buildDocHtml(outline, written) })
      if (mode === 'first') {
        setGenState({ phase: 'done', fileEntryId: result.fileEntryId, originalName: result.originalName })
        completeStep(5)
      } else {
        setToast(`已导出新一版：${result.originalName}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (mode === 'first') setGenState({ phase: 'error', message })
      else setToast(`导出失败：${message}`)
    } finally {
      setExporting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, written])

  const openInEditor = useCallback(async () => {
    if (genState.phase !== 'done') return
    const files = window.nxcore?.files
    if (!files) return
    try {
      const opened = await files.openOriginal(genState.fileEntryId, genState.originalName, undefined, { editable: true })
      if (opened.openedWith === 'office') {
        onOpenOfficePreview({ id: opened.instanceId, title: opened.title, kind: opened.kind })
        enterStep(6)
      } else {
        setToast('文件已生成，但内置编辑器暂不可用。')
      }
    } catch (error) {
      setToast(`打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [genState, onOpenOfficePreview])

  /** 选段修改 → 组装指令发给 Agent（App 监听 nxcore:agent:ask 自动发送）。 */
  const sendParagraphToAgent = (paragraph: Paragraph, prompt: string) => {
    if (genState.phase !== 'done') return
    const fileName = genState.originalName
    const trimmedPrompt = prompt.trim().replace(/[。.!！]+$/, '')
    const excerpt = paragraph.text.length > 60 ? `${paragraph.text.slice(0, 60)}…` : paragraph.text
    window.dispatchEvent(new CustomEvent('nxcore:agent:ask', {
      detail: {
        message:
          `请修改 Word《${fileName}》（fileEntryId=${genState.fileEntryId}）中这段内容：「${excerpt}」。`
          + `要求：${trimmedPrompt}。`
          + '先用 office_read 定位这段原文，再用 office_edit 只改这一段，其余内容保持不动。',
        displayMessage: `把《${fileName}》选中的段落改一下：${trimmedPrompt}。`,
      },
    }))
    setWritten((prev) => prev.map((section) => ({
      ...section,
      paragraphs: section.paragraphs.map((item) => (
        item.id === paragraph.id ? { ...item, sentToAgent: true } : item
      )),
    })))
  }

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!request) {
    return (
      <div className="df-flow">
        <div className="df-step-pane">
          <div className="df-step-head">
            <h2>还没有任务</h2>
            <p>回首页填一张任务卡，说清要做什么文件。</p>
          </div>
          <button type="button" className="df-primary" onClick={() => onNavigate('home')}>回首页开活</button>
        </div>
      </div>
    )
  }

  return (
    <div className="df-flow" data-testid="doc-flow-page">
      <header className="df-flow-head">
        <button type="button" className="df-back" onClick={() => onNavigate('home')}>
          <ArrowLeft aria-hidden="true" strokeWidth={2} />
          首页
        </button>
        <div className="df-flow-title">
          <FileText aria-hidden="true" strokeWidth={1.8} />
          <strong>Q3 进展汇报.docx</strong>
          <span className="df-badge df-badge-muted">分析报告 · {request.audience}</span>
        </div>
        <span className="df-flow-brief" title={request.brief}>{request.brief}</span>
      </header>
      <div className="df-flow-main">
        <StepRail current={step} statuses={statuses} />
        <main className="df-step-pane">
          <div className="df-step-head">
            <h2>{step + 1}. {STEP_LABELS[step]}</h2>
            <p>{STEP_HINTS[step]}</p>
          </div>
          {statuses[step] === 'working' && step === 0 && (
            <div className="df-working" data-testid="step-0-working">
              <LoaderCircle aria-hidden="true" className="df-spin" />
              正在拆结构：按「{request.audience}汇报」的读法组织 5 章…
            </div>
          )}
          {step === 0 && statuses[0] === 'review' && (
            <OutlineStep chapters={outline} setChapters={setOutline} onConfirm={() => { completeStep(0); enterStep(1) }} />
          )}
          {step === 1 && (
            <MaterialStep
              chapters={outline}
              materials={materials}
              setMaterials={setMaterials}
              onConfirm={() => { completeStep(1); setWritten([]); setWritingIndex(0); setPaused(false); enterStep(2, 'working') }}
            />
          )}
          {step === 2 && (
            <WriteStep
              outline={outline}
              contents={written}
              writingChapterId={writingIndex < activeChapters.length ? activeChapters[writingIndex].id : null}
              paused={paused}
              onStop={() => setPaused(true)}
              onContinue={() => setPaused(false)}
              onConfirm={() => { completeStep(2); enterStep(3) }}
            />
          )}
          {step === 3 && <DataStep onConfirm={() => { completeStep(3); enterStep(4) }} />}
          {step === 4 && <ReviewStep onConfirm={() => { completeStep(4); enterStep(5) }} />}
          {step === 5 && (
            <LayoutStep
              genState={genState}
              template={template}
              setTemplate={setTemplate}
              onGenerate={() => { setGenState({ phase: 'generating' }); void generate('first') }}
              onOpenEditor={() => { void openInEditor() }}
              onStayRework={() => enterStep(6)}
            />
          )}
          {step === 6 && (
            <ReworkStep
              outline={outline}
              contents={written}
              fileName={genState.phase === 'done' ? genState.originalName : null}
              onSendToAgent={sendParagraphToAgent}
              onExport={() => { setExporting(true); void generate('rework') }}
              exporting={exporting}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="df-toast" data-testid="doc-flow-toast">
          <Check aria-hidden="true" strokeWidth={2.4} />
          {toast}
          <button type="button" aria-label="关闭" onClick={() => setToast(null)}><X aria-hidden="true" /></button>
        </div>
      )}
    </div>
  )
}
