import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { SLIDES_TOOL_NAMES, officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import {
  createSlidesPlannerAgentTools,
  createSlidesBuilderAgentTools,
  createSlidesLayouterAgentTools,
} from "../src/modules/subagents/slides-agent-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

function runInput(phase?: string): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "prompt",
    pageLabel: "Subagent: Slides Planner",
    roomId: "room-1",
    toolsEnabled: true,
    ...(phase ? { runtimeMetadata: { subagentInput: { phase } } } : {}),
  };
}

const PLANNER_ROOM_TOOLS = [
  tool("memory_search"), tool("conversation_search"), tool("room_context_get"), tool("room_task_create"),
];
const PLANNER_DOCUMENT_TOOLS = [
  ...SLIDES_TOOL_NAMES.map(tool),
  tool("context_room_list"), tool("context_room_document_list"), tool("context_room_document_read"),
  tool("context_room_office_create"), tool("context_room_sheets_create"),
  tool("context_room_write_begin"), tool("context_room_patch_begin"),
];

describe("createSlidesPlannerAgentTools（slides-planner 工具面）", () => {
  it("只放行检索/读取/联网/配图预热类；素材检索、slides 四件套、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesPlannerAgentTools({
      roomTools: PLANNER_ROOM_TOOLS,
      documentTools: PLANNER_DOCUMENT_TOOLS,
      webSearchTools: [tool("web_search"), tool("agent_dispatch"), tool("agent_catalog"), tool("send_notification")],
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_document_list",
      "context_room_document_read",
      "context_room_list",
      "conversation_search",
      "memory_search",
      "room_context_get",
      "slides_image_prewarm",
      "web_search",
    ]);
    // 素材检索已前移到网关预取（输入 materialHits）；预热工具保留给非分批路径。
    expect(tools.some((item) => item.name === "material_search")).toBe(false);
  });

  it("空依赖时只含配图预热（token 注册表寻址，装配零依赖）", () => {
    expect(createSlidesPlannerAgentTools({ roomTools: [], documentTools: [], webSearchTools: [] })
      .map((item) => item.name)).toEqual(["slides_image_prewarm"]);
  });

  it("draft 阶段把 Room 全量文档压成预览、facts/entities 截断", async () => {
    const roomContext: PiAgentRuntimeTool = {
      name: "room_context_get",
      label: "room",
      description: "room",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({
        content: JSON.stringify({
          room: { title: "R" },
          facts: Array.from({ length: 80 }, (_, index) => ({ factId: `f${index}` })),
          entities: Array.from({ length: 40 }, (_, index) => ({ id: `e${index}` })),
          documents: [{
            documentId: "doc-1",
            title: "长文档",
            markdown: "m".repeat(5_000),
          }],
        }),
      }),
    };
    const tools = createSlidesPlannerAgentTools({
      roomTools: [roomContext],
      documentTools: [],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "room_context_get")!;
    const draft = JSON.parse((await wrapped.execute(runInput("draft"), { roomId: "room-1" })).content) as {
      facts: unknown[];
      entities: unknown[];
      documents: Array<{ preview: string; characters: number; previewTruncated?: boolean }>;
    };
    expect(draft.facts).toHaveLength(60);
    expect(draft.entities).toHaveLength(30);
    expect(draft.documents[0]).toMatchObject({ characters: 5_000, previewTruncated: true });
    expect(draft.documents[0]!.preview).toHaveLength(600);

    const arrange = JSON.parse((await wrapped.execute(runInput("arrange"), { roomId: "room-1" })).content) as {
      documents: unknown[];
      documentsOmitted?: string;
    };
    expect(arrange.documents).toEqual([]);
    expect(arrange.documentsOmitted).toBeTruthy();
  });

  it("文档读取：draft 单次限 20k 字符、只回正文与分页字段，arrange 阶段直接拒读", async () => {
    let received: Record<string, unknown> = {};
    const documentRead: PiAgentRuntimeTool = {
      name: "context_room_document_read",
      label: "read",
      description: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, params) => {
        received = params;
        const limit = Number(params.limit);
        const offset = Number(params.offset);
        const total = 39_612;
        const end = Math.min(offset + limit, total);
        return {
          content: JSON.stringify({
            roomId: "room-1",
            documentId: "doc-1",
            title: "长文档",
            version: 3,
            markdown: "正".repeat(end - offset),
            markdownOffset: offset,
            markdownTotalCharacters: total,
            markdownTruncated: end < total,
            ...(end < total ? { nextOffset: end } : {}),
            blockCount: 97,
            indexedBlockCount: 334,
            blockScope: "top_level",
            blocks: Array.from({ length: 97 }, (_, index) => ({
              blockId: `block-${index}`,
              type: "paragraph",
              ordinal: index,
              textPreview: "预".repeat(400),
            })),
            patchContract: { replacementMarkdown: "不要整篇搬运" },
            readReceipt: { receiptId: "secret" },
          }),
          details: { roomId: "room-1" },
        };
      },
    };
    const tools = createSlidesPlannerAgentTools({
      roomTools: [],
      documentTools: [tool("context_room_list"), tool("context_room_document_list"), documentRead],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "context_room_document_read")!;
    // 上限收到 20k；分页字段原样透传，编辑用 block 索引/补丁契约不再进入上下文。
    const draft = JSON.parse((await wrapped.execute(runInput("draft"), { documentId: "doc-1", limit: 99_999 })).content) as {
      markdown: string;
      markdownOffset: number;
      markdownTotalCharacters: number;
      nextOffset?: number;
      blocks?: unknown;
      patchContract?: unknown;
      readReceipt?: unknown;
      note?: string;
    };
    expect(received).toMatchObject({ limit: 20_000, offset: 0 });
    expect(draft.markdown).toHaveLength(20_000);
    expect(draft).toMatchObject({ markdownOffset: 0, markdownTotalCharacters: 39_612, nextOffset: 20_000 });
    expect(draft.blocks).toBeUndefined();
    expect(draft.patchContract).toBeUndefined();
    expect(draft.readReceipt).toBeUndefined();
    expect(draft.note).toContain("nextOffset");
    // 单次结果大小稳定落在通用 24k 字符截断预算内，不会再被截成 6k 正文预览。
    expect(JSON.stringify(draft).length).toBeLessThan(24_000);

    // 第二页继续用 nextOffset。
    const next = JSON.parse((await wrapped.execute(runInput("draft"), {
      documentId: "doc-1", offset: draft.nextOffset, limit: 20_000,
    })).content) as { markdown: string; markdownTotalCharacters: number };
    expect(next.markdown).toHaveLength(19_612);
    expect(next.markdownTotalCharacters).toBe(39_612);

    const arrange = JSON.parse((await wrapped.execute(runInput("arrange"), { documentId: "doc-1" })).content) as {
      skipped?: boolean;
    };
    expect(arrange.skipped).toBe(true);
  });

  it("网关预取在 sourceDocuments 里的文档：planner 再读直接跳过，不重复占上下文", async () => {
    let executed = 0;
    const documentRead: PiAgentRuntimeTool = {
      name: "context_room_document_read",
      label: "read",
      description: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        executed += 1;
        return { content: JSON.stringify({ markdown: "正文" }) };
      },
    };
    const tools = createSlidesPlannerAgentTools({
      roomTools: [],
      documentTools: [documentRead],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "context_room_document_read")!;
    const prefetched = {
      ...runInput("draft"),
      runtimeMetadata: {
        subagentInput: {
          phase: "draft",
          sourceDocuments: [
            { documentId: "doc-prefetched", title: "大纲", version: 1, markdown: "正文", markdownTotalCharacters: 2 },
          ],
        },
      },
    };
    const skipped = JSON.parse((await wrapped.execute(prefetched, { documentId: "doc-prefetched" })).content) as {
      skipped?: boolean;
      reason?: string;
    };
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toContain("sourceDocuments");
    expect(executed).toBe(0);

    // 未预取的文档仍正常读取。
    const read = JSON.parse((await wrapped.execute(prefetched, { documentId: "doc-other" })).content) as {
      markdown?: string;
    };
    expect(read.markdown).toBe("正文");
    expect(executed).toBe(1);

    // 预取时被预算截断的文档不拦：planner 还需要用 offset/limit 读剩余部分。
    const truncatedPrefetch = {
      ...runInput("draft"),
      runtimeMetadata: {
        subagentInput: {
          phase: "draft",
          sourceDocuments: [{
            documentId: "doc-truncated",
            title: "超长文档",
            version: 1,
            markdown: "前 40k",
            markdownTotalCharacters: 90_000,
            truncated: true,
          }],
        },
      },
    };
    await wrapped.execute(truncatedPrefetch, { documentId: "doc-truncated", offset: 40_000 });
    expect(executed).toBe(2);
  });

  it("分批编排时预热工具直接跳过，不把无效 token 变成失败轮次", async () => {
    const tools = createSlidesPlannerAgentTools({ roomTools: [], documentTools: [], webSearchTools: [] });
    const prewarm = tools.find((item) => item.name === "slides_image_prewarm")!;
    const input = {
      ...runInput("arrange"),
      runtimeMetadata: { subagentInput: { phase: "arrange", arrangeBatch: { index: 0 } } },
    };
    const result = JSON.parse((await prewarm.execute(input, { prewarmToken: "none", pageIndex: 1, imagePrompt: "画面" })).content) as {
      skipped?: boolean;
      reason?: string;
    };
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("网关");
  });

  it("arrange 阶段 conversation_search 最多 2 次，之后推回提交；draft 不限", async () => {
    let executed = 0;
    const conversationSearch: PiAgentRuntimeTool = {
      name: "conversation_search",
      label: "history",
      description: "history",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        executed += 1;
        return { content: JSON.stringify({ hits: [] }) };
      },
    };
    const tools = createSlidesPlannerAgentTools({
      roomTools: [conversationSearch],
      documentTools: [],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "conversation_search")!;
    const arrangeInput = { ...runInput("arrange"), runId: "conversation-cap-run" };
    await wrapped.execute(arrangeInput, {});
    await wrapped.execute(arrangeInput, {});
    const third = JSON.parse((await wrapped.execute(arrangeInput, {})).content) as { skipped?: boolean; reason?: string };
    expect(executed).toBe(2);
    expect(third.skipped).toBe(true);
    expect(third.reason).toContain("subagent_submit_result");

    const draftInput = { ...runInput("draft"), runId: "conversation-cap-draft" };
    for (let index = 0; index < 3; index += 1) await wrapped.execute(draftInput, {});
    expect(executed).toBe(5);
  });
});

describe("createSlidesBuilderAgentTools（slides-builder 工具面）", () => {
  it("只放行 PPT 四件套；检索、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesBuilderAgentTools({
      documentTools: PLANNER_DOCUMENT_TOOLS,
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_slides_create",
      "context_room_slides_edit",
      "context_room_slides_read",
      "context_room_slides_set_page",
    ]);
  });

  it("空依赖时返回空数组", () => {
    expect(createSlidesBuilderAgentTools({ documentTools: [] })).toEqual([]);
  });
});

describe("createSlidesLayouterAgentTools（validate 收口）", () => {
  it("同一 run 连续 5 轮不收敛后网关收下当前树并提示提交", async () => {
    const tool = createSlidesLayouterAgentTools()[0]!;
    const input = { ...runInput(), runId: "validate-forced-run" };
    for (let round = 1; round <= 4; round += 1) {
      const outcome = JSON.parse((await tool.execute(input, { token: "unknown-token", tree: {} })).content) as {
        ok: boolean;
        round?: number;
      };
      expect(outcome.ok).toBe(false);
      expect(outcome.round).toBe(round);
    }
    const forced = JSON.parse((await tool.execute(input, { token: "unknown-token", tree: {} })).content) as {
      ok: boolean;
      forcedSubmission?: boolean;
      warning?: string;
    };
    expect(forced).toMatchObject({ ok: true, forcedSubmission: true });
    expect(forced.warning).toContain("subagent_submit_result");
  });
});

describe("SLIDES_TOOL_NAMES（主 Agent 剔除清单 ↔ 插件工具清单同步）", () => {
  it("officePlugin 注册的工具覆盖全部四个名字（改名/增删时清单不失真）", () => {
    const plugin = officePlugin(null as never);
    const registered = plugin.tools.map((item) => item.name);
    for (const name of SLIDES_TOOL_NAMES) {
      expect(registered).toContain(name);
    }
  });
});
