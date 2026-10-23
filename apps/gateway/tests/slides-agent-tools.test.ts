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
  tool("context_room_list"), tool("document_list"), tool("document_read"),
  tool("office_create"), tool("sheets_create"),
  tool("document_write_begin"), tool("document_patch_begin"),
];

describe("createSlidesPlannerAgentTools（slides-planner 工具面）", () => {
  it("只放行检索/读取/联网/素材/配图预热类；slides 四件套、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesPlannerAgentTools({
      roomTools: PLANNER_ROOM_TOOLS,
      documentTools: PLANNER_DOCUMENT_TOOLS,
      webSearchTools: [tool("web_search"), tool("agent_dispatch"), tool("agent_catalog"), tool("send_notification")],
    });
    // 名字按字典序断言：改名后 document_* 排在 conversation_search 之后。
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_list",
      "conversation_search",
      "document_list",
      "document_read",
      "memory_search",
      "room_context_get",
      "slides_image_prewarm",
      "web_search",
    ]);
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

  it("文档读取：draft 单次限 8k 字符，arrange 阶段直接拒读", async () => {
    const documentRead: PiAgentRuntimeTool = {
      name: "document_read",
      label: "read",
      description: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, params) => ({ content: JSON.stringify(params) }),
    };
    const tools = createSlidesPlannerAgentTools({
      roomTools: [],
      documentTools: [tool("context_room_list"), tool("document_list"), documentRead],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "document_read")!;
    const draft = JSON.parse((await wrapped.execute(runInput("draft"), { documentId: "doc-1", limit: 99_999 })).content) as {
      limit: number;
      offset: number;
    };
    expect(draft).toMatchObject({ limit: 8_000, offset: 0 });

    const arrange = JSON.parse((await wrapped.execute(runInput("arrange"), { documentId: "doc-1" })).content) as {
      skipped?: boolean;
    };
    expect(arrange.skipped).toBe(true);
  });
});

describe("createSlidesBuilderAgentTools（slides-builder 工具面）", () => {
  it("只放行 PPT 四件套；检索、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesBuilderAgentTools({
      documentTools: PLANNER_DOCUMENT_TOOLS,
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "slides_create",
      "slides_edit",
      "slides_read",
      "slides_set_page",
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
