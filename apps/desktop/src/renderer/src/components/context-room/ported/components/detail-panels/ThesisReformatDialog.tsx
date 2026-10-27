import { LoaderCircle, Trash2, Upload, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import { showToast } from '@/state/toast';
import { describeThesisError } from '../../../../../../../shared/thesis-error-message';
import { ReferenceDialog } from '../shared';

interface ThesisCardRow {
  id: string;
  sourceName: string;
  updatedAt: string;
  /** 模版来源文件（资料区文件 id）；直传解析的模版为 null。 */
  sourceFileEntryId?: string | null;
}

/** v2 映射报告（网关 reformat 返回）。 */
interface MappingReport {
  conservation?: { matched: number; unmatched: number; total: number };
  report?: { matchedChapters: number; appendedChapters: number; unmatchedBlocks: number; notes: string[] };
  assignments?: Array<{ headingText: string; rule: string; confidence: number; notes: string[] }>;
  needsReview?: Array<{ chapterText: string }>;
  gaps?: string[];
}

type Phase = 'idle' | 'parsing' | 'reformatting';

/**
 * 产物区「排版工具」对话框：给选中的 Word 产物套用论文模版。
 *
 * 用户视角只要两步：导入 Word 模版 → 选中文档自动按模版重排。模版解析与装订
 * 都是 1–5 分钟的长任务，所以全程显示当前阶段（否则用户会以为「没执行」——
 * 这是此前 AI 页签面板最被诟病的一点）。
 *
 * 模版来源两路：
 * - 上传新的 .docx（解析成功后**立即**开排，贴合「导入模版后直接排版」的预期）
 * - 复用本 Room 已有格式卡（选择后手动「开始排版」）
 */
export function ThesisReformatDialog({
  open,
  roomId,
  target,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  roomId: string;
  /** 待排版的产物（fileId = 文件库条目 id）。 */
  target: { fileId: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onDone?: (fileName: string) => void;
}) {
  const { t } = useLocale();
  const [cards, setCards] = useState<ThesisCardRow[] | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<string[]>([]);
  const [report, setReport] = useState<MappingReport | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);

  const busy = phase !== 'idle';

  const loadCards = useCallback(() => {
    const api = window.nxcore?.thesisFormat;
    if (!api) {
      setCards([]);
      return;
    }
    void api.listCards(roomId)
      .then((rows) => {
        setCards(rows);
        setSelectedCardId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        setCards([]);
        setError(describeThesisError(err instanceof Error ? err.message : String(err)));
      });
  }, [roomId]);

  // 每次打开重置：上一份文档的进度/错误不能带到下一次。
  useEffect(() => {
    if (!open) return;
    setError(null);
    setGaps([]);
    setPhase('idle');
    setCards(null);
    setSelectedCardId(null);
    setReport(null);
    loadCards();
  }, [open, loadCards]);

  const reformat = useCallback(async (cardId: string) => {
    const api = window.nxcore?.thesisFormat;
    if (!api || !target) return;
    setPhase('reformatting');
    setError(null);
    try {
      const outcome = await api.reformat(roomId, target.fileId, cardId);
      // 产物库/资料区各自监听该事件刷新清单（新文件由网关入库）。
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      showToast({
        title: t('contextRoom:thesisFormat.reformatDone'),
        message: outcome.originalName,
      });
      onDone?.(outcome.originalName);
      setPhase('idle');
      // v2 有映射报告就留在弹窗里给用户看（守恒/规则/未匹配/待复核）；
      // 老卡片路径没有报告，按原行为直接关闭。
      const mapping = (outcome.report ?? null) as MappingReport | null;
      if (mapping) setReport(mapping);
      else onOpenChange(false);
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)));
      setPhase('idle');
    }
  }, [onDone, onOpenChange, roomId, t, target]);

  /**
   * 删除「模版文件」——保留格式卡（用户明确要求：卡继续可用于排版）。
   * 只对来自资料区的模版生效；直传解析的模版没有库内文件，按钮不出现。
   */
  const deleteTemplateFile = async (row: ThesisCardRow) => {
    const fileId = row.sourceFileEntryId;
    const files = window.nxcore?.files;
    if (!fileId || !files) return;
    if (!window.confirm(t('contextRoom:thesisFormat.deleteTemplateFileConfirm', { name: row.sourceName }))) return;
    setDeletingFileId(row.id);
    setError(null);
    try {
      await files.delete(fileId);
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      showToast({ title: t('contextRoom:thesisFormat.deleteTemplateFileDone'), message: row.sourceName });
      loadCards();
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingFileId(null);
    }
  };

  const uploadTemplate = useCallback(async () => {
    const api = window.nxcore?.thesisFormat;
    if (!api) {
      setError(describeThesisError('thesis_bridge_unavailable'));
      return;
    }
    setError(null);
    setGaps([]);
    setPhase('parsing');
    try {
      // wordOnly：产物区入口只收 Word（用户预期「可导入 word 格式」）。
      const meta = await api.pickAndSet(roomId, { wordOnly: true });
      if (meta.canceled) {
        setPhase('idle');
        return;
      }
      setSelectedCardId(meta.cardId);
      setGaps(meta.factGaps ?? []);
      loadCards();
      if (!meta.cardId) {
        setPhase('idle');
        setError(describeThesisError('thesis_format_card_missing'));
        return;
      }
      // 导入模版的下一步就是排版：不让用户再点一次（长任务最怕「点了没反应」）。
      await reformat(meta.cardId);
    } catch (err: unknown) {
      setError(describeThesisError(err instanceof Error ? err.message : String(err)));
      setPhase('idle');
    }
  }, [loadCards, reformat, roomId]);

  return (
    <ReferenceDialog
      open={open}
      onOpenChange={(next) => {
        // 长任务进行中不允许关闭：解析/装订在后端继续跑，关掉只会让用户以为失败。
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={t('contextRoom:thesisFormat.toolDialogTitle')}
      contentClassName="context-room-thesis-dialog-shell"
    >
      <div className="context-room-action-confirm">
        <header>
          <h2>{t('contextRoom:thesisFormat.toolDialogTitle')}</h2>
        </header>
        <div className="context-room-action-confirm-body">
          <p>
            {target
              ? t('contextRoom:thesisFormat.toolDialogDesc', { name: target.name })
              : t('contextRoom:thesisFormat.toolDialogNoTarget')}
          </p>
          <p className="context-room-action-confirm-note">{t('contextRoom:thesisFormat.toolDialogNote')}</p>

          {cards && cards.length > 0 ? (
            <div className="context-room-thesis-dlg-cards" role="radiogroup" aria-label={t('contextRoom:thesisFormat.panelTitle')}>
              <p className="context-room-thesis-dlg-cards-title">{t('contextRoom:thesisFormat.existingTemplates')}</p>
              {cards.map((row) => (
                <div className="context-room-thesis-dlg-row" key={row.id}>
                  <label className="context-room-thesis-dlg-option" data-selected={selectedCardId === row.id || undefined}>
                    <input
                      type="radio"
                      name="thesis-template"
                      value={row.id}
                      checked={selectedCardId === row.id}
                      disabled={busy}
                      onChange={() => setSelectedCardId(row.id)}
                    />
                    <span>{row.sourceName}</span>
                  </label>
                  {row.sourceFileEntryId ? (
                    <button
                      type="button"
                      className="context-room-thesis-dlg-del"
                      title={t('contextRoom:thesisFormat.deleteTemplateFileTip')}
                      aria-label={t('contextRoom:thesisFormat.deleteTemplateFile')}
                      disabled={busy || deletingFileId === row.id}
                      onClick={() => void deleteTemplateFile(row)}
                    >
                      {deletingFileId === row.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {gaps.length > 0 ? (
            <p className="context-room-thesis-dlg-gaps" role="status">
              {t('contextRoom:thesisFormat.gapsNotice', { gaps: gaps.join('；') })}
            </p>
          ) : null}

          {busy ? (
            <p className="context-room-thesis-dlg-phase" role="status" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {phase === 'parsing'
                ? t('contextRoom:thesisFormat.phaseParsing')
                : t('contextRoom:thesisFormat.phaseReformatting')}
            </p>
          ) : null}

          {report ? (
            <div className="context-room-thesis-dlg-report" role="status">
              <p className="context-room-thesis-dlg-report-head">
                {t('contextRoom:thesisFormat.reportTitle', {
                  matched: report.conservation?.matched ?? 0,
                  total: report.conservation?.total ?? 0,
                })}
              </p>
              {(report.conservation?.unmatched ?? 0) > 0 ? (
                <p className="context-room-thesis-dlg-report-warn">
                  {t('contextRoom:thesisFormat.reportUnmatched', { count: report.conservation?.unmatched ?? 0 })}
                </p>
              ) : null}
              {report.assignments && report.assignments.length > 0 ? (
                <ul className="context-room-thesis-dlg-report-list">
                  {report.assignments.map((entry, index) => (
                    <li key={`${entry.headingText}-${index}`} data-low={entry.confidence < 0.7 || undefined}>
                      <span className="rule">{entry.rule.replace(/^R\d-/, '')}</span>
                      <span className="text">{entry.headingText}</span>
                      <span className="conf">{Math.round(entry.confidence * 100)}%</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {report.needsReview && report.needsReview.length > 0 ? (
                <p className="context-room-thesis-dlg-report-warn">
                  {t('contextRoom:thesisFormat.reportNeedsReview', { count: report.needsReview.length })}
                </p>
              ) : null}
              {report.gaps && report.gaps.length > 0 ? (
                <ul className="context-room-thesis-dlg-report-gaps">
                  {report.gaps.slice(0, 6).map((gap) => <li key={gap}>{gap}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="context-room-move-error" role="alert">{error}</p> : null}
        </div>
        <footer>
          <button type="button" className="context-room-ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('contextRoom:resource.cancel')}
          </button>
          <button
            type="button"
            className="context-room-ghost context-room-thesis-dlg-upload"
            disabled={busy || !target}
            onClick={() => void uploadTemplate()}
          >
            <Upload aria-hidden="true" className="size-4" />
            {t('contextRoom:thesisFormat.uploadWordTemplate')}
          </button>
          <button
            type="button"
            className="context-room-primary"
            disabled={busy || !target || !selectedCardId}
            onClick={() => {
              if (!selectedCardId) return;
              void reformat(selectedCardId);
            }}
          >
            <Wand2 aria-hidden="true" className="size-4" />
            {busy ? t('contextRoom:thesisFormat.reformatting') : t('contextRoom:thesisFormat.startReformat')}
          </button>
        </footer>
      </div>
    </ReferenceDialog>
  );
}