import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '../../../../shared/ingest'

vi.mock('@/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/LocaleContext')>()
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

const HASH_JPG = 'a1'.repeat(32)
const HASH_HEIC = 'c3'.repeat(32)

function catalogFile(overrides: Partial<FileCatalogDto> & Pick<FileCatalogDto, 'id' | 'originalName'>): FileCatalogDto {
  return {
    displayName: null,
    sharedTitle: overrides.originalName,
    sourceKind: 'manual-upload',
    sourceLabel: '手动上传',
    relativePath: null,
    provider: null,
    bytes: 1024,
    dataType: 'image',
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: 'b2'.repeat(32),
    currentVersionId: null,
    parsed: true,
    updatedAt: '2026-10-17T09:24:00.000Z',
    ...overrides,
  }
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve() })
}

describe('FilesPage', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  let keydownHandlers: Array<(event: { key: string }) => void>

  beforeEach(() => {
    vi.resetModules()
    keydownHandlers = []
    const files = [
      catalogFile({ id: 'img-1', originalName: '007 一杯咖啡与一本书的相遇 — 副本.jpeg', contentHash: HASH_JPG }),
      catalogFile({ id: 'heic-1', originalName: '现场照片.heic', contentHash: HASH_HEIC }),
      catalogFile({ id: 'doc-1', originalName: '超长文件名文档示例用于验证单行截断.pdf', dataType: 'document', sourceKind: 'manual-upload' }),
    ]
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: (event: { key: string }) => void) => {
        if (type === 'keydown') keydownHandlers.push(handler)
      },
      removeEventListener: vi.fn(),
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      innerWidth: 1400,
      nxcore: {
        platform: 'darwin',
        files: { list: vi.fn(async () => ({ items: files, total: files.length })) },
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
  })

  it('图片分类卡显示素材协议封面，heic 回退图标，点击进预览 dialog 且 Esc 关闭', async () => {
    const { FilesPage } = await import('./FilesPage')
    await act(async () => {
      renderer = TestRenderer.create(<FilesPage onNavigate={() => undefined} onOpenOfficePreview={() => undefined} />)
    })
    await flush()

    const imageCategoryCard = renderer.root.findAll((node) =>
      typeof node.props.className === 'string' && node.props.className.startsWith('file-category-card')
        && node.props.className.includes('teal'))[0]
    expect(imageCategoryCard).toBeTruthy()
    await act(async () => { imageCategoryCard.props.onClick() })
    await flush()

    const detail = renderer.root.findAll((node) => node.props?.['data-file-id'] === 'img-1')[0]
    const mainButton = detail.findByProps({ className: 'file-document-main has-cover' })
    const cover = mainButton.findByProps({ className: 'file-document-cover' })
    expect(cover.props.src).toBe(`everroom-material://${HASH_JPG}`)
    expect(cover.props.alt).toBe('007 一杯咖啡与一本书的相遇 — 副本.jpeg')

    const heicDetail = renderer.root.findAll((node) => node.props?.['data-file-id'] === 'heic-1')[0]
    expect(() => heicDetail.findByProps({ className: 'file-document-cover' })).toThrow()
    expect(heicDetail.findByProps({ className: 'file-document-main' }).props.className).not.toContain('has-cover')

    await act(async () => { mainButton.props.onClick() })
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.findByProps({ className: 'image-preview-figure' }).props.src).toBe(`everroom-material://${HASH_JPG}`)

    await act(async () => { keydownHandlers.forEach((handler) => handler({ key: 'Escape' })) })
    expect(renderer.root.findAllByType('section').some((node) => node.props.className?.includes('image-preview-dialog'))).toBe(false)
  })

  it('冷启动一次性渲染完整目录：剩余页拉完之前不发布只含第一页的列表', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      catalogFile({ id: `page1-${index}`, originalName: `第一批-${index}.pdf`, dataType: 'document' }))
    const secondPage = Array.from({ length: 3 }, (_, index) =>
      catalogFile({ id: `page2-${index}`, originalName: `第二批-${index}.pdf`, dataType: 'document' }))

    let releaseSecondPage!: () => void
    const secondPageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve })
    const list = vi.fn(async (_limit: number, offset: number) => {
      if (offset === 0) return { items: firstPage, total: 203 }
      await secondPageGate
      return { items: secondPage, total: 203 }
    })
    ;(window as unknown as { nxcore: { files: { list: typeof list } } }).nxcore.files.list = list

    const { FilesPage } = await import('./FilesPage')
    await act(async () => {
      renderer = TestRenderer.create(<FilesPage onNavigate={() => undefined} onOpenOfficePreview={() => undefined} />)
    })
    await flush()

    // `file-category-card-head` / `-foot` 也以该前缀开头：只取可点击的分类大卡本身。
    const categoryCardsOf = () => renderer.root.findAll((node) =>
      typeof node.props?.className === 'string'
      && node.props.className.startsWith('file-category-card ')
      && typeof node.props.onClick === 'function')

    // 第一页已到、剩余页仍挂起：停在占位态，不渲染任何分类卡（旧行为这里已经展示 200 条，随后被整份目录替换）
    expect(categoryCardsOf()).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.props?.className === 'source-loading').length).toBeGreaterThan(0)

    await act(async () => {
      releaseSecondPage()
      await Promise.resolve()
    })
    await flush()

    const categoryCards = categoryCardsOf()
    expect(categoryCards).toHaveLength(1)
    await act(async () => { categoryCards[0]!.props.onClick() })
    await flush()

    const renderedIds = renderer.root.findAll((node) => node.props?.['data-file-id'])
      .map((node) => node.props['data-file-id'] as string)
    expect(renderedIds).toHaveLength(203)
    expect(new Set(renderedIds).size).toBe(203)
  })
})
