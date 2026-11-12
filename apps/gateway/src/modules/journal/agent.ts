import { randomUUID } from "node:crypto";

import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import { invokeRuntime } from "../agent/invoke.js";
import {
  ACTION_LABEL_LIMIT,
  ADVICE_LIMIT,
  BULLET_TEXT_LIMIT,
  buildJournalPrompt,
  HEADLINE_LIMIT,
  MAX_ACTIONS,
  MAX_ADVICE,
  MAX_BULLETS,
  parseJournalComposition,
  SUMMARY_LIMIT,
} from "./composer.js";
import type { JournalComposition, JournalSignal } from "./types.js";

/**
 * 「提交即结构」的提炼通道：模型不写自由文本，而是调用一个参数带严格
 * JSON schema 的提交工具，成稿从工具参数里取（docs/daily-journal-plan §4.3）。
 *
 * 为什么不用 MCP：journal 管线是网关进程内的函数调用，没有跨进程边界；
 * 结构化保证来自工具参数 schema（pi 的 defineTool → provider 工具调用），
 * 与传输协议无关。inline pi 工具与 MCP 工具在「强制结构」上等价，
 * 少一层 loopback HTTP + session 生命周期。
 *
 * 三条继承自 composer.ts 的硬规矩不变：
 * 1. **不编造**：`sourceIds`/`targetId` 的取值被编译成只含当次证据 id 的
 *    enum——受限解码的 provider（Anthropic 工具调用 / OpenAI strict 模式）
 *    在解码层就生成不了集合外的 id；宽松 provider 由解析层
 *    `parseJournalComposition` 复核（最后一道闸，语义与旧链路一致）。
 * 2. **不评价**：提示词禁止夸奖（见 buildJournalPrompt）。
 * 3. **有兜底**：没调工具 / 提交校验不过 / run 失败 → 模板成稿
 *    （`model: null`），与旧的「解析失败走模板」同语义。
 */

/** 提交工具名（prompt 指引与参数捕获都认它）。 */
export const JOURNAL_SUBMIT_TOOL_NAME = "submit_daily_journal";

/** 工具提交结果。null = 本次 run 没有拿到可用提交（走模板兜底）。 */
export interface JournalSubmitOutcome {
  composition: JournalComposition;
  /** 模型回填的原始提交参数（日志排查用）。 */
  raw: unknown;
  /** 产出该稿的模型 id（由调用方注入 runtime 档位信息）。 */
  model?: string;
}

/**
 * 提交工具的参数 schema：上限与 composer.ts 的解析常量一一对应。
 * `sourceIds`/`targetId` 的 enum 只含当次证据 id——防编造从「事后过滤」
 * 升级为「schema 层不可能」。
 */
export function buildSubmitToolSchema(signals: readonly JournalSignal[]): Record<string, unknown> {
  const ids = signals.map((signal) => signal.id);
  return {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: `不超过 ${HEADLINE_LIMIT} 个字的一句话主题；不要空话。`,
      },
      summary: {
        type: "string",
        description: `2–4 句，助理口吻；不超过 ${SUMMARY_LIMIT} 字；不评价、不夸奖。`,
      },
      bullets: {
        type: "array",
        description: `1–${MAX_BULLETS} 条要点，每条必须有 sourceIds 依据。`,
        maxItems: MAX_BULLETS,
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: `不超过 ${BULLET_TEXT_LIMIT} 个字。` },
            sourceIds: {
              type: "array",
              description: "依据的条目 id，只能从 enum 里选。",
              items: { type: "string", enum: ids },
            },
          },
          required: ["text", "sourceIds"],
          additionalProperties: false,
        },
      },
      advice: {
        type: "array",
        description: `0–${MAX_ADVICE} 条面向下一步的可执行建议；没有就给空数组。`,
        maxItems: MAX_ADVICE,
        items: { type: "string", description: `不超过 ${ADVICE_LIMIT} 个字。` },
      },
      actions: {
        type: "array",
        description: `0–${MAX_ACTIONS} 条可点动作；没有就给空数组。`,
        maxItems: MAX_ACTIONS,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: `不超过 ${ACTION_LABEL_LIMIT} 个字。` },
            kind: { type: "string", enum: ["ask-agent"] },
            targetId: { type: "string", enum: ids },
          },
          required: ["label", "kind", "targetId"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "summary", "bullets"],
    additionalProperties: false,
  };
}

/**
 * 提交工具句柄：同一个工具对象挂进 runtime 的 integration.tools（构造一次），
 * 每次 run 前用 `begin()` 换上当天的证据 schema 并清空捕获——pi runtime 在
 * 每次 `start()` 时重新读取 `tool.parameters`（见 packages/agent-runtime-pi
 * 的 customTools 映射），所以不需要重建 runtime。
 */
export interface JournalSubmitTool {
  readonly tool: PiAgentRuntimeTool;
  /** 更新本次 run 的证据 id 集合并复位捕获状态。 */
  begin(signals: readonly JournalSignal[]): void;
  /** 本次 run 的提交参数；undefined = 没有发生工具调用。 */
  take(): unknown;
}

export function createJournalSubmitTool(): JournalSubmitTool {
  let schema: Record<string, unknown> = buildSubmitToolSchema([]);
  let submitted: unknown = undefined;
  return {
    tool: {
      name: JOURNAL_SUBMIT_TOOL_NAME,
      label: "提交今日日记",
      description:
        "把写好的今日日记作为结构化参数提交。这是唯一的产出方式：不要在回复正文里写日记，直接调用本工具。",
      // getter：begin() 换 schema 后，下一次 start() 读到的就是新 enum。
      get parameters() {
        return schema;
      },
      executionMode: "sequential",
      execute: async (_input, params): Promise<PiAgentRuntimeToolResult> => {
        // 只捕获、不加工：宽松 provider 可能带额外字段，校验统一交给解析层。
        if (submitted === undefined) submitted = params;
        return { content: "已收到提交。", details: {} };
      },
    },
    begin(signals) {
      schema = buildSubmitToolSchema(signals);
      submitted = undefined;
    },
    take: () => submitted,
  };
}

/**
 * 把工具参数归一成解析层要的字符串：对象/数组直接序列化（不需要抠 JSON——
 * 它本来就是结构化的），字符串原样（正文降级路径），其余视为无效。
 */
function normalizeSubmission(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return null;
}

/**
 * 用内部 runtime 跑一次「提交型」提炼。
 *
 * 取稿顺序：工具参数 → 正文 JSON（个别环境不支持工具时的降级）→ null（模板）。
 * run 层错误（超时/上游错/档位未就绪）原样上抛，由 composeJournal 分类——
 * 档位未就绪不计入重试、直接模板；**但已捕获到提交的除外**：提交发生了，
 * 之后的失败（如超预算的第二次工具调用触发上限）不作废已交的稿。
 */
export async function runJournalSubmit(
  runtime: AgentRuntime,
  submit: JournalSubmitTool,
  input: { date: string; signals: readonly JournalSignal[] },
  options: {
    logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  } = {},
): Promise<JournalSubmitOutcome | null> {
  const logger = options.logger ?? (() => {});
  submit.begin(input.signals);

  let content = "";
  try {
    content = await invokeRuntime(runtime, buildJournalPrompt(input.date, input.signals), {
      sessionId: `journal:${randomUUID()}`,
      pageLabel: "今日洞察",
      timeoutMs: 90_000,
      // 成稿经工具参数回传，模型提交后正文允许为空。
      allowEmptyContent: true,
    });
  } catch (error) {
    const rescued = normalizeSubmission(submit.take());
    if (rescued !== null) {
      const composition = parseJournalComposition(rescued, input.signals);
      if (composition) {
        logger("warn", "journal.submit.rescued", { date: input.date, error: String(error) });
        return { composition, raw: rescued };
      }
    }
    throw error;
  }

  // 首选：工具参数（对象直接校验）。
  const submitted = normalizeSubmission(submit.take());
  if (submitted !== null) {
    const composition = parseJournalComposition(submitted, input.signals);
    if (composition) return { composition, raw: submitted };
  }

  // 降级：模型没调工具、把 JSON 写进了正文（个别渠道不支持工具调用）。
  const fromText = content.trim() ? parseJournalComposition(content, input.signals) : null;
  if (fromText) {
    logger("warn", "journal.submit.text-fallback", { date: input.date, chars: content.length });
    return { composition: fromText, raw: content };
  }

  logger(
    "warn",
    submitted !== null ? "journal.submit.unparsable" : "journal.submit.missing",
    { date: input.date, signals: input.signals.length },
  );
  return null;
}
