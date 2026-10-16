import * as Popover from '@radix-ui/react-popover';
import { BookText, Eye, LoaderCircle, Trash2, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import { showToast } from '@/state/toast';
import { ReferenceDialog } from '../shared';
import { readThesisCardView, ThesisFullPaper, ThesisMiniPaper } from './ThesisCardPreview';
import type { ContextRoomRecord } from '../../types';

interface ThesisCardRow {
  id: string;
  sourceName: string;
  updatedAt: string;
  card: Record<string, unknown>;
}

/**
 * 论文排版入口：docx 产物行的「排版」按钮 + 格式卡选择面板。
 * 面板是排版流程的第一站——有卡选卡、无卡引导上传，不再直接弹文件管理器。
 */
export function ThesisReformatControl({
  room,
  fileId,
  fileName,
  busy,
  onBusyChange,
}: {
  room: ContextRoomRecord;
  fileId: string;
  fileName: string;
  /** 全局装订锁（同屏其他 docx 行的排版按钮同时禁用）。 */
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<ThesisCardRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removingCardId, setRemovingCardId] = useState<string | null>(null);
  const [previewCard, setPreviewCard] = useState<Record<string, unknown> | null>(null);

  const refresh = useCallback(() => {
    const thesisFormat = window.nxcore?.thesisFormat;
    if (!thesisFormat) return;
    void thesisFormat.listCards(room.id)
      .then((rows) => setCards(rows.map(({ id, sourceName, updatedAt, card }) => ({ id, sourceName, updatedAt, card }))))
      .catch(() => setCards([]));
  }, [room.id]);

  useEffect(() => {
    if (!open) return;
    setCards(null);
    refresh();
    return window.nxcore?.thesisFormat?.onCardChanged(() => refresh());
  }, [open, refresh]);

  const uploadTemplate = async () => {
    const thesisFormat = window.nxcore?.thesisFormat;
    if (!thesisFormat) return;
    setUploading(true);
    try {
      const meta = await thesisFormat.pickAndSet(room.id);
      if (!meta.canceled) {
        showToast({ title: t('contextRoom:thesisFormat.templateReady'), message: meta.sourceName });
      }
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:thesisFormat.templateParseFailed'),
        message: `${error instanceof Error ? error.message : String(error)}。${t('contextRoom:thesisFormat.templateParseFailedHint')}`,
        variant: 'error',
      });
    } finally {
      setUploading(false);
    }
  };

  const removeCard = async (cardId: string, sourceName: string) => {
    const thesisFormat = window.nxcore?.thesisFormat;
    if (!thesisFormat) return;
    setRemovingCardId(cardId);
    try {
      await thesisFormat.removeCard(room.id, cardId);
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:thesisFormat.removeFailed'),
        message: `${sourceName}：${error instanceof Error ? error.message : String(error)}`,
        variant: 'error',
      });
    } finally {
      setRemovingCardId(null);
    }
  };

  const reformatWithCard = async (cardId: string) => {
    const thesisFormat = window.nxcore?.thesisFormat;
    if (!thesisFormat) return;
    onBusyChange(true);
    setOpen(false);
    try {
      const outcome = await thesisFormat.reformat(room.id, fileId, cardId);
      showToast({ title: t('contextRoom:thesisFormat.reformatDone'), message: outcome.originalName });
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:thesisFormat.reformatFailed'),
        message: `${fileName}：${error instanceof Error ? error.message : String(error)}`,
        variant: 'error',
      });
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="context-room-artifact-reformat"
            aria-label={t('contextRoom:thesisFormat.reformat')}
            title={t('contextRoom:thesisFormat.reformat')}
            disabled={busy}
          >
            {busy
              ? <LoaderCircle aria-hidden="true" className="is-spinning" />
              : <Wand2 aria-hidden="true" />}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="context-room-thesis-panel"
            side="left"
            align="center"
            sideOffset={8}
            collisionPadding={12}
            aria-label={t('contextRoom:thesisFormat.panelTitle')}
          >
            <p className="context-room-thesis-panel-title">{t('contextRoom:thesisFormat.panelTitle')}</p>
            {cards === null ? (
              <div className="context-room-thesis-panel-loading" aria-live="polite">
                <LoaderCircle aria-hidden="true" className="is-spinning" />
              </div>
            ) : cards.length === 0 ? (
              <div className="context-room-thesis-panel-empty">
                <p>{t('contextRoom:thesisFormat.panelEmpty')}</p>
                <button
                  type="button"
                  className="context-room-thesis-upload"
                  disabled={uploading}
                  onClick={() => void uploadTemplate()}
                >
                  {uploading
                    ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                    : <BookText aria-hidden="true" />}
                  {t('contextRoom:thesisFormat.uploadTemplate')}
                </button>
              </div>
            ) : (
              <>
                <div className="context-room-thesis-cards" role="list">
                  {cards.map((row) => (
                    <div className="context-room-thesis-card" key={row.id} role="listitem">
                      <button
                        type="button"
                        className="context-room-thesis-card-main"
                        disabled={busy}
                        onClick={() => void reformatWithCard(row.id)}
                        aria-label={t('contextRoom:thesisFormat.useFormat', { name: row.sourceName })}
                        title={t('contextRoom:thesisFormat.useFormat')}
                      >
                        <ThesisMiniPaper card={readThesisCardView(row.card)} />
                        <span className="context-room-thesis-card-body">
                          <b>{row.sourceName}</b>
                          <time>{new Date(row.updatedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</time>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="context-room-thesis-card-act"
                        aria-label={t('contextRoom:thesisFormat.previewFormat')}
                        title={t('contextRoom:thesisFormat.previewFormat')}
                        onClick={() => setPreviewCard(row.card)}
                      >
                        <Eye aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="context-room-thesis-card-act is-danger"
                        aria-label={t('contextRoom:thesisFormat.removeFormat')}
                        title={t('contextRoom:thesisFormat.removeFormat')}
                        disabled={removingCardId === row.id}
                        onClick={() => void removeCard(row.id, row.sourceName)}
                      >
                        {removingCardId === row.id
                          ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                          : <Trash2 aria-hidden="true" />}
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="context-room-thesis-upload"
                  disabled={uploading}
                  onClick={() => void uploadTemplate()}
                >
                  {uploading
                    ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                    : <BookText aria-hidden="true" />}
                  {t('contextRoom:thesisFormat.uploadTemplate')}
                </button>
              </>
            )}
            <Popover.Arrow className="context-room-document-delete-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {previewCard ? (
        <ReferenceDialog
          open
          onOpenChange={(nextOpen) => { if (!nextOpen) setPreviewCard(null); }}
          title={t('contextRoom:thesisFormat.previewFormat')}
          contentClassName="context-room-thesis-preview-dialog"
        >
          <ThesisFullPaper card={readThesisCardView(previewCard)} />
        </ReferenceDialog>
      ) : null}
    </>
  );
}
