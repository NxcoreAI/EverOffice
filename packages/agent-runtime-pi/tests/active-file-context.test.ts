import { describe, expect, it } from "vitest";
import { buildActiveFileContext } from "../src/active-file-context.js";

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
    expect(context).toContain("不要承诺修改");
  });

  it("表格/PDF 不出现 PPT 专属指引", () => {
    const sheet = buildActiveFileContext({ fileId: "f1", title: "预算.xlsx", kind: "spreadsheet" });
    expect(sheet).toContain("Excel 表格");
    expect(sheet).not.toContain("slides_read");
    const pdf = buildActiveFileContext({ fileId: "f2", title: "说明.pdf", kind: "pdf" });
    expect(pdf).toContain("类型：PDF");
  });
});
