import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { ScreenMemoryService } from "./service.js";

/**
 * 屏幕记忆检索工具：按内容/应用/时间查用户看过的屏幕区间，
 * 返回时间、应用、标题、摘要与原文片段。主 Agent 用来回答「我之前看过什么」类问题。
 */
export function createScreenMemorySearchPiTools(service: ScreenMemoryService): PiAgentRuntimeTool[] {
  return [{
    name: "screen_memory_search",
    label: "屏幕记忆检索",
    description: [
      "检索用户屏幕记忆：本机记录的观察区间（用户看过的应用内容）。",
      "按内容关键词搜索，可选应用 bundleId 与时间范围过滤。",
      "返回观察时间、应用、标题、摘要与原文片段；适合回答「我之前在哪看过某内容」。",
    ].join(""),
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: "内容关键词。" }),
      bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "应用 bundleId 过滤，如 com.apple.Safari。" })),
      from: Type.Optional(Type.String({ description: "起始时间 ISO 字符串。" })),
      to: Type.Optional(Type.String({ description: "结束时间 ISO 字符串。" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 8。" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_run, params): Promise<{ content: string; details: Record<string, unknown> }> => {
      const query = String(params.query ?? "").trim();
      if (!query) {
        return { content: "请提供搜索关键词。", details: { count: 0 } };
      }
      const parseDate = (value: unknown): Date | undefined => {
        if (typeof value !== "string" || value.length === 0) return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
      };
      const bundleId = typeof params.bundleId === "string" ? params.bundleId : undefined;
      const { items } = await service.searchIntervals({
        q: query,
        ...(bundleId !== undefined ? { bundleId } : {}),
        from: parseDate(params.from),
        to: parseDate(params.to),
        limit: Math.min(20, Math.max(1, Number(params.limit ?? 8))),
      });
      if (items.length === 0) {
        return { content: "屏幕记忆中没有匹配记录。可换关键词或放宽时间范围重试。", details: { count: 0 } };
      }
      const lines = items.map((item) => {
        const excerpt = item.textLines.slice(0, 3).join(" / ").slice(0, 300);
        const summary = item.summary ?? "摘要等待中";
        return `- ${item.startedAt.slice(0, 16)} 至 ${item.endedAt.slice(11, 16)}｜${item.appName}｜${item.title}｜${summary}｜原文片段：${excerpt}`;
      });
      return {
        content: ["屏幕记忆命中（引用格式：观察时间 + 应用 + 原文引句）：", ...lines].join("\n"),
        details: { count: items.length, intervalIds: items.map((item) => item.id) },
      };
    },
  }];
}
