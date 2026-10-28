import * as Sentry from '@sentry/electron/renderer'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { OfficeProto } from '@/office-proto/OfficeProto'
import '@/styles/tokens.css'
import '@/office-proto/office-proto.css'
import '@/desktop-frame.css'

Sentry.init({ beforeBreadcrumb: () => null })

// 平台标记:desktop-frame.css 据此在 macOS 上隐藏原型的假红绿灯、给系统红绿灯让位
document.documentElement.dataset.desktop = window.desktop?.platform ?? 'darwin'

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <OfficeProto />
    </React.StrictMode>,
  )
}
