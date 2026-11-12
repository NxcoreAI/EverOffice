import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import type { FileApplication } from '@/shared/sources'

/** 应用真实图标；取不到（null/加载失败）时退回通用外链图标，不留空位。 */
export function FileApplicationIcon({ application, size }: { application: FileApplication; size: number }) {
  const [failed, setFailed] = useState(false)
  if (!application.icon || failed) {
    return <ExternalLink size={size} aria-hidden="true" className="file-open-with-fallback" />
  }
  return (
    <img
      src={application.icon}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className="file-open-with-icon"
      onError={() => setFailed(true)}
    />
  )
}