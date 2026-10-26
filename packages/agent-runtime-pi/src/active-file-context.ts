import type { AgentActiveFileContext } from "@nxcore/agent-contract";

const ACTIVE_FILE_KIND_LABELS: Record<string, string> = {
  docx: "Word 文档",
  spreadsheet: "Excel 表格",
  slides: "PPT 演示文稿",
  pdf: "PDF",
};

/**
 * 运行提示里的「用户正在看哪份 Office 文件」段落。
 *
 * Office 文件是 file_entries，不是文档内核的 activeDocument；这段是 Agent 判断
 * “这份文档”指谁的唯一事实，同时把读取工具（file_read / slides_read）显式点名，
 * 避免模型退回 document_list 去猜工作区里的文稿。
 */
export function buildActiveFileContext(activeFile?: AgentActiveFileContext | null): string | null {
  if (!activeFile) return null;
  const kindLabel = ACTIVE_FILE_KIND_LABELS[activeFile.kind] ?? activeFile.kind;
  return [
    `用户当前正在浏览的 Office 文件：${activeFile.title}（fileId: ${activeFile.fileId}，类型：${kindLabel}${activeFile.editable === false ? "，只读打开" : "，可编辑"}）。`,
    "用户说“这份文档/这个表格/这份 PPT/当前打开的文件”时指的就是它。",
    "回答它的内容前先调用 file_read（省略 fileId 即读取这个当前文件）；不要用 document_list/document_read 去工作区里猜另一篇文稿。",
    activeFile.kind === "slides"
      ? "要修改或按页查看 PPT，改用 slides_read（fileId 省略即当前打开的 PPT）读取大纲与元素 id。"
      : null,
    activeFile.editable === false
      ? "它是只读打开：正文可以读取，但不要承诺修改它。"
      : null,
    "file_read 返回的是最近一次保存到磁盘的版本；用户提到刚改但还没保存的内容时，先请用户保存（⌘S）再读。",
  ].filter((line): line is string => Boolean(line)).join("\n");
}
