import {
  Bot,
  ChevronRight,
  Clock,
  FileCode2,
  FileText,
  Presentation,
  Sparkles,
  Table2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useWorkspaceDocuments } from '@/components/documents/WorkspaceDocumentsProvider'
import { DocTaskCard } from '@/components/docflow/DocTaskCard'
import { startDocFlow } from '@/components/docflow/docFlowRequest'
import { useAccount } from '@/state/AccountContext'
import { useLocale } from '@/i18n/LocaleContext'

import './HomePage.css'

const CREATE_TILES = [
  { id: 'docx', label: '文字文档', icon: FileText, ready: true, docType: 'report' },
  { id: 'xlsx', label: '表格', icon: Table2, ready: false, docType: 'sheet' },
  { id: 'pptx', label: '演示', icon: Presentation, ready: false, docType: 'ppt' },
  { id: 'md', label: 'Markdown', icon: FileCode2, ready: true, docType: 'md' },
] as const

const TEMPLATE_CARDS = [
  { id: 'tpl-weekly', kind: '.docx', name: '周报速成', desc: '用本周材料五分钟出周报', docType: 'report' },
  { id: 'tpl-proposal', kind: '.docx', name: '立项书骨架', desc: '按立项结构搭好骨架再填内容', docType: 'proposal' },
  { id: 'tpl-prd', kind: '.docx', name: 'PRD 模板', desc: '背景、目标、方案、指标一套齐', docType: 'prd' },
] as const

function formatUpdated(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function HomePage({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
}) {
  const { t } = useLocale()
  const { account } = useAccount()
  const { documents, documentsLoading } = useWorkspaceDocuments()
  const [currentHour, setCurrentHour] = useState(() => new Date().getHours())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentHour(new Date().getHours())
    }, 60_000)

    return () => window.clearInterval(timer)
  }, [])

  const greetingKey = currentHour >= 5 && currentHour < 12
    ? 'surface:home.goodMorning'
    : currentHour < 18
      ? 'surface:home.goodAfternoon'
      : 'surface:home.goodEvening'

  const accountName = account?.authenticated
    ? account.user?.name || account.user?.email || 'EverRoom 用户'
    : '本地用户'

  const recentDocuments = useMemo(() => (
    [...documents]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 8)
  ), [documents])

  const openTemplate = (template: (typeof TEMPLATE_CARDS)[number]) => {
    startDocFlow({
      brief: `用「${template.name}」模板：${template.desc}`,
      docType: template.docType,
      audience: '项目组',
      sourceIds: ['s1', 's2', 's3'],
    })
    onNavigate('doc-flow')
  }

  return (
    <section className="workspace-home-surface" data-testid="workspace-home-surface">
      <div className="workspace-home-inner">
        <header className="workspace-home-heading">
          <div>
            <h1>{t(greetingKey)}，{accountName}</h1>
            <p className="workspace-home-sub">说清你要什么，Agent 分步交活，直接拿到一份能交的文件。</p>
          </div>
        </header>

        <DocTaskCard onStart={() => onNavigate('doc-flow')} />

        <section className="workspace-home-section">
          <div className="workspace-home-section-heading">
            <div>
              <h2>新建</h2>
            </div>
          </div>
          <div className="workspace-create-row">
            {CREATE_TILES.map((tile) => {
              const Icon = tile.icon
              return (
                <button
                  key={tile.id}
                  type="button"
                  className="workspace-create-tile"
                  data-ready={tile.ready}
                  onClick={() => {
                    if (tile.id === 'md') {
                      onNavigate('docs')
                      return
                    }
                    startDocFlow({
                      brief: tile.id === 'docx' ? '新建一份文字文档，写清楚主题后开始' : '',
                      docType: tile.docType,
                      audience: '项目组',
                      sourceIds: [],
                    })
                    onNavigate('doc-flow')
                  }}
                  disabled={!tile.ready}
                >
                  <span className="workspace-create-icon" data-kind={tile.id}><Icon strokeWidth={1.8} /></span>
                  <span className="workspace-create-name">{tile.label}</span>
                  {!tile.ready && <span className="workspace-create-soon">即将支持</span>}
                </button>
              )
            })}
          </div>
        </section>

        <section className="workspace-home-section">
          <div className="workspace-home-section-heading">
            <div>
              <h2>最近文件</h2>
            </div>
            <button type="button" className="workspace-home-link" onClick={() => onNavigate('files')}>
              所有文件<ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="workspace-recent-list">
            {documentsLoading && recentDocuments.length === 0 ? (
              <div className="workspace-home-loading-list" aria-busy="true">
                <i /><i /><i />
              </div>
            ) : recentDocuments.length > 0 ? recentDocuments.map((document) => (
              <button
                key={document.id}
                type="button"
                className="workspace-recent-row"
                onClick={() => onNavigate('docs')}
              >
                <FileText aria-hidden="true" strokeWidth={1.8} />
                <span className="workspace-recent-name">
                  <strong>{document.title || t('surface:docs.untitledDocument')}</strong>
                  <small>{t('surface:docs.type.document')}</small>
                </span>
                <span className="workspace-recent-time"><Clock aria-hidden="true" strokeWidth={1.6} />{formatUpdated(document.updatedAt)}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
            )) : (
              <div className="workspace-recent-empty">还没有文件，从上面的任务卡开一份。</div>
            )}
          </div>
        </section>

        <section className="workspace-home-section">
          <div className="workspace-home-section-heading">
            <div>
              <h2>模板</h2>
            </div>
          </div>
          <div className="workspace-tpl-row">
            {TEMPLATE_CARDS.map((template) => (
              <button
                key={template.id}
                type="button"
                className="workspace-tpl-card"
                onClick={() => openTemplate(template)}
              >
                <span className="workspace-tpl-kind">{template.kind}</span>
                <span className="workspace-tpl-name">{template.name}</span>
                <span className="workspace-tpl-desc">{template.desc}</span>
                <span className="workspace-tpl-start"><Sparkles aria-hidden="true" strokeWidth={1.6} />开活</span>
              </button>
            ))}
          </div>
        </section>

        <section className="workspace-home-section">
          <div className="workspace-home-section-heading">
            <div>
              <h2>Agent</h2>
            </div>
          </div>
          <button type="button" className="workspace-agent-strip" onClick={() => onNavigate('office')}>
            <Bot aria-hidden="true" strokeWidth={1.8} />
            <span>看看 Agent 们在干什么 —— 幻灯师、邮差、记录员的实时状态</span>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </section>
      </div>
    </section>
  )
}
