import { Bot, Check, CheckCircle2, FilePlus2, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import {
  type DiscoveredAgent,
  type EnabledAgent,
  type ImportOutcomeView,
  bridgeErrorMessage,
  createLocalId,
  LOCAL_AGENT_STATUS_META,
  mergeEnabledAgents,
  normalizeDiscoveredAgents,
  normalizeImportOutcomes,
  providerLabel,
  readEnabledAgents,
  summarizeImportOutcomes,
  writeEnabledAgents,
} from './agentCatalog'
import { Badge, Button, EmptyState, Spinner, TextInput } from '../ui/primitives'
import { Modal } from '../ui/modal'
import { cn } from '../ui/cn'
import './tools.css'

const MAX_WORKS = 5

interface SetupStep {
  key: string
  title: string
  hint: string
  icon: ReactNode
}

const STEPS: readonly SetupStep[] = [
  {
    key: 'files',
    title: '上传资料',
    hint: '把项目资料导入文件库；文件库是全局的，整个工作台共享。',
    icon: <FilePlus2 size={15} />,
  },
  {
    key: 'agents',
    title: '添加智能体',
    hint: '从本机已发现的 CLI Agent 里挑几个，写进这个空间的启用列表。',
    icon: <Bot size={15} />,
  },
  {
    key: 'works',
    title: '添加工作',
    hint: '先起几个工作，之后在空间里继续补。',
    icon: <Sparkles size={15} />,
  },
]

interface CreatedWork {
  /** 列表 key：真实 sessionId 可能重复（浏览器 mock），渲染用本地 key。 */
  key: string
  sessionId: string
  title: string
  named: boolean
}

/**
 * 新建空间后的三步引导。
 *
 * 真实操作：
 * ① `files.pickAndImport()` 逐文件展示成功/失败
 * ② `agent.discoverLocalAgents()` 多选 → 写入本空间启用列表（localStorage）
 * ③ `agent.createSession({pageLabel:'Agent', roomId:null, workspaceId})` + `updateSession(id,{title})`
 *
 * 「跳过某一步不丢前面结果」的实现：每一步的真实操作在用户点按钮时就已经落库
 * （文件已导入、启用列表已写 localStorage、会话已创建），组件里只累积展示用的结果；
 * 跳过/翻页只决定是否提交「本步尚未点按钮的草稿选择」，绝不会清空前几步已完成的结果。
 * （原型 WsCreateFlow 的 bug 是最后一步「跳过此项」直接用空结果 onDone，这里修掉了。）
 */
export function SetupWizard({ workspace, onDone }: {
  workspace: AgentWorkspace
  onDone: () => void
}) {
  const [step, setStep] = useState(0)

  // ① 资料
  const [imported, setImported] = useState<ImportOutcomeView[]>([])
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // ② 智能体
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([])
  const [discoverLoading, setDiscoverLoading] = useState(true)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [enabledAgents, setEnabledAgents] = useState<EnabledAgent[]>(() => readEnabledAgents(workspace.id))
  const [selection, setSelection] = useState<string[]>([])
  const [agentsAdded, setAgentsAdded] = useState(0)
  const [agentError, setAgentError] = useState<string | null>(null)

  // ③ 工作
  const [workTitle, setWorkTitle] = useState('')
  const [assignee, setAssignee] = useState('self')
  const [works, setWorks] = useState<CreatedWork[]>([])
  const [creatingWork, setCreatingWork] = useState(false)
  const [workError, setWorkError] = useState<string | null>(null)

  const loadDiscovered = useCallback(async () => {
    setDiscoverLoading(true)
    setDiscoverError(null)
    try {
      const bridge = window.nxcore?.agent
      if (!bridge?.discoverLocalAgents) throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
      setDiscovered(normalizeDiscoveredAgents(await bridge.discoverLocalAgents()))
    } catch (error) {
      setDiscovered([])
      setDiscoverError(bridgeErrorMessage(error, '读取本机 Agent 失败，可重试或跳过本步'))
    } finally {
      setDiscoverLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDiscovered()
  }, [loadDiscovered])

  const importSummary = summarizeImportOutcomes(imported)
  const availableAgents = enabledAgents.filter((agent) => agent.enabled)

  const importFiles = async () => {
    setImporting(true)
    setImportError(null)
    try {
      const bridge = window.nxcore?.files
      if (!bridge?.pickAndImport) throw new Error('桌面服务文件接口未就绪，请重启 EverRoom')
      const raw = await bridge.pickAndImport()
      const outcomes = normalizeImportOutcomes(raw)
      if (outcomes.length === 0) {
        setImportError('没有选择文件，或所选文件都不在可导入格式内。可以重试，也可以跳过本步。')
      } else {
        setImported((current) => [...current, ...outcomes])
      }
    } catch (error) {
      setImportError(bridgeErrorMessage(error, '导入失败，可重试或跳过本步'))
    } finally {
      setImporting(false)
    }
  }

  /** 把已勾选的智能体写入本空间启用列表；返回本次新增/刷新的数量。 */
  const commitAgentSelection = (): number => {
    const picked = discovered.filter((agent) => selection.includes(agent.id))
    if (picked.length === 0) return 0
    const next = mergeEnabledAgents(enabledAgents, picked)
    setEnabledAgents(next)
    setSelection([])
    if (!writeEnabledAgents(workspace.id, next)) {
      setAgentError('本机偏好保存失败（浏览器隐私模式或存储被禁用），本次变更只在当前页面生效。')
      return 0
    }
    setAgentError(null)
    setAgentsAdded((current) => current + picked.length)
    return picked.length
  }

  const toggleSelection = (id: string) => {
    setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const createWork = async () => {
    const title = workTitle.trim()
    if (!title) {
      setWorkError('先给工作起个名字，再点「添加工作」。')
      return
    }
    if (works.length >= MAX_WORKS) {
      setWorkError(`一次最多添加 ${MAX_WORKS} 个工作；其它工作可以在空间里继续建。`)
      return
    }
    const bridge = window.nxcore?.agent
    if (!bridge?.createSession) {
      setWorkError('桌面服务 Agent 接口未就绪，请重启 EverRoom')
      return
    }
    setCreatingWork(true)
    setWorkError(null)
    try {
      const session = await bridge.createSession({ pageLabel: 'Agent', roomId: null, workspaceId: workspace.id })
      const sessionId = session?.id
      if (!sessionId) throw new Error('创建工作失败：网关没有返回会话 id')
      // 指派不是后端的会话字段：只能作为标题后缀说明（不改变会话渠道）。
      const assigneeName = enabledAgents.find((agent) => agent.id === assignee && agent.enabled)?.displayName
      const finalTitle = assigneeName ? `${title}（指派给 ${assigneeName}）` : title
      let named = true
      if (bridge.updateSession) {
        try {
          await bridge.updateSession(sessionId, { title: finalTitle })
        } catch {
          named = false
        }
      } else {
        named = false
      }
      setWorks((current) => [...current, { key: createLocalId(), sessionId, title: finalTitle, named }])
      setWorkTitle('')
      if (!named) setWorkError('工作已创建，但命名失败；进入空间后可以在工作列表里重命名。')
    } catch (error) {
      setWorkError(bridgeErrorMessage(error, '创建工作失败，可重试或跳过本步'))
    } finally {
      setCreatingWork(false)
    }
  }

  const isLastStep = step >= STEPS.length - 1

  /** 下一步：先提交本步已点选但未落库的选择，再翻页（最后一步即完成）。 */
  const goNext = () => {
    // 翻页/完成前把「已点选但还没落库」的智能体补提交；跳过本步不提交（原型语义）。
    commitAgentSelection()
    if (isLastStep) {
      onDone()
      return
    }
    setStep(step + 1)
  }

  /** 跳过本步：只放弃本步未提交的草稿选择，前几步已落库的结果原样保留。 */
  const skipStep = () => {
    if (isLastStep) {
      onDone()
      return
    }
    setStep(step + 1)
  }

  // 步骤完成态只算本次引导里真正做成的事（不把空间原有的偏好算成「本步已记录」）。
  const doneFlags = [importSummary.succeeded > 0, agentsAdded > 0, works.length > 0]

  return (
    <Modal
      open
      onOpenChange={() => undefined}
      title={`「${workspace.name}」已创建`}
      description="三步把空间配置好，也可以随时跳过；已完成的结果都会保留。"
      size="lg"
      dismissible={false}
      footer={(
        <>
          <Button variant="ghost" onClick={onDone}>全部跳过</Button>
          <span className="wb-setup-foot-spacer" />
          <Button variant="secondary" onClick={skipStep}>跳过本步</Button>
          <Button variant="primary" icon={isLastStep ? <Check size={14} /> : undefined} onClick={goNext}>
            {isLastStep ? '完成' : '下一步'}
          </Button>
        </>
      )}
    >
      <div className="wb-setup">
        <ol className="wb-setup-steps">
          {STEPS.map((item, index) => {
            const done = doneFlags[index]
            return (
              <li key={item.key} className={cn(index === step && 'is-current', done && 'is-done')}>
                <button
                  type="button"
                  className="wb-setup-step-btn"
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => setStep(index)}
                >
                  <span className="wb-setup-step-icon" aria-hidden="true">
                    {done ? <Check size={14} /> : item.icon}
                  </span>
                  <span className="wb-setup-step-label">{item.title}</span>
                  {done ? <span className="wb-setup-step-state">已记录</span> : null}
                </button>
              </li>
            )
          })}
        </ol>

        {/* 跨步骤结果摘要：跳过/翻页都不会清空，用户随时能看到已经做成了什么。 */}
        <div className="wb-setup-summary" aria-label="本空间进度">
          <span><strong>{importSummary.succeeded}</strong> 份资料</span>
          <span><strong>{enabledAgents.length}</strong> 个智能体</span>
          <span><strong>{works.length}</strong> 项工作</span>
        </div>

        <div className="wb-setup-body">
          <h3 className="wb-setup-step-title">第 {step + 1} 步 · {STEPS[step].title}</h3>
          <p className="wb-setup-step-hint">{STEPS[step].hint}</p>

          {step === 0 ? (
            <section className="wb-setup-section">
              <div className="wb-setup-row">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={importing ? <RefreshCw size={13} /> : <FilePlus2 size={14} />}
                  disabled={importing}
                  onClick={() => { void importFiles() }}
                >
                  {importing ? '导入中…' : imported.length > 0 ? '再导入一批' : '选择文件并导入'}
                </Button>
                {imported.length > 0 ? (
                  <span className="wb-setup-count">
                    成功 {importSummary.succeeded} · 失败 {importSummary.failed}
                    {importSummary.skipped > 0 ? ` · 跳过 ${importSummary.skipped}` : ''}
                  </span>
                ) : null}
              </div>
              {importError ? <div className="wb-tool-error" role="alert">{importError}</div> : null}
              {imported.length > 0 ? (
                <ul className="wb-setup-result-list">
                  {imported.map((outcome, index) => (
                    <li key={`${outcome.filename}-${index}`} className={cn('wb-setup-result', !outcome.ok && 'is-failed')}>
                      <span className="wb-setup-result-icon" aria-hidden="true">
                        {outcome.ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
                      </span>
                      <span className="wb-setup-result-name">{outcome.filename}</span>
                      <span className="wb-setup-result-state">
                        {outcome.ok ? (outcome.skipped ? '已存在/跳过' : '已导入') : (outcome.error ?? '导入失败')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="wb-tool-note">还没有导入资料。文件导入后会进入整个工作台的文件库，可以跳过本步之后补。</div>
              )}
            </section>
          ) : null}

          {step === 1 ? (
            <section className="wb-setup-section">
              {discoverLoading ? (
                <div className="wb-tool-loading"><Spinner /> 正在扫描本机 Agent…</div>
              ) : discoverError ? (
                <div className="wb-setup-row">
                  <div className="wb-tool-error" role="alert">{discoverError}</div>
                  <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => { void loadDiscovered() }}>
                    重试
                  </Button>
                </div>
              ) : discovered.length === 0 ? (
                <EmptyState
                  icon={<Bot size={18} />}
                  title="没有检测到本机 Agent"
                  description="装好 Codex / Claude Code / OpenClaw / OpenCode 后可在空间的「智能体」页添加；现在可以跳过本步。"
                />
              ) : (
                <ul className="wb-agent-picker">
                  {discovered.map((agent) => {
                    const added = enabledAgents.some((entry) => entry.id === agent.id)
                    const checked = selection.includes(agent.id)
                    const meta = LOCAL_AGENT_STATUS_META[agent.status]
                    return (
                      <li key={agent.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          aria-label={`${agent.displayName}${added ? '（已在空间）' : ''}`}
                          disabled={added}
                          className={cn('wb-agent-pick', checked && 'is-checked', added && 'is-added')}
                          onClick={() => toggleSelection(agent.id)}
                        >
                          <span className="wb-agent-pick-check" aria-hidden="true">
                            {checked || added ? <Check size={12} /> : null}
                          </span>
                          <span className="wb-agent-pick-main">
                            <strong>{agent.displayName}</strong>
                            <span>{providerLabel(agent.provider)} · {meta.label}</span>
                          </span>
                          {added ? <Badge tone="neutral">已在空间</Badge> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}

              {agentError ? <div className="wb-tool-error" role="alert">{agentError}</div> : null}

              <div className="wb-setup-row">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Bot size={13} />}
                  disabled={selection.length === 0}
                  onClick={() => commitAgentSelection()}
                >
                  {selection.length > 0 ? `添加到本空间（${selection.length}）` : '添加到本空间'}
                </Button>
                {enabledAgents.length > 0 ? (
                  <span className="wb-setup-count">本空间已启用 {availableAgents.length} 个智能体</span>
                ) : null}
              </div>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="wb-setup-section">
              <div className="wb-setup-work-form">
                <TextInput
                  value={workTitle}
                  aria-label="工作名称"
                  placeholder="例如：整理发布计划"
                  maxLength={120}
                  onChange={(event) => setWorkTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void createWork()
                    }
                  }}
                />
                <label className="wb-setup-assignee">
                  <span>指派给</span>
                  <select
                    className="ui-input wb-setup-select"
                    value={assignee}
                    aria-label="指派给"
                    onChange={(event) => setAssignee(event.target.value)}
                  >
                    <option value="self">我自己</option>
                    {availableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.displayName}</option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Sparkles size={13} />}
                  disabled={creatingWork || works.length >= MAX_WORKS}
                  onClick={() => { void createWork() }}
                >
                  {creatingWork ? '创建中…' : '添加工作'}
                </Button>
              </div>
              <p className="wb-setup-step-hint">
                指派只写进工作标题后缀（当前 API 只能改标题）；最多 {MAX_WORKS} 个，剩余工作进空间后再建。
              </p>
              {workError ? <div className="wb-tool-error" role="alert">{workError}</div> : null}
              {works.length > 0 ? (
                <ul className="wb-setup-result-list">
                  {works.map((work) => (
                    <li key={work.key} className="wb-setup-result">
                      <span className="wb-setup-result-icon" aria-hidden="true"><CheckCircle2 size={14} /></span>
                      <span className="wb-setup-result-name">{work.title}</span>
                      <span className="wb-setup-result-state">{work.named ? '已创建' : '已创建 · 未命名'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="wb-tool-note">还没有创建工作。工作会出现在空间的「计划」看板里，可以跳过本步之后新建。</div>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
