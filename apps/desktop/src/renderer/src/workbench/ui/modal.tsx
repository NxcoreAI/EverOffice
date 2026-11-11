import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import React from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import { cn } from './cn'
import { Button } from './primitives'

export type ModalSize = 'sm' | 'md' | 'lg'

/** Radix Dialog 薄封装：标题/描述/内容/页脚统一排版，弹窗内容由页面提供。 */
export function Modal({
  open, onOpenChange, title, description, children, footer, size = 'md', dismissible = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: ModalSize
  dismissible?: boolean
}) {
  const { t } = useLocale()
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (dismissible || next) onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-modal-overlay" />
        <Dialog.Content
          className={cn('ui-modal', `ui-modal--${size}`)}
          onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (!dismissible) event.preventDefault() }}
        >
          <header className="ui-modal-head">
            <div className="ui-modal-head-text">
              <Dialog.Title className="ui-modal-title">{title}</Dialog.Title>
              {description ? <Dialog.Description className="ui-modal-desc">{description}</Dialog.Description> : null}
            </div>
            {dismissible ? (
              <Dialog.Close asChild>
                <button type="button" className="ui-iconbtn ui-iconbtn--sm" aria-label={t('workbench:ui.close')}>
                  <X size={15} />
                </button>
              </Dialog.Close>
            ) : null}
          </header>
          <div className="ui-modal-body">{children}</div>
          {footer ? <footer className="ui-modal-foot">{footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** 二次确认弹窗（删除工作空间/工作等破坏性操作）。 */
export function ConfirmModal({
  open, onOpenChange, title, description, confirmLabel, cancelLabel,
  danger = true, busy = false, onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
}) {
  const { t } = useLocale()
  const resolvedConfirmLabel = confirmLabel ?? t('workbench:ui.confirm')
  const resolvedCancelLabel = cancelLabel ?? t('workbench:ui.cancel')
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{resolvedCancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{resolvedConfirmLabel}</Button>
        </>
      )}
    >
      <div className="ui-modal-spacer" />
    </Modal>
  )
}
