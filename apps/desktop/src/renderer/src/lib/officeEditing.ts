/**
 * 哪些 Office 文件可以直接用内置编辑器打开（保存回填文件库版本链）。
 *
 * 只覆盖 OOXML：旧版 .doc/.xls/.ppt 是经 LibreOffice 转换出的工作副本，
 * 编辑后保存会产出与扩展名不符的字节，因此保持只读预览。
 */
const EDITABLE_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'xlsm', 'pptx'])

export function isEditableOfficeDocument(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return false
  return EDITABLE_OFFICE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase())
}
