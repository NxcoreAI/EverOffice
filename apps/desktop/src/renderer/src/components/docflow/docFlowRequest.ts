import { useSyncExternalStore } from 'react'

/**
 * 首页任务卡 → Doc 生成流程页的交接载体（模块级 store，同 embeddedOffice 模式）：
 * 任务卡「开始生成」写入，流程页消费；页面切换卸载组件不丢状态。
 */
export interface DocFlowRequest {
  brief: string
  docType: string
  audience: string
  sourceIds: string[]
  requestId: number
}

let current: DocFlowRequest | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): DocFlowRequest | null {
  return current
}

export function getDocFlowRequest(): DocFlowRequest | null {
  return current
}

export function startDocFlow(request: Omit<DocFlowRequest, 'requestId'>): void {
  current = { ...request, requestId: Date.now() }
  listeners.forEach((listener) => listener())
}

export function useDocFlowRequest(): DocFlowRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot)
}
