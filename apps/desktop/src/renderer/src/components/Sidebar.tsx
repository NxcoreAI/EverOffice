import { Settings } from 'lucide-react'

import { sidebarNavigation, type PageId } from '@/data/navigation'
import { useAccount } from '@/state/AccountContext'
import { useLocale } from '@/i18n/LocaleContext'

/** 侧边栏布局对齐 everoffice 原型：品牌 + 五个一级菜单 + 底部用户条（齿轮进设置）。 */
export function Sidebar({
  activePage,
  onNavigate,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
}) {
  const { t } = useLocale()
  const { account } = useAccount()

  const accountName = account?.authenticated
    ? account.user?.name || account.user?.email || account.user?.phone || t('surface:sidebar.everroomUser')
    : account === null ? t('surface:sidebar.checking') : t('surface:sidebar.localUser')

  return (
    <aside className="sidebar">
      <div className="brand-area">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark" aria-hidden="true">E</div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">EverRoom</span>
            <span className="sidebar-brand-sub">Office</span>
          </div>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label={t('surface:sidebar.mainNavigation')}>
        <div className="nav-items">
          {sidebarNavigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                data-active={String(item.id === activePage)}
                data-nav-tone={item.tone}
                aria-current={item.id === activePage ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <span className="nav-item-icon" aria-hidden="true">
                  <Icon strokeWidth={1.8} />
                </span>
                <span className="nav-item-label">{item.label}</span>
              </button>
            )
          })}
        </div>
      </nav>

      <button type="button" className="account-row" onClick={() => onNavigate('settings')}>
        <span className="account-avatar" aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</span>
        <span className="account-copy">
          <strong>{accountName}</strong>
        </span>
        <span className="account-gear" aria-hidden="true"><Settings size={15} strokeWidth={1.8} /></span>
      </button>
    </aside>
  )
}
