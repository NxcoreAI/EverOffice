/** @vitest-environment happy-dom */
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { createContextRoomFixture } from './context-room-fixture'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { ArtifactLibraryPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ArtifactLibraryPane'
import type { RoomDocument } from '@nxcore/agent-contract'

const nativeDocument: RoomDocument = {
  id: 'doc-artifact-1',
  roomId: 'room-test',
  title: '季度总结',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  contentSchemaVersion: 1,
  version: 2,
  status: 'active',
  origin: 'native',
  activeTransactionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

function renderArtifactLibraryWith(backendDocuments: RoomDocument[]) {
  return TestRenderer.create(
    <ArtifactLibraryPane
      room={createContextRoomFixture()}
      backendDocuments={backendDocuments}
      trashedDocuments={[]}
      selectedId={null}
      onSelect={() => {}}
      onCreateDocument={vi.fn().mockResolvedValue(undefined)}
      onDeleteDocument={() => Promise.resolve()}
      onRestoreDocument={() => Promise.resolve()}
      onDeleteDocumentPermanently={() => Promise.resolve()}
    />,
  )
}

function renderArtifactLibrary() {
  return TestRenderer.create(
    <ArtifactLibraryPane
      room={createContextRoomFixture()}
      backendDocuments={[]}
      trashedDocuments={[]}
      selectedId={null}
      onSelect={() => {}}
      onCreateDocument={vi.fn().mockResolvedValue(undefined)}
      onDeleteDocument={() => Promise.resolve()}
      onRestoreDocument={() => Promise.resolve()}
      onDeleteDocumentPermanently={() => Promise.resolve()}
    />,
  )
}

describe('产物库：文件导入入口只在新建产物弹层内', () => {
  it('产物库没有独立的“从文件系统导入”按钮（避免与弹层内导入重复）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibrary()
    })
    const buttons = renderer!.root.findAllByType('button')
    expect(buttons.some((node) => node.props.className === 'context-room-resource-add-file')).toBe(false)
    expect(buttons.some((node) => (node.props['aria-label'] ?? '').includes('从文件系统导入'))).toBe(false)
    // 弹层关闭时隐藏的 markdown 输入不挂载（它随 Popover 内容渲染）
    expect(renderer!.root.findAllByProps({ className: 'context-room-document-import-input' })).toHaveLength(0)
  })

  it('工具条保留“新建产物”入口（弹层内含导入本地 Markdown）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibrary()
    })
    const newArtifact = renderer!.root.findAllByType('button')
      .find((node) => node.props['aria-label'] === '新建产物')
    expect(newArtifact).toBeTruthy()
  })
})

describe('产物库：产物操作菜单与多选整理', () => {
  it('每个产物行都有 ⋯ 操作菜单入口（移动/删除收纳其中）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibraryWith([nativeDocument])
    })
    const more = renderer!.root.findAllByType('button')
      .filter((node) => node.props.className === 'context-room-resource-more')
    expect(more).toHaveLength(1)
    // 行内不再常驻独立删除钮（删除收进 ⋯ 菜单）
    expect(renderer!.root.findAllByType('button')
      .some((node) => node.props.className === 'context-room-resource-delete')).toBe(false)
  })

  it('工具条右侧动作组同时容纳多选与新建产物（不被挤成竖排）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibrary()
    })
    const actions = renderer!.root.findAllByProps({ className: 'context-room-artifact-toolbar-actions' })
    expect(actions).toHaveLength(1)
    const buttons = actions[0]!.findAllByType('button')
    expect(buttons.some((node) => node.props.className === 'context-room-artifact-new')).toBe(true)
    expect(buttons.some((node) => node.props.className === 'context-room-artifact-select-toggle')).toBe(true)
  })

  it('多选模式勾选产物后批量移动入口可用', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibraryWith([nativeDocument])
    })
    const toggle = renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-artifact-select-toggle')
    expect(toggle).toBeTruthy()
    await act(async () => {
      toggle!.props.onClick()
    })

    const checkbox = renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-artifact-check')
    expect(checkbox?.props['aria-checked']).toBe(false)
    await act(async () => {
      checkbox!.props.onClick()
    })
    expect(renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-artifact-check')?.props['aria-checked']).toBe(true)
    const moveSelected = renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-artifact-selection-move')
    expect(moveSelected?.props.disabled).toBe(false)
  })
})
