import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '../src/shared/ingest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      setLocale: vi.fn(),
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
      formatNumber: (value: number) => value.toLocaleString('zh-CN'),
      formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => (
        new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
      ),
    }),
  }
})

const HASH_PPTX = 'd4'.repeat(32)

function agentOfficeFile(): FileCatalogDto {
  return {
    id: 'agent-pptx-1',
    originalName: '季度汇报.pptx',
    displayName: null,
    sharedTitle: '季度汇报',
    sourceKind: 'agent-generated',
    sourceLabel: 'Agent 生成',
    relativePath: null,
    provider: null,
    bytes: 2048,
    dataType: 'slides',
    agentCategory: 'document',
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: HASH_PPTX,
    currentVersionId: null,
    parsed: true,
    updatedAt: '2026-10-17T09:24:00.000Z',
  }
}

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await Promise.resolve() })
}

describe('FilesPage Agent artifacts', () => {
  let renderer: TestRenderer.ReactTestRenderer
  const list = vi.fn()
  const openOriginal = vi.fn()
  const onOpenOfficePreview = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    list.mockResolvedValue({ items: [agentOfficeFile()], total: 1 })
    openOriginal.mockResolvedValue({
      openedWith: 'office',
      instanceId: 'agent-pptx-1',
      kind: 'slides',
      title: '季度汇报.pptx',
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      innerWidth: 1400,
      nxcore: {
        platform: 'darwin',
        files: { list, openOriginal },
        ingest: { listEvents: vi.fn(async () => ({ items: [], total: 0 })) },
      },
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
    })
  })

  afterEach(() => {
    act(() => { renderer.unmount() })
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('opens Agent-generated Office files through openOriginal instead of bouncing to a Room', async () => {
    const { FilesPage } = await import('../src/renderer/src/components/pages/FilesPage')
    await act(async () => {
      renderer = TestRenderer.create(
        <FilesPage onNavigate={() => undefined} onOpenOfficePreview={onOpenOfficePreview} />,
      )
    })
    await flush()

    const categoryCard = renderer.root.findAll((node) =>
      typeof node.props.className === 'string' && node.props.className.startsWith('file-category-card'))[0]
    expect(categoryCard).toBeTruthy()
    await act(async () => { categoryCard.props.onClick() })
    await flush()

    const detail = renderer.root.findAll((node) => node.props?.['data-file-id'] === 'agent-pptx-1')[0]
    expect(detail).toBeTruthy()
    const mainButton = detail.findByProps({ className: 'file-document-main' })
    await act(async () => { mainButton.props.onClick() })
    await flush()

    // 产物文件与普通文件同样走内置 Office 预览，可编辑时带 editable: true。
    expect(openOriginal).toHaveBeenCalledWith('agent-pptx-1', '季度汇报.pptx', HASH_PPTX, { editable: true })
    expect(onOpenOfficePreview).toHaveBeenCalledWith({
      id: 'agent-pptx-1',
      title: '季度汇报.pptx',
      kind: 'slides',
    })
  })
})
