import TestRenderer, { act } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MovedRoomDocument, RoomDocument } from '@nxcore/agent-contract'

// 无 DOM 环境：Radix Portal 不渲染，替换成透传容器只测弹窗内部状态机。
vi.mock('../src/renderer/src/components/context-room/ported/components/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/context-room/ported/components/shared')>()
  return {
    ...actual,
    ReferenceDialog: function MockReferenceDialog({ open, children }: {
      open: boolean
      children: ReactNode
    }) {
      return open ? <div>{children}</div> : null
    },
  }
})

import { MoveDocumentToRoomDialog } from '../src/renderer/src/components/context-room/ported/components/MoveDocumentToRoomDialog'

const document: RoomDocument = {
  id: 'doc-1',
  roomId: 'room-a',
  title: '季度复盘',
  contentJson: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  version: 3,
  status: 'active',
  origin: 'native',
  activeTransactionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const moved: MovedRoomDocument = {
  documentId: 'doc-1',
  fromRoomId: 'room-a',
  toRoomId: 'room-b',
  title: '季度复盘',
  document: { ...document, roomId: 'room-b' },
}

function installWindow() {
  const list = vi.fn().mockResolvedValue({
    rooms: [
      { id: 'room-a', title: '甲房', kind: '项目' },
      { id: 'room-b', title: '乙房', kind: '主题' },
      { id: 'room-c', title: '丙房', kind: '议题' },
    ],
    deletedRooms: [],
    updatedAt: null,
  })
  const move = vi.fn().mockResolvedValue(moved)
  const moveMany = vi.fn().mockResolvedValue({ items: [moved] })
  ;(globalThis as { window?: unknown }).window = {
    nxcore: { contextRooms: { list }, documents: { move, moveMany } },
    localStorage: {
      store: new Map<string, string>(),
      getItem(key: string) {
        return this.store.get(key) ?? null
      },
      setItem(key: string, value: string) {
        this.store.set(key, value)
      },
    },
    dispatchEvent: vi.fn(),
  }
  return { list, move, moveMany }
}

function findButtonWithText(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType('button').find((node) =>
    node.findAllByType('b').some((label) => label.children.join('') === text)
    || node.children.some((child) => typeof child === 'string' && child.includes(text)))
}

describe('移动到其他 Room 弹层', () => {
  beforeEach(() => {
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('列出可迁入 Room、排除源房，选中后按目标房移动', async () => {
    const api = installWindow()
    const onMoved = vi.fn()
    const onOpenChange = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <MoveDocumentToRoomDialog
          open
          onOpenChange={onOpenChange}
          documents={[{ id: document.id, title: document.title, roomId: document.roomId }]}
          onMoved={onMoved}
        />,
      )
    })

    const buttons = renderer!.root.findAllByType('button')
    const target = buttons.find((node) =>
      node.findAllByType('b').some((label) => label.children.join('') === '乙房'))
    expect(target).toBeTruthy()
    // 源房不出现在候选清单里
    expect(buttons.some((node) =>
      node.findAllByType('b').some((label) => label.children.join('') === '甲房'))).toBe(false)

    await act(async () => {
      target!.props.onClick()
    })

    const confirm = renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-primary')
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.props.onClick()
    })

    expect(api.move).toHaveBeenCalledWith('doc-1', 'room-a', 'room-b')
    expect(onMoved).toHaveBeenCalledWith([moved])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('多个产物走批量移动接口', async () => {
    const api = installWindow()
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <MoveDocumentToRoomDialog
          open
          onOpenChange={() => {}}
          documents={[
            { id: 'doc-1', title: '一', roomId: 'room-a' },
            { id: 'doc-2', title: '二', roomId: 'room-a' },
          ]}
        />,
      )
    })

    const target = findButtonWithText(renderer!, '丙房')
    await act(async () => {
      target!.props.onClick()
    })
    const confirm = renderer!.root.findAllByType('button')
      .find((node) => node.props.className === 'context-room-primary')
    await act(async () => {
      confirm!.props.onClick()
    })

    expect(api.moveMany).toHaveBeenCalledWith(['doc-1', 'doc-2'], 'room-a', 'room-c')
    expect(api.move).not.toHaveBeenCalled()
  })
})