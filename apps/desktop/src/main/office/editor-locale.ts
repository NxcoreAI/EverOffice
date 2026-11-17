import { app, ipcMain, webContents } from 'electron'

import { desktopGenofficeLang } from '../desktop-locale'

let hooksInstalled = false

/**
 * 把桌面端当前 locale 同步进 GenOffice 编辑器的语言通道。
 *
 * 各 editor main 的语言事实源是 @genoffice/i18n 进程级单例（embed 模式停在
 * 模块初始值 'zh'）。五个 editor 的 registerXxxIpc 都把 `app:get-language`
 * handler 指向共享的 getUiLang()，且 createSlidesView 等在建视图时会**再注册
 * 一次**——时序是 new WebContentsView（触发 web-contents-created）→
 * registerSlidesIpc，即 editor 的注册晚于我们的钩子。所以单次覆盖挡不住：
 * 这里在 web-contents-created 之后分几拍重挂（macrotask 队列排到 editor 的
 * registerSlidesIpc 之后），渲染端 mount 拉 getLanguage 时 handler 已是桌面
 * 语言版。重挂同时广播 `app:language-changed`（各 LocaleProvider 监听的
 * 通道），运行中切 locale 时已打开的编辑器即时热更新。handler 返回值每次
 * 现读 desktop locale，之后新开的编辑器无需再同步。
 *
 * 该通道只被 GenOffice 渲染端调用，覆盖不影响 EverOffice 自身 IPC；
 * "last registration wins" 与 editor 自己的 removeHandler+handle 惯例一致。
 */
export function syncEditorLocale(): void {
  ipcMain.removeHandler('app:get-language')
  ipcMain.handle('app:get-language', () => desktopGenofficeLang())
  const lang = desktopGenofficeLang()
  for (const wc of webContents.getAllWebContents()) {
    wc.send('app:language-changed', lang)
  }
}

/** syncEditorLocale + 建视图后的重挂钩子（幂等安装）。 */
export function ensureEditorLocaleSync(): void {
  syncEditorLocale()
  if (hooksInstalled) return
  hooksInstalled = true
  app.on('web-contents-created', () => {
    // editor 的 registerSlidesIpc 在本事件（new WebContentsView）之后的同一
    // 同步调用栈里跑；连排 3 个 macrotask 保证落在它之后（渲染端 mount 拉
    // getLanguage 还要等页面加载，远晚于此）。
    for (const delay of [0, 20, 100]) {
      const timer = setTimeout(syncEditorLocale, delay)
      timer.unref?.()
    }
  })
}
