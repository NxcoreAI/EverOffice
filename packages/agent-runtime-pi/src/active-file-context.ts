import type { AgentActiveFileContext, AgentOpenFileContext } from "@nxcore/agent-contract";

const ACTIVE_FILE_KIND_LABELS: Record<string, string> = {
  docx: "Word 文档",
  spreadsheet: "Excel 表格",
  slides: "PPT 演示文稿",
  pdf: "PDF",
};

/** 清单上限：页签再多也没必要全塞进提示，取前 20 个足够定位。 */
const OPEN_FILES_PROMPT_LIMIT = 20;

function kindLabel(kind: string): string {
  return ACTIVE_FILE_KIND_LABELS[kind] ?? kind;
}

/**
 * 运行提示里的「用户正在看哪份 Office 文件」段落。
 *
 * Office 文件是 file_entries，不是文档内核的 activeDocument；这段是 Agent 判断
 * “这份文档”指谁的唯一事实，同时把读取工具（file_read / slides_read）显式点名，
 * 避免模型退回 document_list 去猜工作区里的文稿。
 */
export function buildActiveFileContext(activeFile?: AgentActiveFileContext | null): string | null {
  if (!activeFile) return null;
  const kindLabelText = kindLabel(activeFile.kind);
  return [
    `用户当前正在浏览的 Office 文件：${activeFile.title}（fileId: ${activeFile.fileId}，类型：${kindLabelText}${activeFile.editable === false ? "，只读打开" : "，可编辑"}）。`,
    "用户说“这份文档/这个表格/这份 PPT/当前打开的文件”时指的就是它。",
    "回答它的内容前先调用 file_read（省略 fileId 即读取这个当前文件）；不要用 document_list/document_read 去工作区里猜另一篇文稿。",
    activeFile.kind === "slides"
      ? "要修改或按页查看 PPT，改用 slides_read（fileId 省略即当前打开的 PPT）读取大纲与元素 id，再用 slides_edit 改。"
      : null,
    activeFile.kind === "docx"
      ? "要修改这份 Word（改文字/格式、增删段落、插图、水印等）用 word_agent_edit：先 word_agent_read 拿块索引与 HTML/命令规则，再按块索引构造工具调用；office_create 是另建一份新文件，不是修改当前文件。"
      : null,
    activeFile.kind === "spreadsheet"
      ? "要修改这份 Excel 用 sheets_agent_edit：先 sheets_agent_read 拿工作簿上下文与 propose_operations 指南；sheets_create 是另建一份新文件，不是修改当前文件。"
      : null,
    activeFile.editable === false
      ? "它是只读打开：正文可以读取，但不要承诺修改它。"
      : null,
    "file_read 返回的是最近一次保存到磁盘的版本；用户提到刚改但还没保存的内容时，先请用户保存（⌘S）再读。",
    "编辑工具会检查未保存修改：被拒绝时把“先保存再改”告诉用户，保存后重试；文件没打开时请用户先以可编辑方式打开。",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

/**
 * 运行提示里的「工作区当前开了哪些 Office 文件」清单。
 *
 * 只给一份且就是当前文件时不输出（上一条已经说清楚，重复只会占上下文）。
 * fileId 一并给出，用户说“另一个/前面那份”时模型能直接用 file_read 定位。
 */
export function buildOpenFilesContext(
  openFiles?: readonly AgentOpenFileContext[] | null,
  activeFile?: AgentActiveFileContext | null,
): string | null {
  if (!openFiles?.length) return null;
  if (openFiles.length === 1 && (!activeFile || openFiles[0]!.fileId === activeFile.fileId)) return null;
  const listed = openFiles.slice(0, OPEN_FILES_PROMPT_LIMIT);
  return [
    `工作区当前打开着 ${openFiles.length} 个 Office 文件（页签）：`,
    ...listed.map((file, index) => [
      `${index + 1}. 《${file.title}》`,
      `（fileId: ${file.fileId}，${kindLabel(file.kind)}${file.editable === false ? "，只读" : ""}${file.active ? "，正在浏览" : ""}）`,
    ].join("")),
    "用户说“另一个文件/前面那份/都打开的文件”时，按上面的清单定位；file_read 支持传清单里的 fileId 读取任意一份，页签顺序与清单一致。",
  ].join("\n");
}
