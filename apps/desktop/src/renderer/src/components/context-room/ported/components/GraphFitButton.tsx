import { Maximize2 } from 'lucide-react'

import { useLocale } from '../../../../i18n/LocaleContext'
import { cn } from '@/components/office-editor/adapters'

/**
 * 图谱「自适应」浮层按钮。
 *
 * 力导向画布的视口可以自由缩放平移，缩到最小或拖出视野后整张图会看不见；
 * 这颗按钮钉在画布右上角（宿主容器 position: relative），一键把节点整体缩放居中回来。
 * 各图谱只负责传入自己的 fitView 回调。
 */
export function GraphFitButton({
  onFit,
  className,
}: {
  onFit: () => void
  className?: string
}) {
  const { t } = useLocale()
  return (
    <button
      type="button"
      className={cn('context-room-graph-fit', className)}
      aria-label={t('contextRoom:graphs.fitCanvasHint')}
      title={t('contextRoom:graphs.fitToCanvas')}
      onClick={onFit}
    >
      <Maximize2 aria-hidden="true" />
      {t('contextRoom:graphs.fitToCanvas')}
    </button>
  )
}