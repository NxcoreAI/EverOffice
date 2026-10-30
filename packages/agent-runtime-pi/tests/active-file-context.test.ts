import { describe, expect, it } from "vitest";
import { buildActiveFileContext, buildOpenFilesContext } from "../src/active-file-context.js";

describe("buildActiveFileContext", () => {
  it("没有当前浏览文件时返回 null（不产出空段落）", () => {
    expect(buildActiveFileContext(undefined)).toBeNull();
    expect(buildActiveFileContext(null)).toBeNull();
  });

  it("给出文件身份、类型，并把“这份文档”绑定到 file_read", () => {
    const context = buildActiveFileContext({
      fileId: "file-abc",
      title: "软件开发合同.docx",
      kind: "docx",
      editable: true,
    });
    expect(context).toContain("软件开发合同.docx");
    expect(context).toContain("fileId: file-abc");
    expect(context).toContain("Word 文档");
    expect(context).toContain("可编辑");
    expect(context).toContain("先调用 file_read");
    // 不再让模型去猜文档内核里的其他文稿。
    expect(context).toContain("不要用 document_list/document_read");
    // 改这份 Word 用 word_agent_* 工具链（f04147ea 的新路由），而不是另建一份。
    expect(context).toContain("word_agent_edit");
    expect(context).toContain("word_agent_read");
    expect(context).toContain("office_create 是另建一份新文件");
  });

  it("PPT 额外指向 slides_read；只读打开明确不承诺修改", () => {
    const context = buildActiveFileContext({
      fileId: "file-deck",
      title: "季度汇报.pptx",
      kind: "slides",
      editable: false,
    });
    expect(context).toContain("PPT 演示文稿");
    expect(context).toContain("只读打开");
    expect(context).toContain("slides_read");
    expect(context).toContain("slides_edit");
    expect(context).toContain("不要承诺修改");
  });

  it("表格/PDF 不出现 PPT 专属指引", () => {
    const sheet = buildActiveFileContext({ fileId: "f1", title: "预算.xlsx", kind: "spreadsheet" });
    expect(sheet).toContain("Excel 表格");
    expect(sheet).not.toContain("slides_read");
    expect(sheet).toContain("sheets_agent_edit");
    expect(sheet).toContain("sheets_agent_read");
    const pdf = buildActiveFileContext({ fileId: "f2", title: "说明.pdf", kind: "pdf" });
    expect(pdf).toContain("类型：PDF");
  });
});

describe("buildOpenFilesContext", () => {
  it("没有打开页签时返回 null", () => {
    expect(buildOpenFilesContext(undefined)).toBeNull();
    expect(buildOpenFilesContext([])).toBeNull();
  });

  it("只有一份且正是当前文件时不重复（上一条已说明）", () => {
    const active = { fileId: "f1", title: "合同.docx", kind: "docx" as const };
    expect(buildOpenFilesContext([{ ...active, active: true }], active)).toBeNull();
  });

  it("多份页签逐条列出 fileId/类型，并标出正在浏览的那份", () => {
    const context = buildOpenFilesContext([
      { fileId: "f1", title: "合同.docx", kind: "docx", active: true, editable: true },
      { fileId: "f2", title: "预算.xlsx", kind: "spreadsheet", active: false },
      { fileId: "f3", title: "季度汇报.pptx", kind: "slides", active: false, editable: false },
    ], { fileId: "f1", title: "合同.docx", kind: "docx" });
    expect(context).toContain("打开着 3 个 Office 文件");
    expect(context).toContain("《合同.docx》");
    expect(context).toContain("fileId: f1");
    expect(context).toContain("正在浏览");
    expect(context).toContain("《预算.xlsx》");
    expect(context).toContain("Excel 表格");
    expect(context).toContain("《季度汇报.pptx》");
    expect(context).toContain("只读");
    // 让模型能按清单里的 fileId 读任意一份，而不是只看当前。
    expect(context).toContain("file_read 支持传清单里的 fileId");
  });

  it("清单超过 20 个时截断展示（避免挤占上下文）", () => {
    const files = Array.from({ length: 25 }, (_, index) => ({
      fileId: `f${index}`,
      title: `文件${index}.docx`,
      kind: "docx" as const,
      active: index === 0,
    }));
    const context = buildOpenFilesContext(files);
    expect(context).toContain("打开着 25 个 Office 文件");
    expect(context).toContain("《文件19.docx》");
    expect(context).not.toContain("《文件20.docx》");
  });
});
