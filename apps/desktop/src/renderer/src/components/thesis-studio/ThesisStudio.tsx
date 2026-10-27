import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Columns2,
  Download,
  FileText,
  FileType2,
  FolderOpen,
  Loader2,
  Moon,
  RotateCcw,
  Sun,
  Trash2,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-react'
import { showToast } from '@/state/toast'
import { describeThesisError } from '../../../../shared/thesis-error-message'
import './thesis-studio.css'

/**
 * 智能排版工作台：论文/文档模板排版的产品化界面（替代原先藏在 AI 面板里的窄条）。
 *
 * 三栏：
 * - 左：模版库（拖拽上传 + 列表，含大纲预览入口与删除）
 * - 中：待排版文档（Room 内 docx）+ 开始排版 + 结果
 * - 右：规则面板（严格/融合、Logo/页眉页脚保留、标题映射）+ 四阶段进度
 *
 * 数据全部走既有网关链路（listCards / parseUpload / reformat / files），
 * 不新造后端契约；规则面板里后端暂未支持的项显式标灰，不做假开关。
 */

interface StudioCard {
  id: string
  sourceName: string
  sourceFileEntryId: string | null
  updatedAt: string
  card: Record<string, unknown>
}

interface StudioSourceDoc {
  id: string
  name: string
  updatedAt: string
}

type Phase = 'idle' | 'parsing' | 'mapping' | 'rendering' | 'done'

const PHASES: Array<{ key: Exclude<Phase, 'idle' | 'done'>; label: string }> = [
  { key: 'parsing', label: '解析模板结构' },
  { key: 'mapping', label: '映射内容段落' },
  { key: 'rendering', label: '渲染样式' },
]

/** 从格式卡里取槽位大纲（v2 剖面）；没有就返回空。 */
function slotOutlineOf(card: Record<string, unknown>): Array<{ title: string; kind: string; level?: number }> {
  const profile = card.profile as { slots?: Array<{ title?: string; kind?: string; level?: number }> } | undefined
  const slots = profile?.slots ?? []
  return slots
    .filter((slot) => typeof slot.title === 'string' && slot.title.trim().length > 0)
    .map((slot) => ({
      title: slot.title as string,
      kind: typeof slot.kind === 'string' ? slot.kind : 'body',
      ...(typeof slot.level === 'number' ? { level: slot.level } : {}),
    }))
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export function ThesisStudio({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [dark, setDark] = useState(() => window.localStorage.getItem('thesis-studio:dark') === '1')
  const [cards, setCards] = useState<StudioCard[] | null>(null)
  const [docs, setDocs] = useState<StudioSourceDoc[] | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [previewCard, setPreviewCard] = useState<StudioCard | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ fileEntryId: string; originalName: string; report?: Record<string, unknown> } | null>(null)
  // 规则面板（后端支持前的占位：状态本地保留，运行时不传）
  const [mode, setMode] = useState<'strict' | 'blend'>('strict')
  const [keepLogo, setKeepLogo] = useState(true)
  const [keepHeaderFooter, setKeepHeaderFooter] = useState(true)
  const [headingMap, setHeadingMap] = useState<{ chapter: 1 | 2 | 3 | 4; section: 1 | 2 | 3 | 4; subsection: 1 | 2 | 3 | 4 }>({
    chapter: 1,
    section: 2,
    subsection: 3,
  })
  const dragDepth = useRef(0)

  const busy = phase !== 'idle' && phase !== 'done'
  const selectedCard = useMemo(() => cards?.find((card) => card.id === selectedCardId) ?? null, [cards, selectedCardId])
  const selectedDoc = useMemo(() => docs?.find((doc) => doc.id === selectedDocId) ?? null, [docs, selectedDocId])
  const outline = useMemo(() => (previewCard ? slotOutlineOf(previewCard.card) : []), [previewCard])

  useEffect(() => {
    window.localStorage.setItem('thesis-studio:dark', dark ? '1' : '0')
  }, [dark])

  const loadCards = useCallback(() => {
    const api = window.nxcore?.thesisFormat
    if (!api) return
    void api.listCards(roomId)
      .then((rows) => {
        setCards(rows as StudioCard[])
        setSelectedCardId((current) => current ?? rows[0]?.id ?? null)
      })
      .catch((err: unknown) => {
        setCards([])
        setError(describeThesisError(err instanceof Error ? err.message : String(err)))
      })
  }, [roomId])

  const loadDocs = useCallback(() => {
    const files = window.nxcore?.files
    if (!files) return
    void files.list(500, 0)
      .then((page) => {
        const rows = page.items
          .filter((item) => /\.docx$/i.test(item.originalName ?? ''))
          .slice(0, 200)
          .map((item) => ({ id: item.id, name: item.originalName, updatedAt: item.updatedAt }))
        setDocs(rows)
        setSelectedDocId((current) => current ?? rows[0]?.id ?? null)
      })
      .catch(() => setDocs([]))
  }, [])

  useEffect(() => {
    setCards(null)
    setDocs(null)
    setError(null)
    setPhase('idle')
    setResult(null)
    loadCards()
    loadDocs()
  }, [loadCards, loadDocs])

  /** 拖拽解析模版：只收 .docx，字节直传网关（不落盘）。 */
  const parseTemplateFile = useCallback(async (file: File) => {
    const api = window.nxcore?.thesisFormat
    if (!api) {
      setError(describeThesisError('thesis_bridge_unavailable'))
      return
    }
    if (!/\.docx$/i.test(file.name)) {
      setError('只支持 Word（.docx）模版；旧 .doc 请先另存为 .docx。')
      return
    }
    setError(null)
    setPhase('parsing')
    try {
      const bytes = await file.arrayBuffer()
      const meta = await api.parseUpload(roomId, file.name, bytes)
      loadCards()
      if (meta.cardId) setSelectedCardId(meta.cardId)
      if (meta.factGaps && meta.factGaps.length > 0) {
        // 缺口显性提示（不静默降级）
        setError(`模版部分内容未解析：${meta.factGaps.join('；')}`)
      }
      setPhase('idle')
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)))
      setPhase('idle')
    }
  }, [loadCards, roomId])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void parseTemplateFile(file)
  }, [parseTemplateFile])

  const deleteTemplate = useCallback(async (cardId: string) => {
    const api = window.nxcore?.thesisFormat
    if (!api) return
    setDeletingId(cardId)
    setPendingDeleteId(null)
    setError(null)
    try {
      const outcome = await api.deleteTemplate(roomId, cardId)
      setCards((prev) => (prev ? prev.filter((card) => card.id !== cardId) : prev))
      if (outcome?.hadFile && !outcome.fileDeleted) {
        setError('格式卡已删除，但模版文件删除失败，请到资料区手动删除。')
      } else {
        showToast({ title: '模版已删除', message: '模版文件与格式卡均已清理。' })
      }
      loadCards()
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)))
    } finally {
      setDeletingId(null)
    }
  }, [loadCards, roomId])

  /**
   * 开始排版：提交任务拿 jobId，再轮询真实阶段。
   *
   * 为什么改成任务化：单次排版 5–10 分钟，长请求会被中间层在 5 分钟掐断，
   * 用户会看到「AI 不可用/超时」而服务端其实还在跑。短提交 + 轮询没有这个问题。
   */
  const runReformat = useCallback(async () => {
    const api = window.nxcore?.thesisFormat
    if (!api || !selectedCard || !selectedDoc) return
    setError(null)
    setResult(null)
    setPhase('parsing')
    try {
      const job = await api.reformatStart(roomId, selectedDoc.id, selectedCard.id, {
        mode,
        keepLogo,
        keepHeaderFooter,
        headingMapping: headingMap,
      })
      let snapshot = await api.reformatStatus(job.jobId)
      const started = Date.now()
      // 轮询到终态；12 分钟后放弃（后端作业仍在跑，可重开页面再查）
      while (snapshot.status === 'running' && Date.now() - started < 12 * 60 * 1000) {
        setPhase(snapshot.phase === 'rendering' ? 'rendering' : snapshot.phase === 'mapping' ? 'mapping' : 'parsing')
        await new Promise((resolve) => window.setTimeout(resolve, 900))
        snapshot = await api.reformatStatus(job.jobId)
      }
      if (snapshot.status === 'failed') {
        throw new Error(snapshot.error || 'thesis_reformat_failed')
      }
      if (snapshot.status !== 'completed' || !snapshot.result) {
        throw new Error('排版仍在后台进行，请稍后刷新任务列表查看结果。')
      }
      setResult(snapshot.result)
      setPhase('done')
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
      showToast({ title: '排版完成', message: snapshot.result.originalName })
      loadDocs()
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)))
      setPhase('idle')
    }
  }, [headingMap, keepHeaderFooter, keepLogo, loadDocs, mode, roomId, selectedCard, selectedDoc])

  const downloadWord = useCallback(async () => {
    if (!result) return
    try {
      await window.nxcore?.files.exportReveal(result.fileEntryId, result.originalName)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [result])

  /** 导出 PDF：调用主进程 LibreOffice 转换；本机没装就给出明确说明，不假装成功。 */
  const downloadPdf = useCallback(async () => {
    if (!result) return
    setPdfBusy(true)
    try {
      const outcome = await window.nxcore?.thesisFormat.exportPdf(roomId, result.fileEntryId)
      if (outcome && 'unavailable' in outcome && outcome.unavailable) {
        setError('本机未检测到 LibreOffice，暂时无法导出 PDF；可以先下载 Word 再另存为 PDF。')
      } else {
        showToast({ title: 'PDF 已导出', message: result.originalName.replace(/\.docx$/i, '.pdf') })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPdfBusy(false)
    }
  }, [result, roomId])

  const report = result?.report as
    | {
        conservation?: { matched?: number; total?: number; unmatched?: number }
        diff?: {
          left: Array<{ level: number; text: string; blocks: number }>
          right: Array<{ level: number; text: string; slotId: string; rule: string; blocks: number }>
          appended: string[]
        }
      }
    | undefined

  return (
    <div className="thesis-studio" data-theme={dark ? 'dark' : 'light'} role="dialog" aria-modal="true" aria-label="智能排版工作台">
      <header className="ts-head">
        <div className="ts-head-title">
          <span className="ts-logo"><Wand2 size={18} /></span>
          <div>
            <h1>智能排版工作台</h1>
            <p>用学校的 Word 模版，一键把内容排成标准论文格式</p>
          </div>
        </div>
        <div className="ts-head-actions">
          <button type="button" className="ts-icon-btn" onClick={() => setDark((value) => !value)} title={dark ? '切换到浅色' : '切换到深色'}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button type="button" className="ts-icon-btn" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="ts-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭提示"><X size={14} /></button>
        </div>
      ) : null}

      <div className="ts-body">
        {/* ── 左：模版库 ── */}
        <section className="ts-col ts-col-templates">
          <div className="ts-col-head">
            <h2>论文模版</h2>
            <span className="ts-count">{cards ? `${cards.length} 个` : '加载中'}</span>
          </div>

          <div
            className="ts-dropzone"
            data-dragging={dragging || undefined}
            data-busy={phase === 'parsing' || undefined}
            onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setDragging(true) }}
            onDragOver={(event) => { event.preventDefault() }}
            onDragLeave={(event) => {
              event.preventDefault()
              dragDepth.current = Math.max(0, dragDepth.current - 1)
              if (dragDepth.current === 0) setDragging(false)
            }}
            onDrop={onDrop}
          >
            {phase === 'parsing' ? (
              <div className="ts-dropzone-busy"><Loader2 className="ts-spin" size={16} /> 正在解析模版（约 1–5 分钟）…</div>
            ) : (
              <>
                <UploadCloud size={20} />
                <p>把 Word 模版拖到这里</p>
                <small>支持 .docx，解析后即可用于排版</small>
              </>
            )}
          </div>

          <div className="ts-list" role="list">
            {cards === null ? (
              Array.from({ length: 3 }).map((_, index) => (
                <div className="ts-card ts-skeleton" key={`skeleton-${index}`} aria-hidden="true">
                  <span className="ts-skeleton-icon" />
                  <span className="ts-skeleton-lines">
                    <i /><i />
                  </span>
                </div>
              ))
            ) : cards.length === 0 ? (
              <p className="ts-empty">还没有模版：把学校的 Word 模版拖进上面的区域。</p>
            ) : (
              cards.map((card) => (
                <div
                  className="ts-card"
                  key={card.id}
                  role="listitem"
                  data-selected={selectedCardId === card.id || undefined}
                  onClick={() => setSelectedCardId(card.id)}
                >
                  <span className="ts-card-icon"><FileText size={16} /></span>
                  <div className="ts-card-body">
                    <b title={card.sourceName}>{card.sourceName}</b>
                    <small>{formatTime(card.updatedAt)}</small>
                  </div>
                  <div className="ts-card-acts">
                    <button
                      type="button"
                      className="ts-ghost-btn"
                      title="预览大纲"
                      onClick={(event) => { event.stopPropagation(); setPreviewCard(card) }}
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      type="button"
                      className="ts-danger-btn"
                      title="删除模版"
                      disabled={deletingId === card.id}
                      onClick={(event) => { event.stopPropagation(); setPendingDeleteId(card.id) }}
                    >
                      {deletingId === card.id ? <Loader2 className="ts-spin" size={14} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                  {pendingDeleteId === card.id ? (
                    <div className="ts-confirm" onClick={(event) => event.stopPropagation()}>
                      <span>确定要删除该模板文件吗？<em>模版文件与格式卡都会一并删除</em></span>
                      <button type="button" onClick={() => setPendingDeleteId(null)}>取消</button>
                      <button type="button" className="is-danger" onClick={() => void deleteTemplate(card.id)}>删除</button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>

        {/* ── 中：待排版文档 ── */}
        <section className="ts-col ts-col-docs">
          <div className="ts-col-head">
            <h2>待排版文档</h2>
            <span className="ts-count">{docs ? `${docs.length} 个 Word` : '加载中'}</span>
          </div>
          <div className="ts-list" role="list">
            {docs === null ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div className="ts-card ts-skeleton" key={`doc-skeleton-${index}`} aria-hidden="true">
                  <span className="ts-skeleton-icon" />
                  <span className="ts-skeleton-lines"><i /><i /></span>
                </div>
              ))
            ) : docs.length === 0 ? (
              <p className="ts-empty">这个 Room 里还没有 Word 文档。</p>
            ) : (
              docs.map((doc) => (
                <button
                  type="button"
                  className="ts-card ts-card-selectable"
                  key={doc.id}
                  role="listitem"
                  data-selected={selectedDocId === doc.id || undefined}
                  onClick={() => setSelectedDocId(doc.id)}
                >
                  <span className="ts-card-icon"><FileText size={16} /></span>
                  <div className="ts-card-body">
                    <b title={doc.name}>{doc.name}</b>
                    <small>{formatTime(doc.updatedAt)}</small>
                  </div>
                  {selectedDocId === doc.id ? <Check className="ts-tick" size={14} /> : null}
                </button>
              ))
            )}
          </div>

          <div className="ts-run">
            <button
              type="button"
              className="ts-primary-btn"
              disabled={busy || !selectedCard || !selectedDoc}
              onClick={() => void runReformat()}
            >
              {busy ? <Loader2 className="ts-spin" size={15} /> : <Wand2 size={15} />}
              {busy ? '排版中…' : '开始排版'}
            </button>
            <p className="ts-run-hint">
              {selectedCard && selectedDoc
                ? `用「${selectedCard.sourceName}」排「${selectedDoc.name}」`
                : '选择一份模版和一份待排版文档'}
            </p>
          </div>

          {result ? (
            <div className="ts-result">
              <div className="ts-result-head">
                <Check size={15} />
                <b>{result.originalName}</b>
              </div>
              {report?.conservation ? (
                <p className="ts-result-meta">
                  已按模版落位 {report.conservation.matched ?? 0}/{report.conservation.total ?? 0} 个内容块
                  {(report.conservation.unmatched ?? 0) > 0
                    ? `；${report.conservation.unmatched} 个未匹配块已保留在文末「未归类内容」`
                    : ''}
                </p>
              ) : null}
              <div className="ts-result-acts">
                <button type="button" className="ts-primary-btn is-ghost" onClick={() => void downloadWord()}>
                  <Download size={14} /> 下载 Word
                </button>
                <button type="button" className="ts-ghost-btn is-bordered" onClick={() => void downloadPdf()}>
                  {pdfBusy ? <Loader2 className="ts-spin" size={14} /> : <FileType2 size={14} />} 导出 PDF
                </button>
              </div>
              <div className="ts-result-acts">
                <button
                  type="button"
                  className="ts-ghost-btn is-bordered"
                  disabled={!report?.diff}
                  onClick={() => setShowDiff(true)}
                >
                  <Columns2 size={14} /> 结构对比
                </button>
                <button type="button" className="ts-ghost-btn is-bordered" onClick={() => void runReformat()}>
                  <RotateCcw size={14} /> 重新排版
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {/* ── 右：规则 + 进度 ── */}
        <aside className="ts-col ts-col-rules">
          <div className="ts-col-head"><h2>排版规则</h2></div>

          <fieldset className="ts-fieldset" disabled={busy}>
            <legend>匹配模式</legend>
            <label className="ts-radio">
              <input type="radio" name="mode" checked={mode === 'strict'} onChange={() => setMode('strict')} />
              <span><b>严格匹配</b><em>完全按模版格式，内容只做落位</em></span>
            </label>
            <label className="ts-radio">
              <input type="radio" name="mode" checked={mode === 'blend'} onChange={() => setMode('blend')} />
              <span><b>融合模式</b><em>保留部分原文档格式</em></span>
            </label>
          </fieldset>

          <fieldset className="ts-fieldset" disabled={busy}>
            <legend>固定元素</legend>
            <label className="ts-check">
              <input type="checkbox" checked={keepLogo} onChange={(event) => setKeepLogo(event.target.checked)} />
              <span>保留模版 Logo</span>
            </label>
            <label className="ts-check">
              <input type="checkbox" checked={keepHeaderFooter} onChange={(event) => setKeepHeaderFooter(event.target.checked)} />
              <span>保留页眉页脚</span>
            </label>
          </fieldset>

          <fieldset className="ts-fieldset" disabled={busy}>
            <legend>标题层级映射</legend>
            {([
              ['chapter', '章（一级）'],
              ['section', '节（二级）'],
              ['subsection', '小节（三级）'],
            ] as const).map(([role, label]) => (
              <label className="ts-select-row" key={role}>
                <span>{label}</span>
                <select
                  value={headingMap[role]}
                  onChange={(event) => setHeadingMap((prev) => ({ ...prev, [role]: Number(event.target.value) as 1 | 2 | 3 | 4 }))}
                >
                  <option value={1}>模板一级标题</option>
                  <option value={2}>模板二级标题</option>
                  <option value={3}>模板三级标题</option>
                  <option value={4}>模板四级标题</option>
                </select>
              </label>
            ))}
          </fieldset>

          <div className="ts-note">
            严格模式完全按模版重建正文；融合模式保留原文档正文格式，只套模版的页面、页眉页脚与标题编号。
          </div>

          <div className="ts-col-head"><h2>进度</h2></div>
          <ol className="ts-phases">
            {PHASES.map((item, index) => {
              const order = PHASES.findIndex((entry) => entry.key === phase)
              const done = phase === 'done' || (order > index)
              const active = phase === item.key
              return (
                <li key={item.key} data-done={done || undefined} data-active={active || undefined}>
                  <span className="ts-phase-dot">{done ? <Check size={11} /> : index + 1}</span>
                  <span>{item.label}</span>
                  {active ? <Loader2 className="ts-spin" size={13} /> : null}
                </li>
              )
            })}
          </ol>
        </aside>
      </div>

      {showDiff && report?.diff ? (
        <div className="ts-drawer" role="dialog" aria-label="结构对比" onClick={() => setShowDiff(false)}>
          <div className="ts-drawer-panel ts-diff-panel" onClick={(event) => event.stopPropagation()}>
            <div className="ts-drawer-head">
              <div>
                <h3>结构对比</h3>
                <small>左：原文档章节 · 右：排版后落位（内容结构级，非像素级预览）</small>
              </div>
              <button type="button" className="ts-icon-btn" onClick={() => setShowDiff(false)} aria-label="关闭">
                <X size={15} />
              </button>
            </div>
            <div className="ts-diff">
              <div className="ts-diff-col">
                <h4>原内容</h4>
                <ul>
                  {report.diff.left.map((row, index) => (
                    <li key={`l-${index}`} data-level={row.level}>
                      <span className="ts-diff-level">H{row.level}</span>
                      <span className="ts-diff-text">{row.text}</span>
                      <span className="ts-diff-blocks">{row.blocks} 块</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="ts-diff-col">
                <h4>排版后</h4>
                <ul>
                  {report.diff.right.map((row, index) => (
                    <li key={`r-${index}`} data-level={row.level}>
                      <span className="ts-diff-level">H{row.level}</span>
                      <span className="ts-diff-text">{row.text}</span>
                      <span className="ts-diff-blocks">{row.blocks} 块</span>
                      <span className="ts-diff-rule">{row.rule}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {report.diff.appended.length > 0 ? (
              <div className="ts-diff-appended">
                <b>{report.diff.appended.length} 个未匹配块已保留在文末「未归类内容」</b>
                <ul>
                  {report.diff.appended.slice(0, 6).map((text, index) => (
                    <li key={`a-${index}`}>{text || '（空块）'}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {previewCard ? (
        <div className="ts-drawer" role="dialog" aria-label="模版大纲预览" onClick={() => setPreviewCard(null)}>
          <div className="ts-drawer-panel" onClick={(event) => event.stopPropagation()}>
            <div className="ts-drawer-head">
              <div>
                <h3>{previewCard.sourceName}</h3>
                <small>模版章节骨架（槽位）</small>
              </div>
              <button type="button" className="ts-icon-btn" onClick={() => setPreviewCard(null)} aria-label="关闭">
                <X size={15} />
              </button>
            </div>
            {outline.length === 0 ? (
              <p className="ts-empty">
                这份模版还没抽到章节骨架（可能是样式条款型模版）。排版时会按「全部追加」处理。
              </p>
            ) : (
              <ol className="ts-outline">
                {outline.map((slot, index) => (
                  <li key={`${slot.title}-${index}`} data-kind={slot.kind}>
                    <span className="ts-outline-index">{index + 1}</span>
                    <span className="ts-outline-title">{slot.title}</span>
                    <span className="ts-outline-kind">{slot.kind}</span>
                  </li>
                ))}
              </ol>
            )}
            <div className="ts-drawer-foot">
              <button type="button" className="ts-ghost-btn is-bordered" onClick={() => void window.nxcore?.files.reveal(previewCard.sourceFileEntryId ?? '').catch(() => undefined)}>
                <FolderOpen size={14} /> 在文件夹中显示
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
