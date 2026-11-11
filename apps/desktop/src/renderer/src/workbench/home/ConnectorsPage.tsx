import { Plug, RotateCw } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import { workbenchToast } from '../shell/toast'
import { Button, EmptyState, Spinner } from '../ui/primitives'

type ConnectorsViewProps = { onToast: (message: string) => void }

/**
 * 连接器页：直接复用 `office-proto` 的 `ConnectorsView`（已接真实 nango/agentAuth，
 * 自带页头与分类筛选），这里只提供主页标签的滚动容器，不改组件源码。
 */
export function ConnectorsHost() {
  const { t } = useLocale()
  const [View, setView] = useState<ComponentType<ConnectorsViewProps> | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void import('@/office-proto/pages/ConnectorsView')
      .then((module) => {
        if (!cancelled) setView(() => module.ConnectorsView as ComponentType<ConnectorsViewProps>)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [nonce])

  return (
    <div className="wb-home-scroll is-embed">
      <div className="wb-home-embed-inner">
        {failed ? (
          <EmptyState
            icon={<Plug size={18} />}
            title={t('workbench:home.connectors.loadFailed')}
            description={t('workbench:home.connectors.loadFailedDescription')}
            action={(
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw size={13} />}
                onClick={() => { setView(null); setNonce((value) => value + 1) }}
              >
                {t('workbench:home.common.retry')}
              </Button>
            )}
          />
        ) : View ? (
          <View onToast={workbenchToast} />
        ) : (
          <div className="wb-home-state"><Spinner /> {t('workbench:home.connectors.loading')}</div>
        )}
      </div>
    </div>
  )
}
