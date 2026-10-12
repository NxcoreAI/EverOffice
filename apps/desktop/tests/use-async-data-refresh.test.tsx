import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { useAsyncData } from '../src/renderer/src/components/pages/memory/useMemoryData'

function HookProbe({ loader, onResult }: {
  loader: () => Promise<{ value: number }>
  onResult: (state: { data: { value: number } | null; loading: boolean }) => void
}) {
  const state = useAsyncData(loader)
  onResult(state)
  return null
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useAsyncData refresh 可等待并返回成败', () => {
  it('成功刷新 resolve(true)，数据更新', async () => {
    let value = 1
    const loader = vi.fn(() => Promise.resolve({ value }))
    let latest: { data: { value: number } | null; loading: boolean; refresh?: () => Promise<boolean> } | null = null
    const onResult = (state: typeof latest) => { latest = state }
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(<HookProbe loader={loader} onResult={onResult} />)
      await flush()
    })
    expect(latest!.data).toEqual({ value: 1 })

    value = 2
    let outcome: boolean | null = null
    await act(async () => {
      outcome = await latest!.refresh!()
      await flush()
    })
    expect(outcome).toBe(true)
    expect(latest!.data).toEqual({ value: 2 })
    expect(latest!.loading).toBe(false)
    renderer!.unmount()
  })

  it('失败刷新 resolve(false)', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('[memory_error] boom')))
    let latest: { refresh?: () => Promise<boolean> } | null = null
    const onResult = (state: { refresh?: () => Promise<boolean> }) => { latest = state }
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(<HookProbe loader={loader} onResult={onResult} />)
      await flush()
    })

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await latest!.refresh!()
      await flush()
    })
    expect(outcome).toBe(false)
    renderer!.unmount()
  })
})
