// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import { WorkspaceEnglishNameDialog } from '../src/renderer/src/workbench/ui/WorkspaceEnglishNameDialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE: AgentWorkspace = {
  id: 'ws-1',
  name: '毕设',
  nameEn: null,
  description: null,
  goals: [],
  path: null,
  kind: 'custom',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
})

async function renderDialog(workspace: AgentWorkspace, onSave: (nameEn: string | null) => Promise<boolean>) {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <WorkspaceEnglishNameDialog
        open
        onOpenChange={() => undefined}
        workspace={workspace}
        onSave={onSave}
      />,
    )
  })
}

function buttonByText(text: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text) as HTMLButtonElement
}

describe('WorkspaceEnglishNameDialog', () => {
  it('保存英文别名', async () => {
    const onSave = vi.fn(async () => true)
    await renderDialog(WORKSPACE, onSave)

    const input = document.querySelector<HTMLInputElement>('.ui-modal-body input')
    expect(input).not.toBeNull()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'Graduation Project')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { buttonByText('保存').click() })

    expect(onSave).toHaveBeenCalledWith('Graduation Project')
  })

  it('清空输入保存 null，回落到原名', async () => {
    const onSave = vi.fn(async () => true)
    await renderDialog({ ...WORKSPACE, nameEn: 'Graduation Project' }, onSave)

    const input = document.querySelector<HTMLInputElement>('.ui-modal-body input')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, '   ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { buttonByText('保存').click() })

    expect(onSave).toHaveBeenCalledWith(null)
  })
})
