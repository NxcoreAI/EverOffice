import { ExternalLink, FolderOpen, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomKnowledgeFileResource } from '@/components/office-editor/types';
import { uiText } from '@/components/office-editor/adapters';

/**
 * 编辑栏里的「无应用内预览」文件占位卡（pdf/图片等非 md 非 Office 资料），
 * 也用作内嵌 Office 预览失败时的回退卡（failureReason/onRetry 由宿主传入）。
 * 文案只陈述事实：预览不可用、可尝试用系统应用打开；
 * 「已交给系统应用」仅在本次真的调用打开成功后才出现，不预设已打开。
 */
export function KnowledgeFileExternalCard({
  resource,
  failureReason,
  onRetry,
}: {
  resource: ContextRoomKnowledgeFileResource;
  /** 内嵌预览失败的真实原因（含主进程报错原文）；缺省表示普通无预览资料。 */
  failureReason?: string | null;
  /** 提供时显示「重试预览」，由宿主重新走打开逻辑。 */
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  const [opening, setOpening] = useState(false);
  // 本次点击是否已真的把原件交给系统应用（失败/未操作时不显示）。
  const [handedToSystem, setHandedToSystem] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const openOriginal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) {
      setOpenError(t('contextRoom:knowledgeFileExternal.fileServiceUnavailable'));
      showToast({
        title: t('contextRoom:knowledgeFileExternal.openFailed'),
        message: t('contextRoom:knowledgeFileExternal.fileServiceUnavailable'),
        variant: 'error',
      });
      return;
    }
    setOpening(true);
    setOpenError(null);
    setHandedToSystem(false);
    try {
      await knowledge.openFile(resource.fileId);
      setHandedToSystem(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('contextRoom:knowledgeFileExternal.openFailed');
      setOpenError(message);
      showToast({
        title: t('contextRoom:knowledgeFileExternal.openFailed'),
        message: cause instanceof Error ? cause.message : undefined,
        variant: 'error',
      });
    } finally {
      setOpening(false);
    }
  };

  const reveal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(resource.fileId);
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgeFileReader.revealFailed'),
        message: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return (
    <div className="context-room-wiki-reader-pane" data-testid="context-room-knowledge-external-card">
      <header>
        <strong title={resource.originalName}>{resource.originalName}</strong>
        <span title={resource.updatedAt}>{`${t(uiText(resource.statusLabel))} · ${resource.sizeLabel}`}</span>
      </header>
      <div className="context-room-external-file-body">
        <p>{t('contextRoom:knowledgeFileExternal.previewUnavailable')}</p>
        {failureReason ? <p role="alert">{failureReason}</p> : null}
        {openError ? <p role="alert">{openError}</p> : null}
        {handedToSystem ? <p role="status">{t('contextRoom:knowledgeFileExternal.handedToSystemApp')}</p> : null}
        <div className="context-room-external-file-actions">
          {onRetry ? (
            <button
              type="button"
              className="context-room-wiki-reveal"
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" />
              {t('contextRoom:knowledgeFileExternal.retryPreview')}
            </button>
          ) : null}
          <button
            type="button"
            className="context-room-wiki-reveal"
            disabled={opening}
            onClick={() => void openOriginal()}
          >
            <ExternalLink aria-hidden="true" />
            {t(opening
              ? 'contextRoom:knowledgeFileExternal.opening'
              : 'contextRoom:knowledgeFileExternal.openWithSystemApp')}
          </button>
          <button
            type="button"
            className="context-room-wiki-reveal"
            onClick={() => void reveal()}
            title={t('contextRoom:knowledgeFileReader.showOriginalInSystemFileManager')}
          >
            <FolderOpen aria-hidden="true" />
            {t('contextRoom:wiki.showOriginal')}
          </button>
        </div>
      </div>
    </div>
  );
}
