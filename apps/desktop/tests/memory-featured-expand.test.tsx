import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryAtomicItemDto } from '../src/shared/memory'

const listAtomicMock = vi.fn()

import { AtomicMemoryPane } from '../src/renderer/src/components/pages/memory/AtomicMemoryPane'

function item(overrides: Partial<MemoryAtomicItemDto> & Pick<MemoryAtomicItemDto, 'id'>): MemoryAtomicItemDto {
  return {
    type: 'episodic',
    content: `记忆 ${overrides.id}`,
    background: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    roomId: null,
    roomTitle: null,
    score: 0,
    ...overrides,
  }
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [child]
    if (child && typeof child === 'object' && 'children' in child) return [textOf(child)]
    return []
  }).join('')
}

/**
 * 精选正文的「三行折叠 + 展开」：
 * 布局量（scrollHeight/clientHeight）在 react-test-renderer 里没有真实布局，
 * 这里用 createNodeMock 给 <p> 造一个"被截断"的节点，驱动真实的溢出判定分支。
 */
async function renderPane(clamped: boolean) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<AtomicMemoryPane />, {
      createNodeMock: (element) => (
        element.type === 'p'
          ? { scrollHeight: clamped ? 240 : 60, clientHeight: 60 }
          : null
      ),
    })
  })
  return renderer
}

describe('AtomicMemoryPane 精选三行折叠', () => {
  beforeEach(() => {
    listAtomicMock.mockReset()
    listAtomicMock.mockResolvedValue({
      items: [
        item({ id: 'memory-long', content: '很长的一条精选记忆内容，'.repeat(40), score: 9 }),
        item({ id: 'memory-short', content: '短记忆', score: 1 }),
      ],
      total: 2,
    })
    ;(globalThis as { window?: unknown }).window = {
      nxcore: { memory: { listAtomic: listAtomicMock, setAtomicRoom: vi.fn() } },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
  })

  it('默认三行折叠，超出时给「展开」，点击后显示全文并可「收起」', async () => {
    const renderer = await renderPane(true)
    const content = renderer.root.findByProps({ className: 'mem-featured-content' })

    // 收起态：没有 data-expanded，正文由 CSS 三行截断
    expect(content.props['data-expanded']).toBeUndefined()
    expect(content.children.join('')).toContain('很长的一条精选记忆内容')

    const toggle = renderer.root.findAllByType('button')
      .find((button) => textOf(button) === '展开')
    expect(toggle).toBeTruthy()
    expect(toggle!.props['aria-expanded']).toBe(false)

    await act(async () => { toggle!.props.onClick() })

    const expanded = renderer.root.findByProps({ className: 'mem-featured-content' })
    expect(expanded.props['data-expanded']).toBe(true)
    const collapse = renderer.root.findAllByType('button')
      .find((button) => textOf(button) === '收起')
    expect(collapse).toBeTruthy()
    expect(collapse!.props['aria-expanded']).toBe(true)

    await act(async () => { collapse!.props.onClick() })
    expect(renderer.root.findByProps({ className: 'mem-featured-content' }).props['data-expanded']).toBeUndefined()
  })

  it('内容只有一行时不显示「展开」入口', async () => {
    const renderer = await renderPane(false)

    expect(renderer.root.findAllByType('button').some((button) => textOf(button) === '展开')).toBe(false)
    expect(renderer.root.findAllByProps({ className: 'mem-featured-toggle' })).toHaveLength(0)
  })
})
