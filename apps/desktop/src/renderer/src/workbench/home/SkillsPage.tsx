import { Plus, RotateCw, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { describeSkillError } from '../../../../shared/skill-error-message'

import { useLocale } from '@/i18n/LocaleContext'

import { workbenchToast } from '../shell/toast'
import { Modal } from '../ui/modal'
import { Button, EmptyState, IconButton, PageHeader, Spinner, Toggle } from '../ui/primitives'
import { DeleteSkillDialog } from './SkillDialogs'
import { HomeNote } from './parts'
import {
  toSkillDetail,
  useSkills,
  type SkillDetailView,
  type SkillItemView,
} from './useSkills'
import './skills.css'

/**
 * 主页「技能」页：Agent 可以调用的成熟能力。
 *
 * 布局对齐原型（office-proto SkillsView）：卡片网格 + 每卡一个开关 + 末尾
 * 虚线「新增技能」卡。与原型（静态卡片 + 本地假开关）的区别是数据与开关
 * 都走网关：清单来自真实目录，开关落 `agent_skill_states` 并立即重装运行时。
 *
 * 「新增技能」不走弹窗：点按钮直接弹系统选择器（文件夹或 zip 压缩包均可，
 * 内容必须包含 SKILL.md，校验在网关侧）。
 *
 * 子 Agent 技能在数据层（useSkills）就已隐藏，这里只会出现内置与自定义技能。
 */

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function SkillsPage() {
  const { t } = useLocale()
  const { state, reload, pending, setEnabled, importDirectory, removeSkill } = useSkills()
  const [detailId, setDetailId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillItemView | null>(null)

  const skills = state.status === 'ready' ? state.value.skills : []
  const counts = state.status === 'ready' ? state.value.counts : { total: 0, enabled: 0 }

  const toggle = useCallback((skill: SkillItemView, next: boolean) => {
    void setEnabled(skill.id, next)
      .then(() => {
        workbenchToast(next
          ? t('workbench:home.skills.enabledNamed', { name: skill.name })
          : t('workbench:home.skills.disabledNamed', { name: skill.name }))
      })
      .catch((error: unknown) => {
        workbenchToast(t('workbench:home.skills.toggleFailed', {
          name: skill.name,
          reason: error instanceof Error ? error.message : t('workbench:home.skills.retryLater'),
        }))
      })
  }, [setEnabled, t])

  /** 「新增技能」：直接弹系统选择器（文件夹或 zip），SKILL.md 校验在网关侧。 */
  const startImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const imported = await importDirectory()
      if (imported) workbenchToast(t('workbench:home.skills.imported'))
    } catch (error) {
      workbenchToast(describeSkillError(error))
    } finally {
      setImporting(false)
    }
  }, [importDirectory, importing, t])

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title={t('workbench:home.skills.title')}
        actions={(
          <Button variant="primary" size="sm" icon={<Plus size={13} />} disabled={importing} onClick={() => { void startImport() }}>
            {importing ? t('workbench:home.skills.importing') : t('workbench:home.skills.add')}
          </Button>
        )}
      />

      {state.status === 'error' ? (
        <EmptyState
          icon={<Sparkles size={18} />}
          title={t('workbench:home.skills.loadFailed')}
          action={(
            <Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={reload}>
              {t('workbench:home.common.retry')}
            </Button>
          )}
        />
      ) : state.status === 'loading' ? (
        <div className="wb-home-state"><Spinner /> {t('workbench:home.skills.reading')}</div>
      ) : skills.length === 0 ? (
        <HomeNote>
          {t('workbench:home.skills.emptyNote')}
          <Button variant="secondary" size="sm" icon={<Plus size={12} />} disabled={importing} onClick={() => { void startImport() }}>
            {importing ? t('workbench:home.skills.importing') : t('workbench:home.skills.add')}
          </Button>
        </HomeNote>
      ) : (
        <div className="wb-skills-grid">
          {skills.map((skill) => (
            <div key={skill.id} className="wb-skills-card" data-disabled={!skill.enabled || undefined}>
              <button
                type="button"
                className="wb-skills-card-main"
                onClick={() => setDetailId(skill.id)}
                title={t('workbench:home.skills.viewDetailTitle')}
              >
                <span className="wb-skills-card-name">{skill.name}</span>
                <span className="wb-skills-card-desc">
                  {skill.description || t('workbench:home.skills.noDescription')}
                </span>
              </button>
              <div className="wb-skills-card-foot">
                <span className="wb-skills-card-state">{skill.enabled ? t('workbench:home.skills.enabled') : t('workbench:home.skills.disabled')}</span>
                <div className="wb-skills-card-side">
                  {/* 只有自定义技能能删：内置技能是应用包内的发布物。 */}
                  {skill.ownerKind === 'user' ? (
                    <IconButton
                      size="sm"
                      tone="danger"
                      label={t('workbench:home.skills.deleteNamed', { name: skill.name })}
                      icon={<Trash2 size={13} />}
                      onClick={() => setDeleteTarget(skill)}
                    />
                  ) : null}
                  <Toggle
                    checked={skill.enabled}
                    busy={pending.includes(skill.id)}
                    onChange={(next) => toggle(skill, next)}
                    label={skill.enabled
                      ? t('workbench:home.skills.disableNamed', { name: skill.name })
                      : t('workbench:home.skills.enableNamed', { name: skill.name })}
                  />
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="wb-skills-card wb-skills-card-add" disabled={importing} onClick={() => { void startImport() }}>
            <Plus size={20} aria-hidden="true" />
            <span>{importing ? t('workbench:home.skills.importing') : t('workbench:home.skills.add')}</span>
          </button>
        </div>
      )}

      <SkillDetailModal skillId={detailId} onClose={() => setDetailId(null)} />

      <DeleteSkillDialog
        skill={deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        onConfirm={async (skill) => {
          await removeSkill(skill.id)
          workbenchToast(t('workbench:home.skills.deletedNamed', { name: skill.name }))
        }}
      />
    </div>
  )
}

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; value: SkillDetailView }
  | { status: 'missing' }

/** 详情弹窗：SKILL.md 全文按原文展示（它就是写给模型读的，不做二次排版）。 */
function SkillDetailModal({ skillId, onClose }: { skillId: string | null; onClose: () => void }) {
  const { t } = useLocale()
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' })

  useEffect(() => {
    if (!skillId) return
    let cancelled = false
    setDetail({ status: 'loading' })
    void Promise.resolve(window.nxcore?.agent?.getSkill?.(skillId))
      .then((raw) => {
        if (cancelled) return
        const value = toSkillDetail(raw)
        setDetail(value ? { status: 'ready', value } : { status: 'missing' })
      })
      .catch(() => {
        if (!cancelled) setDetail({ status: 'missing' })
      })
    return () => { cancelled = true }
  }, [skillId])

  const skill = detail.status === 'ready' ? detail.value : null

  return (
    <Modal
      open={skillId !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      size="lg"
      title={skill?.name ?? t('workbench:home.skills.detailTitle')}
      footer={(
        <Button variant="secondary" size="sm" onClick={onClose}>{t('workbench:home.common.close')}</Button>
      )}
    >
      {detail.status === 'loading' ? (
        <div className="wb-home-state"><Spinner /> {t('workbench:home.skills.detailLoading')}</div>
      ) : detail.status === 'missing' ? (
        <HomeNote>{t('workbench:home.skills.detailMissing')}</HomeNote>
      ) : skill ? (
        <div className="wb-skills-detail">
          <div className="wb-skills-detail-meta">
            <span>{skill.enabled ? t('workbench:home.skills.enabled') : t('workbench:home.skills.disabled')}</span>
            <span>{formatBytes(skill.bytes)}</span>
            <span>{t('workbench:home.skills.path', { path: skill.path })}</span>
          </div>
          {skill.description ? <p className="wb-skills-detail-desc">{skill.description}</p> : null}
          <pre className="wb-skills-prompt">{skill.prompt || t('workbench:home.skills.emptyPrompt')}</pre>
        </div>
      ) : null}
    </Modal>
  )
}
