import * as Dialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import {
  Clock,
  FileText,
  FolderOpen,
  LayoutGrid,
  Search,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { fetchRealFiles, type RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { HOME_PAGES, relativeTimeLabel, sessionDisplayTitle, workspaceDisplayName } from '../types'
import { Spinner } from '../ui/primitives'
import './palette.css'

/**
 * ⌘K 命令面板：搜索并跳转工作空间 / 工作会话 / 文件库文件 / 主页入口。
 * 数据全部来自已加载的 store 与真实文件库（打开时拉一次最近 40 个文件）。
 */
export function CommandPalette() {
  const { t, locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<RealOfficeFile[] | null>(null)

  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openHome = useWorkbenchStore((state) => state.openHome)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const openFileInWorkspace = useWorkbenchStore((state) => state.openFileInWorkspace)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('everroom:workbench-search', show)
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('everroom:workbench-search', show)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    if (files) return
    void fetchRealFiles(40).then((result) => {
      setFiles(result?.items ?? [])
    })
  }, [files, open])

  const orderedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt)),
    [workspaces],
  )
  const recentSessions = useMemo(
    () => [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [sessions],
  )

  const close = () => setOpen(false)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="wb-palette-overlay" />
        <Dialog.Content className="wb-palette" aria-label={t('workbench:palette.aria')}>
          <Dialog.Title className="wb-palette-title">{t('workbench:palette.title')}</Dialog.Title>
          <Command label={t('workbench:palette.aria')} shouldFilter>
            <div className="wb-palette-input">
              <Search size={15} aria-hidden="true" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t('workbench:palette.placeholder')}
              />
              <kbd>esc</kbd>
            </div>
            <Command.List className="wb-palette-list">
              <Command.Empty className="wb-palette-empty">{t('workbench:palette.empty')}</Command.Empty>

              <Command.Group heading={t('workbench:palette.groupHome')}>
                {HOME_PAGES.map((page) => (
                  <Command.Item
                    key={page.key}
                    value={t('workbench:palette.homeValue', { label: t(page.labelKey) })}
                    onSelect={() => { openHome(page.key); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true"><Clock size={15} /></span>
                    <span className="wb-palette-label">{t('workbench:palette.homeItem', { label: t(page.labelKey) })}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading={t('workbench:palette.groupSpaces')}>
                {orderedWorkspaces.map((workspace) => (
                  <Command.Item
                    key={workspace.id}
                    value={t('workbench:palette.spaceValue', { name: workspaceDisplayName(workspace, locale), path: workspace.path ?? '' })}
                    onSelect={() => { openWorkspaceTab(workspace.id); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true"><LayoutGrid size={15} /></span>
                    <span className="wb-palette-label">{workspaceDisplayName(workspace, locale)}</span>
                    <span className="wb-palette-meta">{workspace.path ?? t('workbench:palette.managedSpace')}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading={t('workbench:palette.groupWorks')}>
                {recentSessions.slice(0, 12).map((session) => {
                  const workspace = workspaces.find((item) => item.id === session.workspaceId)
                  return (
                    <Command.Item
                      key={session.id}
                      value={t('workbench:palette.workValue', { title: sessionDisplayTitle(session, t), workspace: workspace ? workspaceDisplayName(workspace, locale) : '' })}
                      onSelect={() => {
                        if (session.workspaceId) openWorkspaceTab(session.workspaceId, { kind: 'session', sessionId: session.id })
                        close()
                      }}
                    >
                      <span className="wb-palette-icon" aria-hidden="true"><FolderOpen size={15} /></span>
                      <span className="wb-palette-label">{sessionDisplayTitle(session, t)}</span>
                      <span className="wb-palette-meta">
                        {workspace ? workspaceDisplayName(workspace, locale) : t('workbench:palette.workspace')} · {relativeTimeLabel(session.updatedAt, t)}
                      </span>
                    </Command.Item>
                  )
                })}
              </Command.Group>

              <Command.Group heading={t('workbench:palette.groupFiles')}>
                {files === null ? (
                  <div className="wb-palette-loading"><Spinner size={13} /> {t('workbench:palette.loading')}</div>
                ) : files.length === 0 ? (
                  <div className="wb-palette-loading">{t('workbench:palette.noFiles')}</div>
                ) : files.map((item) => (
                  <Command.Item
                    key={item.file.id}
                    value={t('workbench:palette.fileValue', { name: item.file.name, source: item.catalog.sourceLabel })}
                    onSelect={() => { openFileInWorkspace(item.file); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true">
                      <FileTypeIcon kind={item.file.kind} size={17} />
                    </span>
                    <span className="wb-palette-label">{item.file.name}</span>
                    <span className="wb-palette-meta">{item.catalog.sourceLabel}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              {files === null ? null : (
                <Command.Item
                  value={t('workbench:palette.allFiles')}
                  onSelect={() => { openHome('files'); close() }}
                >
                  <span className="wb-palette-icon" aria-hidden="true"><FileText size={15} /></span>
                  <span className="wb-palette-label">{t('workbench:palette.browseAll')}</span>
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
