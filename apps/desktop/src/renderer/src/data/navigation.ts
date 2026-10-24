import type { LucideIcon } from 'lucide-react'
import {
  Building2,
  FileText,
  FolderOpen,
  FolderSync,
  Home,
  ListTodo,
  PlugZap,
  Settings,
  FilePenLine,
} from 'lucide-react'

export type PageId = 'home' | 'office' | 'office-document' | 'docs' | 'sources' | 'files' | 'schedules' | 'agent-connections' | 'settings'

export interface NavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
  tone: 'blue' | 'cyan' | 'green' | 'indigo' | 'orange' | 'slate'
}

export interface NavigationSection {
  id: string
  label: string
  items: NavigationItem[]
}

export const navigationSections: NavigationSection[] = [
  {
    id: 'core',
    label: 'surface:navigation.coreWork',
    items: [
      { id: 'home', label: 'surface:navigation.home', icon: Home, tone: 'slate' },
      { id: 'docs', label: 'surface:navigation.documents', icon: FileText, tone: 'indigo' },
    ],
  },
  {
    id: 'context',
    label: 'surface:navigation.context',
    items: [
      { id: 'sources', label: 'surface:navigation.sources', icon: FolderSync, tone: 'cyan' },
      { id: 'files', label: 'surface:navigation.files', icon: FolderOpen, tone: 'green' },
    ],
  },
  {
    id: 'execution',
    label: 'surface:navigation.execution',
    items: [
      { id: 'office', label: 'surface:navigation.office', icon: Building2, tone: 'blue' },
      { id: 'schedules', label: 'surface:navigation.schedules', icon: ListTodo, tone: 'orange' },
      { id: 'agent-connections', label: 'surface:navigation.agentConnections', icon: PlugZap, tone: 'indigo' },
    ],
  },
  {
    id: 'system',
    label: 'surface:navigation.system',
    items: [
      { id: 'settings', label: 'surface:navigation.settings', icon: Settings, tone: 'slate' },
    ],
  },
]

const officeDocumentItem: NavigationItem = {
  id: 'office-document',
  label: 'surface:navigation.officeDocument',
  icon: FilePenLine,
  tone: 'indigo',
}

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  [...navigationSections.flatMap((section) => section.items), officeDocumentItem]
    .map((item) => [item.id, item.label])
) as Record<PageId, string>

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  [...navigationSections.flatMap((section) => section.items), officeDocumentItem]
    .map((item) => [item.id, item.icon])
) as Record<PageId, LucideIcon>

const LEGACY_PAGE_LABEL_KEYS: Record<string, string> = {
  '首页': 'surface:navigation.home',
  'Home': 'surface:navigation.home',
  '文档': 'surface:navigation.documents',
  'Documents': 'surface:navigation.documents',
  '数据源': 'surface:navigation.sources',
  'Sources': 'surface:navigation.sources',
  '文件': 'surface:navigation.files',
  'Files': 'surface:navigation.files',
  '办公室': 'surface:navigation.office',
  'Office': 'surface:navigation.office',
  'Agent 状态': 'surface:navigation.office',
  'Agent status': 'surface:navigation.office',
  '设置': 'surface:navigation.settings',
  'Settings': 'surface:navigation.settings',
}

export function pageLabelKey(value: string): string {
  return LEGACY_PAGE_LABEL_KEYS[value] ?? value
}
