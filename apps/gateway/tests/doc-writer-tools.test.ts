import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { createDocWriterAgentTools } from "../src/modules/subagents/doc-writer-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

describe("createDocWriterAgentTools（doc-writer 素材自取工具面）", () => {
  it("只放行检索/读取/分析/联网类；写入、调度、通知类一律拒绝", () => {
    const tools = createDocWriterAgentTools({
      roomTools: [
        tool("memory_search"), tool("conversation_search"), tool("room_context_get"),
        tool("room_task_create"), tool("room_schedule_create"),
      ],
      documentTools: [
        tool("context_room_list"), tool("document_list"), tool("document_read"),
        tool("context_room_document_intent"),
        tool("document_write_begin"), tool("document_write_append"), tool("document_write_commit"),
        tool("document_patch_begin"), tool("document_patch_hunk"), tool("document_patch_commit"),
        tool("context_room_create"),
      ],
      analysisTools: [
        tool("agent_catalog"), tool("agent_dispatch"), tool("content_analysis"), tool("room_analysis"),
        tool("document_draft"), tool("document_analysis"),
      ],
      webSearchTools: [tool("web_search"), tool("send_notification")],
    });
    // 名字按字典序断言：改名后 document_* 排在 conversation_search 之后。
    expect(tools.map((item) => item.name).sort()).toEqual([
      "content_analysis",
      "context_room_list",
      "conversation_search",
      "document_list",
      "document_read",
      "memory_search",
      "room_analysis",
      "room_context_get",
      "web_search",
    ]);
  });

  it("空依赖时返回空数组（未配置联网/子 agent 时不注册空壳）", () => {
    expect(createDocWriterAgentTools({
      roomTools: [], documentTools: [], analysisTools: [], webSearchTools: [],
    })).toEqual([]);
  });
});
