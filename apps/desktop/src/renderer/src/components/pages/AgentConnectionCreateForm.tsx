import { useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { AgentAccessScopesDto, AgentConnectionDto } from '../../../../shared/agent-access'
import { useLocale } from '@/i18n/LocaleContext'

const TOOLS: Array<{ value: string; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
  { value: 'cherry-studio', label: 'Cherry Studio' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'generic', label: '通用 MCP' },
]

const READ_CAPABILITIES = [
  { value: 'read_metadata', label: '发现元信息' },
  { value: 'search', label: '搜索' },
  { value: 'read_conversations', label: '精读会话' },
  { value: 'read_documents', label: '精读文档' },
  { value: 'read_files', label: '读取源文件' },
  { value: 'read_rules', label: '读取规则' },
]

const WRITE_CAPABILITIES = [
  { value: 'write_session', label: '回写会话与结果' },
  { value: 'write_candidates', label: '提交记忆/Wiki/偏好候选' },
  { value: 'register_files', label: '登记文件' },
]

export function AgentConnectionCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (connection: AgentConnectionDto, token: string) => void
}) {
  const { t } = useLocale()
  const [name, setName] = useState('')
  const [tool, setTool] = useState('claude-code')
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(READ_CAPABILITIES.map((item) => item.value)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const create = async () => {
    if (!name.trim() || capabilities.size === 0) return
    setBusy(true); setError(null)
    // Room 已不存在：连接作用域恒为「整个工作区」（roomIds='all'），
    // writebackRoomId 在网关 schema 里仍是必填可空字段，故显式传 null。
    const scopes: AgentAccessScopesDto = {
      roomIds: 'all',
      capabilities: [...capabilities],
      writebackRoomId: null,
    }
    try {
      const created = await window.nxcore!.agentAccess.createConnection({ name: name.trim(), tool, scopes })
      onCreated(created.connection, created.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('surface:agentConnections.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="agent-connections-form">
    <div className="agent-connections-form-header">
      <h2>{t('surface:agentConnections.newConnection')}</h2>
      <button className="icon-button" onClick={onCancel} aria-label={t('surface:agentConnections.cancel')}>
        <X aria-hidden="true" />
      </button>
    </div>

    <div className="agent-connections-form-grid">
      <label>
        {t('surface:agentConnections.name')}
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t('surface:agentConnections.tool')}
        <select value={tool} onChange={(event) => setTool(event.target.value)}>
          {TOOLS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>

      <fieldset className="agent-connections-form-wide">
        <legend>{t('surface:agentConnections.capabilities')}</legend>
        <div className="agent-connections-capabilities">
          {[...READ_CAPABILITIES, ...WRITE_CAPABILITIES].map((item) => (
            <label key={item.value} className="agent-connections-check">
              <input
                type="checkbox"
                checked={capabilities.has(item.value)}
                onChange={() => setCapabilities((current) => toggle(current, item.value))}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>

    {error ? <div className="agent-connections-error" role="alert">{error}</div> : null}

    <div className="agent-connections-form-actions">
      <button className="secondary-button" onClick={onCancel}>{t('surface:agentConnections.cancel')}</button>
      <button className="primary-button" disabled={busy || !name.trim() || capabilities.size === 0} onClick={() => void create()}>
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
        {t('surface:agentConnections.create')}
      </button>
    </div>
  </section>
}
