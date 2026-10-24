import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) =>
        actual.translate('zh-CN', message, values),
      locale: 'zh-CN',
    }),
  }
})

const workspaceDocuments = [
  { id: 'doc-1', roomId: null, title: '发布清单', version: 3, origin: 'native', updatedAt: '2026-09-29T10:00:00.000Z' },
  { id: 'doc-2', roomId: null, title: '', version: 1, origin: 'agent', updatedAt: '2026-09-27T09:00:00.000Z' },
]

vi.mock('../src/renderer/src/components/documents/WorkspaceDocumentsProvider', () => ({
  useWorkspaceDocuments: () => ({
    documents: workspaceDocuments,
    documentsLoading: false,
    upsertDocument: () => {},
    refresh: async () => {},
  }),
}))

vi.mock('../src/renderer/src/components/pages/PageHeader', () => ({
  PageHeader: function StubPageHeader(props: { title: string }) {
    return <h1>{props.title}</h1>
  },
}))

import { DocsPage } from '../src/renderer/src/components/pages/DocsPage'

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('')
}

function rowTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByProps({ className: 'doc-row' })
    .map((row) => textOf(row.findByType('strong')))
}

function installWindow() {
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })
}

async function renderDocsPage(focusRequest?: { documentId: string; requestId: number }) {
  installWindow()
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <DocsPage focusRequest={focusRequest ?? null} onNavigate={() => undefined} />,
    )
  })
  return renderer!
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DocsPage 文稿库（工作区清单）', () => {
  it('按更新时间倒序列出工作区文稿，无标题的用兜底文案', async () => {
    const renderer = await renderDocsPage()
    expect(rowTitles(renderer)).toEqual(['发布清单', '无标题文档'])
  })

  it('搜索按标题过滤，命中不到时给出无匹配空态', async () => {
    const renderer = await renderDocsPage()
    const search = renderer.root.findByType('input')
    await act(async () => {
      search.props.onChange({ target: { value: '复盘' } })
    })
    expect(rowTitles(renderer)).toEqual([])
    expect(textOf(renderer.root.findByType('strong'))).toBe('没有匹配的文稿')
  })

  it('Agent 定位请求命中的行带高亮标记', async () => {
    const renderer = await renderDocsPage({ documentId: 'doc-2', requestId: 7 })
    const rows = renderer.root.findAllByProps({ className: 'doc-row' })
    expect(rows[1]!.props['data-focused']).toBe('true')
    expect(rows[0]!.props['data-focused']).toBeUndefined()
  })
})
