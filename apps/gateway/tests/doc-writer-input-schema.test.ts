/**
 * doc-writer 子 Agent 的输入 Schema 回归（document_draft 调度契约）。
 *
 * 2026-11-06 之后的分支合并一度把这里从 `blockIndexScope` 退回旧的
 * `roomId/roomTitle` 形态；而恢复后的 document_draft 调度仍在 input 里注入
 * `blockIndexScope`（冻结 URI `everroom://room/{blockIndexScope}/...` 的 scope 段）。
 * schema 是 `additionalProperties: false`，两者不一致时真实链路会以
 * `subagent_input_schema_invalid` 拒绝 doc-writer 调度（用户看到的就是
 * 「agent 调用 doc-writer 失败」）。本测试锁住 dispatcher 载荷与 schema 的一致性。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const AGENTS_DIR = resolve(join(process.cwd(), "..", "..", "agents"));
const schema = JSON.parse(
  readFileSync(join(AGENTS_DIR, "doc-writer", "schemas", "input.schema.json"), "utf8"),
) as {
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
};

function validate(input: unknown): { ok: boolean; errors: string } {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validateFn = ajv.compile(schema);
  const ok = validateFn(input) as boolean;
  return { ok, errors: ok ? "" : JSON.stringify(validateFn.errors) };
}

/** 按 `createSubagentPiTools` 里 document_draft 的实际组装逻辑构造一份完整输入。 */
function dispatcherInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "draft-create",
    instruction: "写一篇关于 super agent 的云文档",
    // 网关固定注入：Phase 2i 后文稿一律工作区级，scope 段取工作区频道常量。
    blockIndexScope: "__workspace__",
    material: "用户提供的素材片段",
    materialSources: [{
      documentId: "doc-source-1",
      blockId: "block-1",
      label: "来源：产品说明",
      textPreview: "素材原文",
    }],
    documentId: "doc-target-1",
    documentName: "目标文档",
    documentMarkdown: "# 标题\n\n正文",
    documentTruncated: false,
    blockIndex: [{ blockId: "block-1", type: "heading", ordinal: 0, textPreview: "标题" }],
    outline: ["标题"],
    baseVersion: 3,
    selectedText: "需要改写的原文",
    contextBefore: "前文",
    contextAfter: "后文",
    blockType: "paragraph",
    responseLanguage: "zh-CN",
    previousInvocationId: "inv-1",
    previousDraft: "上一稿正文",
    ...overrides,
  };
}

describe("doc-writer input schema（document_draft 调度契约）", () => {
  it("接受 dispatcher 实际组装的输入（含网关注入的 blockIndexScope）", () => {
    const result = validate(dispatcherInput());
    expect(result.ok).toBe(true);
  });

  it("schema 必须允许 blockIndexScope —— 防止合并回归成 roomId/roomTitle 旧形态", () => {
    expect(schema.properties).toHaveProperty("blockIndexScope");
    expect(schema.properties).not.toHaveProperty("roomId");
    expect(schema.properties).not.toHaveProperty("roomTitle");
    expect(schema.required).toEqual(["task"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects unknown fields and missing task", () => {
    expect(validate(dispatcherInput({ unexpectedField: true })).ok).toBe(false);
    expect(validate(dispatcherInput({ task: undefined })).ok).toBe(false);
  });
});
