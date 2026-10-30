// @vitest-environment happy-dom
/**
 * ReasoningBlock 回归：agent 处理任务时思考过程必须可见，但默认折叠。
 *
 * 1) 有内容才渲染：空思考串不占位（不出现空的折叠头）。
 * 2) 默认折叠：无论运行中还是已完成，<details> 初始 open=false（需求原话「默认折叠」）。
 * 3) 折叠头标签：运行中显示「思考中…」，结束后显示「思考过程 · N 字」。
 * 4) 展开可读：点击 summary 后 open=true，能读到分段后的思考正文。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { ReasoningBlock } from '../src/renderer/src/components/agent/ReasoningBlock'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

function render(element: React.ReactElement): void {
  void act(() => {
    root.render(<LocaleProvider>{element}</LocaleProvider>)
  })
}

function details(): HTMLDetailsElement {
  const element = container.querySelector('details.agent-reasoning')
  expect(element, 'reasoning <details> should be rendered').not.toBeNull()
  return element as HTMLDetailsElement
}

describe('ReasoningBlock', () => {
  it('renders nothing without reasoning content', () => {
    render(<ReasoningBlock active content="   " />)
    expect(container.querySelector('details.agent-reasoning')).toBeNull()
  })

  it('is collapsed by default while the run is active', () => {
    render(<ReasoningBlock active content="先拆解用户的需求，再决定调用哪个工具。" />)
    const block = details()
    expect(block.open).toBe(false)
    expect(block.querySelector('summary')?.textContent).toContain('思考中')
  })

  it('is collapsed by default after the run finished and shows char count', () => {
    render(<ReasoningBlock content={'先拆解需求。'.repeat(3)} />)
    const block = details()
    expect(block.open).toBe(false)
    expect(block.querySelector('summary')?.textContent).toContain('思考过程')
    // 「先拆解需求。」6 字符 × 3 = 18。
    expect(block.querySelector('summary')?.textContent).toMatch(/18\s*字/)
  })

  it('expands on click and exposes paragraph text', () => {
    render(<ReasoningBlock content={'第一段思考。\n\n第二段思考。'} />)
    const block = details()
    void act(() => {
      block.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(block.open).toBe(true)
    const paragraphs = [...block.querySelectorAll('.agent-reasoning-content p')]
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(['第一段思考。', '第二段思考。'])
  })
})
