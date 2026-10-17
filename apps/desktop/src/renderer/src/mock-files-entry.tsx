// 临时入口:纯浏览器单独挂载 FilesPage(配合 /@mock/nxcore.js),复现页面交互(验证后删除)。
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { FilesPage } from './components/pages/FilesPage'
import './components/agent/AgentPanel.css'
import '@/styles/tokens.css'
import './styles.css'

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <FilesPage onNavigate={() => undefined} onOpenOfficePreview={() => undefined} />
  </LocaleProvider>,
)
