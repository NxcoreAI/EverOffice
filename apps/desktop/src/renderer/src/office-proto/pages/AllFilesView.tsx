import React, { useEffect, useState } from 'react'

import { type OfficeFile, fetchRealFiles, files, openRealFile, type RealOfficeFile } from '../data'
import { FileTable, PageHead } from './parts'

/** 所有文件：有真实文件库时显示真实文件（打开走内置 Office 预览），
 *  无桥/为空时回退原型 mock 列表。 */
export function AllFilesView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [real, setReal] = useState<RealOfficeFile[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchRealFiles().then((items) => {
      if (!cancelled) setReal(items)
    })
    return () => { cancelled = true }
  }, [])

  const open = (f: OfficeFile) => {
    const entry = real?.find((x) => x.file.id === f.id)
    if (!entry) { onOpenFile(f); return }
    void openRealFile(entry.catalog).then((opened) => {
      if (!opened) onOpenFile(f)
    })
  }

  const shown = real && real.length > 0 ? real.map((x) => x.file) : files
  return (
    <>
      <PageHead title="所有文件" hint={`共 ${shown.length} 个文件`} />
      <FileTable files={shown} onOpenFile={open} onToast={onToast} />
    </>
  )
}
