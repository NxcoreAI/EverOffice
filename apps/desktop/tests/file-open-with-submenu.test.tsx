// @vitest-environment happy-dom
/**
 * 行内菜单的「用其他应用打开」子菜单（资料/产物/所有文件共用的 FileItemMenu）。
 *
 * 锁三件事：
 * ① 菜单打开时加载系统文件关联，子菜单入口出现在菜单里；
 * ② 子菜单列出关联应用、默认项标注「（默认）」，点选后调用 openWithApplication；
 * ③ 系统没有可用外部应用时整项不渲染，菜单保持原样。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '@/shared/ingest'

import { catalogToOfficeFile, type RealOfficeFile } from '../src/renderer/src/office-proto/data'
import { FileItemMenu } from '../src/renderer/src/workbench/workspace/fileItemViews'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PNG_ICON = 'data:image/png;base64,AAAA'
const APPS = [
  { id: '/Applications/WorkBuddy.app', name: 'WorkBuddy.app', default: true, icon: PNG_ICON },
  { id: '/Applications/WPS Office.app', name: 'WPS Office.app', default: false, icon: PNG_ICON },
]

function catalog(over: Partial<FileCatalogDto> & { id: string }): FileCatalogDto {
  return {
    originalName: `${over.id}.docx`,
    displayName: null,
    sharedTitle: over.id,
    sourceKind: 'agent-generated',
    sourceLabel: 'Agent 生成',
    relativePath: null,
    provider: null,
    bytes: 2048,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: `hash-${over.id}`,
    currentVersionId: null,
    parsed: true,
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  }
}

function realFile(over: Partial<FileCatalogDto> & { id: string }): RealOfficeFile {
  const item = catalogToOfficeFile(catalog(over))
  if (!item) throw new Error('文件不可映射')
  return item
}

const FILE = realFile({ id: 'file-1', originalName: '季度报告.docx' })

let container: HTMLDivElement
let root: Root | null = null
let listApplications: ReturnType<typeof vi.fn>
let openWithApplication: ReturnType<typeof vi.fn>

async function flush(rounds = 8, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  listApplications = vi.fn(() => Promise.resolve(APPS))
  openWithApplication = vi.fn(() => Promise.resolve({ openedWith: 'external' }))
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    files: { listApplications, openWithApplication },
  }
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove())
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

async function renderMenu(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <FileItemMenu
        item={FILE}
        actions={{ onOpen: () => undefined, onError: () => undefined }}
      />,
    )
  })
  await flush()
}

async function openParentMenu(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="季度报告.docx 的操作"]')
  if (!trigger) throw new Error('行菜单触发按钮未渲染')
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await flush()
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

describe('FileItemMenu / 用其他应用打开', () => {
  it('菜单里出现子菜单入口并列出关联应用，点选后按应用打开', async () => {
    await renderMenu()
    await openParentMenu()

    const subTrigger = document.body.querySelector<HTMLElement>('[role="menuitem"]')
    const texts = menuItems().map((element) => element.textContent ?? '')
    expect(texts.some((text) => text.includes('用其他应用打开'))).toBe(true)

    const entry = menuItems().find((element) => (element.textContent ?? '').includes('用其他应用打开'))
    expect(entry).toBeTruthy()
    await act(async () => {
      entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const appItems = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((element) => (element.textContent ?? '').includes('WorkBuddy.app')
        || (element.textContent ?? '').includes('WPS Office.app'))
    expect(appItems.length).toBeGreaterThanOrEqual(2)
    expect(appItems[0]!.textContent).toContain('默认')

    const selected = appItems.find((element) => (element.textContent ?? '').includes('WPS Office.app'))
    await act(async () => {
      selected!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(openWithApplication).toHaveBeenCalledWith('file-1', '/Applications/WPS Office.app')
    expect(subTrigger).toBeTruthy()
  })

  it('没有可用外部应用时不渲染该子菜单', async () => {
    listApplications.mockImplementation(() => Promise.resolve([]))
    await renderMenu()
    await openParentMenu()

    expect(menuItems().some((element) => (element.textContent ?? '').includes('用其他应用打开'))).toBe(false)
    expect(menuItems().some((element) => (element.textContent ?? '').includes('在侧栏打开'))).toBe(true)
  })
})