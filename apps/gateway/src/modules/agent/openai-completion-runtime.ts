import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import { proxyFetch } from "../../infrastructure/network/proxy-fetch.js";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type AgentRuntimeDescription,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";

export interface OpenAiCompletionAgentConfig {
  runtimeId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  skillPrompts?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  requestOptions?: Record<string, unknown>;
  includeProviderErrorBody?: boolean;
  /**
   * 服务端搜索校验：开启后若响应显示搜索没真发生（usage.prompt_tokens
   * 与裸 prompt 长度相当、即没有检索结果注入），抛错而非放行——防止
   * 上游静默跳过搜索参数时模型拿训练截止的旧知识冒充检索结果（HTTP
   * 仍 200，2026-11 实测中转渠道即如此）。
   *
   * 判定信号用 prompt_tokens 而非 search_info 字段：compatible-mode 的
   * chat/completions 即使真搜索了也不返回 search_info（2026-11-12 实测），
   * 真搜索时检索结果注入 prompt，prompt_tokens 从 ~20 涨到 ~2000+。
   */
  requireSearch?: boolean;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
}

interface ActiveRun {
  controller: AbortController;
  queue: AsyncEventQueue<RuntimeEvent>;
}

/** length 重试的预算封顶（4 倍重试封顶）。 */
const LENGTH_RETRY_MAX_TOKENS = 32_768;

/**
 * 搜索注入判定：真搜索时检索结果会被注入 prompt，prompt_tokens 显著超过
 * 裸 prompt 的量级（实测中文 260 字符裸 prompt ≈ 280 token，搜索后 2100~6800）。
 * 估算按 CJK ≈1.1 token/字、ASCII ≈1/3.5 token/字符；阈值取估算 2 倍，
 * 落在「裸 prompt」与「裸 prompt+注入」之间（注入观察值 ≥2000 token）。
 */
export function searchResultsInjected(
  systemPrompt: string,
  prompt: string,
  usage: { prompt_tokens?: number } | undefined,
): boolean {
  const reported = usage?.prompt_tokens;
  if (typeof reported !== "number") return true; // 无 usage 可判时保守放行
  let cjk = 0;
  let ascii = 0;
  for (const ch of systemPrompt + prompt) {
    if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
    else ascii += 1;
  }
  const bareEstimate = cjk * 1.1 + ascii / 3.5;
  return reported >= bareEstimate * 2;
}

/** AgentRuntime adapter for providers whose extra request fields are not supported by Pi. */
export class OpenAiCompletionAgentRuntime implements AgentRuntime {
  readonly id: string;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(readonly config: OpenAiCompletionAgentConfig) {
    this.id = config.runtimeId;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: false, reasoning: false, tools: false, steering: false, resume: false };
  }

  /** 调试面板数据源：单次补全 runtime 只有模型/baseUrl + 系统提示词，无工具与预算。 */
  async describe(): Promise<AgentRuntimeDescription> {
    return {
      runtimeId: this.id,
      model: {
        provider: null,
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        api: "openai-completions",
        reasoning: null,
        temperature: this.config.temperature ?? null,
        maxTokens: this.config.maxTokens ?? null,
        contextWindow: null,
      },
      role: null,
      systemPrompt: this.config.systemPrompt,
      skills: Object.entries(this.config.skillPrompts ?? {}).map(([name, prompt]) => ({ name, prompt })),
      tools: [],
      builtinTools: [],
      mcpServers: [],
      promptGuidelines: [],
      limits: null,
      capabilities: await this.getCapabilities(),
    };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Agent run is already active: ${input.runId}`);
    await Promise.all([
      mkdir(this.config.sessionsDir, { recursive: true }),
      mkdir(this.config.workingDirectory, { recursive: true }),
      mkdir(this.config.agentDirectory, { recursive: true }),
    ]);
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const controller = new AbortController();
    this.activeRuns.set(input.runId, { controller, queue });
    const runtimeSessionRef = input.runtimeSessionRef ?? resolve(this.config.sessionsDir, `${randomUUID()}.jsonl`);
    queue.push({ type: "run.started", payload: {} });
    queue.push({ type: "message.started", payload: { role: "assistant" } });
    void this.complete(input, queue, controller.signal);
    return { runId: input.runId, runtimeSessionRef, events: queue };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error(`${this.id} does not support resume`);
  }

  async sendInput(): Promise<void> {
    throw new Error(`${this.id} does not support steering`);
  }

  async cancel(runId: string): Promise<void> {
    this.activeRuns.get(runId)?.controller.abort(new Error("cancelled"));
  }

  async deleteSession(runtimeSessionRef: string): Promise<void> {
    const root = `${resolve(this.config.sessionsDir)}${sep}`;
    const path = resolve(runtimeSessionRef);
    if (!path.startsWith(root)) throw new Error("Agent session path is outside its sessions directory");
    await rm(path, { force: true });
  }

  async dispose(): Promise<void> {
    for (const active of this.activeRuns.values()) active.controller.abort(new Error("disposed"));
    this.activeRuns.clear();
  }

  private async complete(
    input: StartRuntimeRunInput,
    queue: AsyncEventQueue<RuntimeEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      // length 防护：推理型模型的思考段会先消耗 max_tokens，烧尽时以
      // finish_reason=length 且无正文返回。一次 4 倍加预算重试（封顶
      // LENGTH_RETRY_MAX_TOKENS，配置本身更大时保持原值不缩水）再判失败
      // ——固定倍率重试策略。
      let content: string | null = null;
      const retryBudget = this.config.maxTokens === undefined
        ? undefined
        : Math.min(this.config.maxTokens * 4, LENGTH_RETRY_MAX_TOKENS);
      for (let attempt = 0; ; attempt += 1) {
        const budget = attempt === 0 ? this.config.maxTokens : retryBudget;
        const outcome = await this.fetchCompletion(input, budget, signal);
        if (outcome.content !== null) {
          content = outcome.content;
          break;
        }
        if (budget === undefined || retryBudget === undefined || budget >= retryBudget) {
          throw new Error(`${this.id} provider returned no content (finish_reason=${outcome.finishReason})`);
        }
      }
      queue.push({ type: "message.delta", payload: { delta: content } });
      queue.push({ type: "message.completed", payload: { role: "assistant", content } });
      queue.push({ type: "run.completed", payload: {} });
    } catch (error) {
      if (signal.aborted) {
        queue.push({ type: "run.cancelled", payload: {} });
      } else {
        queue.push({
          type: "run.failed",
          payload: { message: error instanceof Error ? error.message : `${this.id} failed` },
        });
      }
    } finally {
      queue.end();
      this.activeRuns.delete(input.runId);
    }
  }

  /**
   * 单次补全请求。返回 { content, finishReason }；content 为 null 表示
   * finish_reason=length 且无正文（可加预算重试），其余空正文直接抛错。
   */
  private async fetchCompletion(
    input: StartRuntimeRunInput,
    maxTokens: number | undefined,
    signal: AbortSignal,
  ): Promise<{ content: string; finishReason: string } | { content: null; finishReason: string }> {
    const response = await proxyFetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: this.systemPromptFor(input) },
          { role: "user", content: input.prompt },
        ],
        ...(this.config.temperature === undefined ? {} : { temperature: this.config.temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        ...this.config.requestOptions,
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      ]),
    });
    if (!response.ok) {
      const detail = this.config.includeProviderErrorBody === false
        ? ""
        : await response.text().catch(() => "");
      throw new Error(`${this.id} provider HTTP ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number };
    };
    const choice = payload.choices?.[0];
    const finishReason = choice?.finish_reason ?? "unknown";
    const content = choice?.message?.content?.trim();
    if (!content) {
      if (finishReason === "length") return { content: null, finishReason };
      throw new Error(`${this.id} provider returned no content (finish_reason=${finishReason})`);
    }
    if (this.config.requireSearch && !searchResultsInjected(this.systemPromptFor(input), input.prompt, payload.usage)) {
      // 200 + 正文 + prompt_tokens 无搜索注入量 = 检索被上游静默跳过（参数被
      // 忽略/中转剥参）。放行会让模型拿训练截止的旧知识冒充联网结果，宁可报错。
      throw new Error(
        `${this.id} search was requested but no search results were injected (prompt_tokens=${payload.usage?.prompt_tokens ?? "?"}; search silently skipped upstream)`,
      );    }
    return { content, finishReason };
  }

  private systemPromptFor(input: StartRuntimeRunInput): string {
    const skillName = /^使用 Knowledge Agent 的 ([a-z0-9-]+) Skill。/iu.exec(input.prompt)?.[1];
    const skill = skillName ? this.config.skillPrompts?.[skillName] : undefined;
    const responseLanguage = input.responseLanguage?.trim();
    return [
      this.config.systemPrompt,
      ...(skill ? [`<skill name="${skillName}">\n${skill}\n</skill>`] : []),
      ...(responseLanguage ? [
        `当前界面 locale：${responseLanguage}。除非用户明确要求本次输出使用另一种语言，所有 Agent 生成的自然语言内容（包括聊天答复、总结、文档标题和文档正文）都必须使用 ${responseLanguage} 对应的主要语言；代码、路径、引用、专有名词和用户原文保持原样。`,
      ] : []),
    ].join("\n\n");
  }
}
