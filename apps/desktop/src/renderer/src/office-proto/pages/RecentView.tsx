import React, { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, ChevronRight } from 'lucide-react'

import {
  type InsightAction, type OfficeFile, blankFile, dailyInsight, dailyInsightActions,
  draftFile, files, draftingSteps, fetchRealFiles, openRealFile, type RealOfficeFile,
} from '../data'
import { FileTable, FileTypeIcon } from './parts'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 打字机效果：AI「正在说话」的感觉；nonce 变化时从头再打一遍。 */
function useTypewriter(text: string, nonce: number): string {
  const [n, setN] = useState(0)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(text.length)
      return
    }
    setN(0)
    const id = window.setInterval(() => {
      setN((v) => {
        if (v >= text.length) { window.clearInterval(id); return v }
        return Math.min(v + 2, text.length)
      })
    }, 24)
    return () => window.clearInterval(id)
  }, [text, nonce])

  return text.slice(0, n)
}

export function RecentView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [drafting, setDrafting] = useState(false)
  // EverRoomMac 接入：有真实文件库时最近文件显示真实文件（打开走内置预览）。
  const [real, setReal] = useState<RealOfficeFile[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchRealFiles(20).then((items) => {
      if (!cancelled) setReal(items)
    })
    return () => { cancelled = true }
  }, [])

  const openFromTable = (f: OfficeFile) => {
    const entry = real?.find((x) => x.file.id === f.id)
    if (!entry) { onOpenFile(f); return }
    void openRealFile(entry.catalog).then((opened) => {
      if (!opened) onOpenFile(f)
    })
  }

  const act = (a: InsightAction) => {
    if (a.type === 'draft') { setDrafting(true); return }
    const f = a.fileId ? files.find((x) => x.id === a.fileId) : undefined
    if (f) onOpenFile(f)
  }

  return (
    <>
      <section className="op-greeting">
        <h1>{greeting()}，王小雨</h1>
        <p>今天有 3 封新邮件和 1 场会议进入了你的记忆，随时可以调用。</p>
      </section>

      <InsightCard onAct={act} onToast={onToast} />

      <section className="op-section">
        <div className="op-section-head"><h2>新建</h2></div>
        <div className="op-create-row">
          <button className="op-create-tile" type="button" onClick={() => onOpenFile(blankFile('docx'))}>
            <FileTypeIcon kind="docx" size={46} />
            <span className="op-create-name">文字文档</span>
          </button>
          <button className="op-create-tile" type="button" onClick={() => onOpenFile(blankFile('xlsx'))}>
            <FileTypeIcon kind="xlsx" size={46} />
            <span className="op-create-name">表格</span>
          </button>
          <button className="op-create-tile" type="button" onClick={() => onOpenFile(blankFile('pptx'))}>
            <FileTypeIcon kind="pptx" size={46} />
            <span className="op-create-name">演示</span>
          </button>
          <button className="op-create-tile" type="button" onClick={() => onOpenFile(blankFile('md'))}>
            <FileTypeIcon kind="md" size={46} />
            <span className="op-create-name">Markdown</span>
          </button>
        </div>
      </section>

      <section className="op-section">
        <div className="op-section-head"><h2>最近文件</h2></div>
        <FileTable
          files={real && real.length > 0 ? real.map((x) => x.file) : files}
          onOpenFile={openFromTable}
          onToast={onToast}
        />
      </section>

      {drafting && (
        <DraftOverlay onDone={() => { setDrafting(false); onOpenFile(draftFile()) }} />
      )}
    </>
  )
}

/** 每日洞察卡（首屏主角）：AI 说的一段话，打字机逐字出现。 */
function InsightCard({
  onAct, onToast,
}: {
  onAct: (a: InsightAction) => void
  onToast: (msg: string) => void
}) {
  const [nonce, setNonce] = useState(0)
  const shown = useTypewriter(dailyInsight.text, nonce)
  const done = shown.length >= dailyInsight.text.length

  return (
    <section className="op-insight-card">
      <div className="op-insight-head">
        <span className="op-insight-ai"><Sparkles size={15} /></span>
        <span className="op-insight-title">
          <strong>每日洞察</strong>
          <span>{dailyInsight.source} · {dailyInsight.updatedLabel}</span>
        </span>
        <button
          className="op-insight-refresh"
          type="button"
          onClick={() => { setNonce((n) => n + 1); onToast('已重新生成今日洞察') }}
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>
      <p className="op-insight-body">
        {shown}
        {!done && <span className="op-insight-caret" />}
      </p>
      <div className="op-insight-foot">
        <span className="op-insight-actions">
          {dailyInsightActions.map((a) => (
            <button className="op-insight-act" key={a.label} type="button" onClick={() => onAct(a)}>
              {a.label} <ChevronRight size={12} />
            </button>
          ))}
        </span>
        <span className="op-insight-speaker">—— {dailyInsight.speaker} · 你的工作台助理</span>
      </div>
    </section>
  )
}

function DraftOverlay({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (step < draftingSteps.length) {
      const t = setTimeout(() => setStep((s) => s + 1), 700)
      return () => clearTimeout(t)
    }
    const t = setTimeout(onDone, 450)
    return () => clearTimeout(t)
  }, [step, onDone])

  return (
    <div className="op-draft-overlay">
      <div className="op-draft-modal">
        <div className="op-draft-spinner" />
        <div className="op-draft-title">正在用你的记忆起草…</div>
        <ol className="op-draft-steps">
          {draftingSteps.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'doing' : ''}>
              <span className="op-step-dot" />
              {s}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
