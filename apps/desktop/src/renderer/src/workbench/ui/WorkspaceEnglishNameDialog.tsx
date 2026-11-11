import React, { useEffect, useState } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import { useLocale } from '@/i18n/LocaleContext'

import { Modal } from './modal'
import { Button, TextInput } from './primitives'

/**
 * 项目空间英文展示名：仅影响英文界面，中文界面始终显示原名。
 * 留空保存 = 清空别名，英文界面回落到原名（默认工作区仍显示 Default workspace）。
 */
export function WorkspaceEnglishNameDialog({
  open,
  onOpenChange,
  workspace,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: AgentWorkspace | null
  onSave: (nameEn: string | null) => Promise<boolean> | boolean | void
}) {
  const { t } = useLocale()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(workspace?.nameEn ?? '')
    setBusy(false)
  }, [open, workspace?.id, workspace?.nameEn])

  const save = async () => {
    if (!workspace || busy) return
    setBusy(true)
    try {
      const ok = await onSave(draft.trim() || null)
      if (ok !== false) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next) }}
      title={t('workbench:workspaceAlias.title')}
      description={workspace ? t('workbench:workspaceAlias.description', { name: workspace.name }) : undefined}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('workbench:workspaceAlias.cancel')}
          </Button>
          <Button variant="primary" onClick={() => { void save() }} disabled={busy || !workspace}>
            {t('workbench:workspaceAlias.save')}
          </Button>
        </>
      )}
    >
      <label className="ui-field">
        <span className="ui-field-label">{t('workbench:workspaceAlias.label')}</span>
        <TextInput
          autoFocus
          value={draft}
          maxLength={120}
          placeholder={workspace?.name ?? t('workbench:workspaceAlias.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            }
          }}
        />
      </label>
      <p className="ui-field-hint">{t('workbench:workspaceAlias.hint')}</p>
    </Modal>
  )
}
