import { useCallback, useEffect, useRef, useState } from 'react'

import type { OfficeFile } from '@/office-proto/data'

import { closeOfficeFile, registerTabCloser } from '../state/store'

export const BUBBLE_MIN_WIDTH = 360
export const BUBBLE_MAX_WIDTH = 720
export const BUBBLE_DEFAULT_WIDTH = 480

export interface BubbleState {
  mode: 'closed' | 'open' | 'minimized'
  width: number
  maximized: boolean
  files: OfficeFile[]
  /** null = 处于「浏览资料与文件」列表态（不挂载编辑器）。 */
  activeFileId: string | null
}

const CLOSED: BubbleState = {
  mode: 'closed',
  width: BUBBLE_DEFAULT_WIDTH,
  maximized: false,
  files: [],
  activeFileId: null,
}

/**
 * 工作空间气泡窗的状态机（组件级，一个工作空间标签一套，多开天然隔离）。
 *
 * 关闭文件/整个气泡前先过主进程脏关闭守卫（保存对话框点取消 → 保留）。
 * 标签关闭时通过 registerTabCloser 把「串行关掉所有文件」注册给 store，
 * 避免关标签直接卸载原生编辑器导致丢改动。
 */
export function useWorkspaceBubble(tabId: string) {
  const [bubble, setBubble] = useState<BubbleState>(CLOSED)
  const bubbleRef = useRef(bubble)
  bubbleRef.current = bubble

  const openFile = useCallback((file: OfficeFile) => {
    setBubble((current) => ({
      ...current,
      mode: 'open',
      files: current.files.some((item) => item.id === file.id)
        ? current.files.map((item) => (item.id === file.id ? file : item))
        : [...current.files, file],
      activeFileId: file.id,
    }))
  }, [])

  /** 打开「资料与文件」浏览态：右侧面板展开、列出文件库；已打开的文件标签保留。 */
  const openBrowser = useCallback(() => {
    setBubble((current) => ({
      ...current,
      mode: 'open',
      maximized: current.mode === 'closed' ? false : current.maximized,
      activeFileId: null,
    }))
  }, [])

  const activateFile = useCallback((fileId: string) => {
    setBubble((current) => {
      if (!current.files.some((item) => item.id === fileId)) return current
      return { ...current, activeFileId: fileId, mode: current.mode === 'closed' ? 'open' : current.mode }
    })
  }, [])

  const closeFile = useCallback(async (fileId: string): Promise<boolean> => {
    const file = bubbleRef.current.files.find((item) => item.id === fileId)
    if (!file) return true
    if (!(await closeOfficeFile(file))) return false
    setBubble((current) => {
      const index = current.files.findIndex((item) => item.id === fileId)
      const files = current.files.filter((item) => item.id !== fileId)
      const activeFileId = current.activeFileId === fileId
        ? (files[Math.min(index, files.length - 1)]?.id ?? null)
        : current.activeFileId
      // 关掉最后一个文件后不收起面板，回到「资料与文件」浏览态，方便继续挑文件。
      return {
        ...current,
        files,
        activeFileId,
        mode: files.length === 0 ? 'open' : current.mode,
      }
    })
    return true
  }, [])

  const closeAll = useCallback(async (): Promise<boolean> => {
    for (const file of [...bubbleRef.current.files]) {
      if (!(await closeOfficeFile(file))) return false
    }
    setBubble((current) => ({
      ...current,
      files: [],
      activeFileId: null,
      mode: 'closed',
      maximized: false,
    }))
    return true
  }, [])

  const close = useCallback(() => {
    void closeAll()
  }, [closeAll])

  const minimize = useCallback(() => {
    setBubble((current) => ({ ...current, mode: 'minimized', maximized: false }))
  }, [])

  const restore = useCallback(() => {
    setBubble((current) => ({ ...current, mode: 'open' }))
  }, [])

  const toggleMaximize = useCallback(() => {
    setBubble((current) => ({ ...current, maximized: !current.maximized }))
  }, [])

  const setWidth = useCallback((width: number) => {
    setBubble((current) => ({
      ...current,
      width: Math.min(BUBBLE_MAX_WIDTH, Math.max(BUBBLE_MIN_WIDTH, width)),
    }))
  }, [])

  useEffect(() => registerTabCloser(tabId, async () => {
    if (bubbleRef.current.mode === 'closed') return true
    return closeAll()
  }), [closeAll, tabId])

  // 切标签/卸载时隐藏原生视图由 NativeEditorHost 的 observer 处理；这里不销毁实例，
  // 只有真正关闭文件或标签时才走脏关闭守卫。

  return {
    bubble,
    openBrowser,
    openFile,
    activateFile,
    closeFile,
    closeAll,
    close,
    minimize,
    restore,
    toggleMaximize,
    setWidth,
  }
}
