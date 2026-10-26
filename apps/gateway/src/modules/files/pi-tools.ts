import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";

/** 单次读取预算：与 document_read 对齐（避免整篇长文进上下文）。 */
export const FILE_READ_DEFAULT_LIMIT = 40_000;
export const FILE_READ_MAX_LIMIT = 80_000;

/** 打开中的文件可能刚被导入：条目落库前短暂轮询，别把「正在导入」报成「不存在」。 */
const ENTRY_WAIT_MS = 3_000;
const ENTRY_POLL_MS = 300;

interface CatalogEntryLike {
  id: string;
  originalName: string;
  displayName: string | null;
  currentVersionId: string | null;
  processingState: string;
}

interface ParsedLike {
  markdown: string;
}

export interface FileReadToolDeps {
  /** 惰性取：filesService 在 create-server 里晚于工具装配创建。 */
  files: () => {
    catalogEntry(fileEntryId: string): CatalogEntryLike | null;
    catalogMarkdownOf(fileEntryId: string): string | null;
    markdownOf(fileId: string): string | null;
  } | null;
  /** 文档理解服务：按版本解析 Office/PDF → Markdown（惰性取，同上）。 */
  understanding: () => {
    markdownForFile(fileEntryId: string): string | null;
    parseVersion(fileEntryId: string, fileVersionId: string): Promise<ParsedLike | null>;
  } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, max);
}

/**
 * `file_read`：读取「用户当前正在浏览的 Office 文件」或显式 fileId 的正文。
 *
 * 为什么需要独立工具：Office 文件是 file_entries（docx/xlsx/pptx/pdf），不是文档
 * 内核里的 documents；document_read 只认 documentId，模型在用户说“这份文档”时
 * 只能去猜工作区里的文稿。本工具用运行上下文里的 activeFile（桌面 main 注入的
 * 焦点页签）兜底 fileId，并用当前版本已解析的 Markdown 作答。
 */
export function createFileReadPiTool(deps: FileReadToolDeps): PiAgentRuntimeTool {
  return {
    name: "file_read",
    label: "读取当前 Office 文件正文",
    description:
      "读取用户当前正在浏览的 Office 文件（Word/Excel/PPT/PDF）或指定 fileId 的正文（Markdown）。"
      + "fileId 省略 = 用户当前打开/浏览的那个文件；回答“这份文档写了什么”之前先调用本工具，"
      + "不要用 document_list/document_read 去猜工作区里的其他文稿。"
      + "读的是最近一次保存到磁盘的版本（未保存的编辑不在其中）；长文按 offset/limit 分页，"
      + "truncated/nextOffset 标明是否还有后续。空白文件会返回 empty=true。",
    parameters: Type.Object({
      fileId: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: "文件 id（fileEntryId）；省略 = 当前正在浏览的文件",
      })),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: "Markdown 字符偏移（分页时传上一页的 nextOffset）",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: FILE_READ_MAX_LIMIT,
        description: `本次返回的字符数上限（缺省 ${FILE_READ_DEFAULT_LIMIT}）`,
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    promptSnippet: "读取当前/指定 Office 文件正文",
    promptGuidelines: [
      "用户提到“这份文档/这个表格/这份 PPT/当前打开的文件”时，先用 file_read 读取它，再回答或修改。",
    ],
    execute: async (input: StartRuntimeRunInput, params: Record<string, unknown>) => {
      const requestedFileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
      const fileId = requestedFileId || input.activeFile?.fileId || "";
      if (!fileId) {
        throw new Error(
          "NO_ACTIVE_FILE: 当前没有正在浏览的 Office 文件。请让用户先打开文件，或在调用时显式传 fileId。",
        );
      }
      const files = deps.files();
      const understanding = deps.understanding();
      if (!files || !understanding) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");

      let entry = files.catalogEntry(fileId);
      if (!entry && fileId === input.activeFile?.fileId) {
        const deadline = Date.now() + ENTRY_WAIT_MS;
        while (!entry && Date.now() < deadline) {
          await sleep(ENTRY_POLL_MS);
          entry = files.catalogEntry(fileId);
        }
      }
      if (!entry) throw new Error(`FILE_NOT_FOUND: ${fileId} 不在文件库中（可能仍在导入或已被删除）`);

      let markdown = files.catalogMarkdownOf(fileId)
        ?? files.markdownOf(fileId)
        ?? understanding.markdownForFile(fileId);
      if (markdown === null && entry.currentVersionId) {
        const parsed = await understanding.parseVersion(fileId, entry.currentVersionId);
        markdown = parsed?.markdown ?? null;
      }
      if (markdown === null) {
        throw new Error(
          `FILE_NOT_PARSABLE: ${entry.displayName ?? entry.originalName} 的格式暂不支持读取正文`,
        );
      }

      const total = markdown.length;
      const offset = Math.min(Number.isSafeInteger(Number(params.offset)) ? Math.max(0, Number(params.offset)) : 0, total);
      const limit = positiveInt(params.limit, FILE_READ_DEFAULT_LIMIT, FILE_READ_MAX_LIMIT);
      const end = Math.min(offset + limit, total);
      const content = markdown.slice(offset, end);
      const payload = {
        fileId,
        title: entry.displayName ?? entry.originalName,
        originalName: entry.originalName,
        active: fileId === input.activeFile?.fileId,
        content,
        empty: total === 0,
        offset,
        totalCharacters: total,
        truncated: end < total,
        ...(end < total ? { nextOffset: end } : {}),
        source: "saved-version",
      };
      return {
        content: JSON.stringify(payload),
        details: {
          fileId,
          offset,
          totalCharacters: total,
          truncated: end < total,
        },
      };
    },
  };
}
