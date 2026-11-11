import { ExternalLink } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'
import { MenuItem, MenuSub, MenuSubContent, MenuSubTrigger } from '@/workbench/ui/menu'

import { FileApplicationIcon } from './FileApplicationIcon'
import { useFileApplications } from './useFileApplications'

/**
 * 菜单里的「用其他应用打开」子菜单：给资料/产物/所有文件等行内 `⋯` 菜单复用。
 * 关联列表在菜单打开时查询（主进程按扩展名缓存）；没有可用应用时整项不渲染，
 * 菜单布局与原来一致。
 */
export function FileOpenWithSubmenu({
  fileId, onError, label,
}: {
  fileId: string
  /** 失败提示出口；缺省用全局 toast。 */
  onError?: (message: string) => void
  /** 菜单项文案（中文界面直接传固定文案；缺省用通用 i18n 文案）。 */
  label?: string
}) {
  const { t } = useLocale()
  const { applications, busy, openWith } = useFileApplications(fileId, onError)
  if (!applications || applications.length === 0) return null

  return (
    <MenuSub>
      <MenuSubTrigger icon={<ExternalLink size={14} aria-hidden="true" />} disabled={busy}>
        {label ?? t('surface:files.openWithSubmenu')}
      </MenuSubTrigger>
      <MenuSubContent>
        {applications.map((application) => (
          <MenuItem
            key={application.id}
            icon={<FileApplicationIcon application={application} size={15} />}
            onSelect={() => { void openWith(application) }}
          >
            {application.default
              ? t('surface:files.openWithDefaultLabel', { app: application.name })
              : application.name}
          </MenuItem>
        ))}
      </MenuSubContent>
    </MenuSub>
  )
}