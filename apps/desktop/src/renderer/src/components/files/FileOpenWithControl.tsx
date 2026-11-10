import { ChevronDown, FolderOpen } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/workbench/ui/menu'
// 菜单原语样式在 ui.css：工作台壳会引入，但气泡窗/独立 Agent 面板不会，
// 这里显式引入一次，保证两种宿主下菜单外观一致（打包时同一模块会自动去重）。
import '@/workbench/ui/ui.css'

import { FileApplicationIcon } from './FileApplicationIcon'
import { useFileApplications } from './useFileApplications'

import './FileOpenWithControl.css'

/**
 * 文件的「用外部应用打开」分体控件（与 DSH 产物卡同语义）：
 * 主按钮 = 系统默认应用，下拉 = 系统注册的全部打开应用（默认项标注「（默认）」，
 * 文件定位固定排在最后）。关联列表由主进程查 LaunchServices；其他平台返回空，
 * 控件整体不渲染，宿主保留原有打开方式。
 */
export function FileOpenWithControl({
  fileId, fileName, onError, className, compact = false,
}: {
  fileId: string
  fileName: string
  /** 失败提示出口（文件卡复用卡片的 toast；独立使用时缺省走全局 toast）。 */
  onError?: (message: string) => void
  className?: string
  /** 紧凑变体（文件列表行、PPT 卡动作区）：图标按钮 24px。 */
  compact?: boolean
}) {
  const { t } = useLocale()
  const { applications, busy, openWith, reveal } = useFileApplications(fileId, onError)
  if (!applications || applications.length === 0) return null

  const preferred = applications.find((application) => application.default) ?? applications[0]
  if (!preferred) return null
  const hasMenu = applications.length > 1

  const primaryLabel = t('surface:files.openWithTitle', { app: preferred.name, name: fileName })
  const revealLabel = window.nxcore?.platform === 'win32'
    ? t('surface:files.showInFileManager.windows')
    : t('surface:files.showInFileManager')
  const rootClassName = [
    'file-open-with',
    compact ? 'is-compact' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rootClassName} role="group" aria-label={t('surface:files.openWithMenu')}>
      <button
        type="button"
        className="file-open-with-primary"
        title={primaryLabel}
        aria-label={primaryLabel}
        disabled={busy}
        onClick={() => { void openWith(preferred) }}
      >
        <FileApplicationIcon application={preferred} size={compact ? 14 : 16} />
      </button>
      {hasMenu ? (
        <>
          <span className="file-open-with-sep" aria-hidden="true" />
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="file-open-with-more"
                title={t('surface:files.openWithMenu')}
                aria-label={t('surface:files.openWithMenu')}
                aria-haspopup="menu"
                disabled={busy}
              >
                <ChevronDown size={compact ? 11 : 12} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" className="file-open-with-menu">
              {applications.map((application) => (
                <MenuItem
                  key={application.id}
                  icon={<FileApplicationIcon application={application} size={15} />}
                  onSelect={() => { void openWith(application) }}
                >
                  {application.id === preferred.id
                    ? t('surface:files.openWithDefaultLabel', { app: application.name })
                    : application.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                icon={<FolderOpen size={14} aria-hidden="true" />}
                onSelect={() => { void reveal() }}
              >
                {revealLabel}
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      ) : null}
    </div>
  )
}