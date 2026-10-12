/**
 * slides_draft 风格阶段编排：style（出纵览候选）与 style_select（提取→
 * 定参→自校→风格卡）。tools.ts 把工具参数翻译到这里，产物回填进度卡。
 *
 * 韧性：styler 是复核不是必经——direction 失败或候选不足退确定性变体模板、
 * settle 失败退基线参数、演示页渲染失败退无图风格卡；只有中转会话
 * 不可用（无订阅）是真失败。
 */

import type { SubagentOrchestrator } from "./orchestrator.js";
import type { SlidesStyleSessionStore } from "../slides-style/style-session.js";
import type { SlidesStyleImageGenerator } from "../slides-style/image-gen.js";
import type { DemoPptxRenderer } from "../slides-style/render.js";
import type { VlmPromptAnalyzer } from "../perception/vlm-client.js";
import type { SlidesStyleSessionData, StyleOverviewImage } from "../slides-style/types.js";
import {
  extractFromOverview,
  styleParamsFromStyler,
  type OverviewExtraction,
} from "../slides-style/compose.js";
import { assignPaletteRoles, extractColorClusters } from "../slides-style/extract.js";
import { STYLE_FONT_OPTIONS } from "../slides-style/validate.js";
import { runSelfCheck } from "../slides-style/self-check.js";
import { styleCardPayload, styleImagesPayload } from "../slides-style/style-card.js";

export interface SlidesStyleStageDeps {
  sessions: SlidesStyleSessionStore;
  images: SlidesStyleImageGenerator;
  vlm: VlmPromptAnalyzer | null;
  /** 按 hash 读素材字节（网关 /v1/materials/:hash 同源）。 */
  readMaterialBytes: (hash: string) => Promise<{ buffer: Buffer; mime: string } | null>;
  demoRenderer: DemoPptxRenderer;
  /** 演示页 PNG 入库（内容哈希幂等），返回 hash 供风格卡寻址。 */
  saveDemoPng: (png: Buffer, idempotencyKey: string) => Promise<{ contentHash: string }>;
  /** 正文配图会话存储（generate 的 confirm/review 两等待阶段）；缺省时退回自动生图直落。 */
  pageImageSessions?: import("./slides-page-images-store.js").SlidesPageImageSessionStore | null;
  /** 正文配图后台生成循环；缺省时 generate 决策同步生完全部再返回。 */
  pageImageRunner?: import("./slides-page-images-runner.js").SlidesPageImageRunner | null;
}

export interface SlidesStyleStageResult {
  content: string;
  details: Record<string, unknown>;
}

export interface SlidesStyleStageInput {
  task: "style" | "style_select";
  run: { runId: string; sessionId: string; roomId: string };
  instruction: string;
  title?: string;
  draftDocumentId?: string;
  styleSessionId?: string;
  candidateIndex?: number;
  /** true = 用户明确不满意，累积反馈并重新生成；缺省 = 挑图未决时仅重新展示候选。 */
  regenerate?: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: { content: string; details: Record<string, unknown> }) => void;
  /** tools.ts 提供：带并发重试与幂等键的 dispatch 包装。 */
  dispatch: (input: {
    agentId: "slides-styler";
    task: string;
    input: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<{ status: string; result?: { structuredOutput?: unknown; text?: string } | null; errorCode?: string | null; errorMessage?: string | null; id: string }>;
}

interface Invocation {
  status: string;
  result?: { structuredOutput?: unknown; text?: string } | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  id: string;
}

function failed(errorCode: string, message: string, retryable = false): SlidesStyleStageResult {
  return { content: JSON.stringify({ status: "failed", errorCode, retryable, message }), details: { errorCode } };
}

function structured(invocation: Invocation): Record<string, unknown> | null {
  const output = invocation.result?.structuredOutput;
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return null;
}

/** direction 失败或有效候选不足时的确定性兜底：3 个固定方向种子，共用同一段负面反馈块。 */
function fallbackCandidatePrompts(instruction: string, feedback: string[]): Array<{ label: string; prompt: string }> {
  const negatives = feedback.length ? `严格避免：${feedback.join("；")}。` : "";
  const seeds = [
    { label: "冷静商务", direction: "浅灰白底 + 藏蓝主色 + 单点浅金强调，克制留白、直线分割的商务风" },
    { label: "深色高对比", direction: "深炭黑底 + 亮青主色 + 琥珀强调，高对比、大数字醒目的科技发布风" },
    { label: "暖调编辑", direction: "米白底 + 赭棕主色 + 砖红强调，杂志编辑排版、衬线气质的人文风" },
  ];
  const userDirection = instruction.trim().slice(0, 300);
  return seeds.map((seed) => ({
    label: seed.label,
    prompt: [
      `这是一张 PPT 风格参考图（16:9 横版，完整单页样张），风格方向：${userDirection ? userDirection + "，" : ""}${seed.direction}。`,
      "版式内容：顶部标题区用灰色假字条代替真文字；两三段正文块用细假字条；一两个色块或卡片；一个柱状图占位（示意，不用真实数据）；一处大数字装饰。",
      "负面约束：不出现任何真实文字与字母单词（全部用假字条）；不加噪点纹理；不要照片拼贴；不要 3D 渲染感。",
      negatives,
    ].filter(Boolean).join("\n"),
  }));
}

const DEFAULT_CANDIDATES = 3;

/** 解析 styler direction 输出为候选列表；无效项丢弃，不足 DEFAULT_CANDIDATES 由兜底变体补齐。 */
function candidatesFromStyler(
  output: Record<string, unknown> | null,
  instruction: string,
  feedback: string[],
): { candidates: Array<{ label: string; prompt: string }>; fellBack: boolean } {
  const raw = output?.candidates;
  const parsed: Array<{ label: string; prompt: string }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const prompt = typeof (item as Record<string, unknown>).imagePrompt === "string"
        ? ((item as Record<string, unknown>).imagePrompt as string).trim()
        : "";
      if (prompt.length < 40) continue;
      const labelRaw = typeof (item as Record<string, unknown>).label === "string"
        ? ((item as Record<string, unknown>).label as string).trim().slice(0, 12)
        : "";
      parsed.push({ label: labelRaw || `风格方向 ${String(parsed.length + 1)}`, prompt: prompt.slice(0, 1_200) });
    }
  }
  const fallback = fallbackCandidatePrompts(instruction, feedback);
  const candidates = [...parsed, ...fallback].slice(0, DEFAULT_CANDIDATES);
  return { candidates, fellBack: parsed.length < DEFAULT_CANDIDATES };
}

export async function runSlidesStyleStage(
  input: SlidesStyleStageInput,
  deps: SlidesStyleStageDeps,
  orchestrator: SubagentOrchestrator,
): Promise<SlidesStyleStageResult> {
  if (input.task === "style") return runStyleImages(input, deps, orchestrator);
  return runStyleSelect(input, deps);
}

async function runStyleImages(
  input: SlidesStyleStageInput,
  deps: SlidesStyleStageDeps,
  orchestrator: SubagentOrchestrator,
): Promise<SlidesStyleStageResult> {
  // 活跃会话在挑图阶段：重入默认只是把候选卡再亮出来（用户说「继续/看候选」），
  // 只有明确表达不满意（regenerate）才累积反馈重新生成——不烧配额。
  const active = deps.sessions.findActive(input.run.roomId);
  let session: SlidesStyleSessionData;
  if (active && active.stage === "images_ready" && !input.regenerate) {
    const payload = styleImagesPayload(active, input.title?.trim().slice(0, 120));
    input.onUpdate?.({ content: JSON.stringify(payload), details: payload as unknown as Record<string, unknown> });
    return {
      content: JSON.stringify({
        status: "style_images_ready",
        styleSessionId: active.id,
        candidates: active.overviewImages.length,
        generation: active.generation,
        message: "风格纵览候选已在确认卡上重新展示。告诉用户：点一张图即选定；想换一批，就说「换一批」加具体反馈。",
      }),
      details: { stage: "style_images_ready", styleSessionId: active.id },
    };
  }
  if (active && active.stage === "images_ready") {
    const feedback = [...active.feedback, input.instruction.slice(0, 500)].slice(-20);
    deps.sessions.patch(active.id, { feedback, generation: active.generation + 1 });
    session = { ...active, feedback, generation: active.generation + 1 };
  } else {
    session = deps.sessions.create({
      roomId: input.run.roomId,
      draftDocumentId: input.draftDocumentId?.trim() || null,
      instruction: input.instruction,
    });
  }
  const title = input.title?.trim().slice(0, 120);

  // 1. styler direction：凝 3 个互不相同的候选提示词（失败或不足退确定性变体）。
  let candidates: Array<{ label: string; prompt: string }>;
  const directionInput = {
    task: "direction" as const,
    instruction: session.instruction,
    ...(title ? { deckTitle: title } : {}),
    themeSummary: input.instruction.slice(0, 2_000),
    feedback: session.feedback,
  };
  let stylerError: string | null = null;
  try {
    const invocation = await orchestrator.dispatch({
      agentId: "slides-styler",
      task: "纵览图生图提示词",
      input: directionInput,
      idempotencyKey: `${input.run.runId}:styler:direction:${session.generation}`,
      source: "primary_agent",
      parentSessionId: input.run.sessionId,
      parentRunId: input.run.runId,
      ...(input.signal ? { signal: input.signal } : {}),
    }) as unknown as Invocation;
    if (invocation.status === "completed") {
      const outcome = candidatesFromStyler(structured(invocation), session.instruction, session.feedback);
      candidates = outcome.candidates;
      if (outcome.fellBack) stylerError = "styler_direction_candidates_invalid";
    } else {
      stylerError = invocation.errorCode ?? invocation.errorMessage ?? invocation.status;
      candidates = fallbackCandidatePrompts(session.instruction, session.feedback);
    }
  } catch (error) {
    stylerError = error instanceof Error ? error.message : String(error);
    candidates = fallbackCandidatePrompts(session.instruction, session.feedback);
  }

  // 2. 生图（每条候选提示词各出一张，并行；中转不可用是真失败）。
  let images: Array<{ contentHash: string }>;
  try {
    images = await deps.images.generateOverviewImages({
      candidates,
      idempotencyKey: `${input.run.runId}:style:gen:${session.generation}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed("slides_style_image_failed", `纵览图生成失败：${message}。如实告知用户；若提示中转会话不可用，说明需要已订阅账号在线。`, true);
  }

  // 3. 会话推进 + 广播挑图卡（部分候选生图失败时按成功张数对齐标签）。
  const overviewImages: StyleOverviewImage[] = images.map((image, index) => ({
    contentHash: image.contentHash,
    ...(candidates[index]?.label ? { label: candidates[index]?.label } : {}),
    generation: session.generation,
  }));
  deps.sessions.patch(session.id, { overviewImages, stage: "images_ready" });
  const updated: SlidesStyleSessionData = { ...session, overviewImages, stage: "images_ready" };
  const payload = styleImagesPayload(updated, title);
  input.onUpdate?.({ content: JSON.stringify(payload), details: payload as unknown as Record<string, unknown> });
  return {
    content: JSON.stringify({
      status: "style_images_ready",
      styleSessionId: session.id,
      candidates: overviewImages.length,
      generation: session.generation,
      message: "风格纵览候选已生成并展示在确认卡上。告诉用户：挑一张，或直接在输入框说哪里不满意（如「要更商务」「不要蓝色」），反馈会累积进下一轮重生成；确认风格后才会进入生成。",
      ...(stylerError ? { warnings: ["风格提示词由默认模板生成"] } : {}),
    }),
    details: { stage: "style_images_ready", styleSessionId: session.id },
  };
}

async function runStyleSelect(
  input: SlidesStyleStageInput,
  deps: SlidesStyleStageDeps,
): Promise<SlidesStyleStageResult> {
  const sessionId = input.styleSessionId?.trim() ?? "";
  if (!sessionId) return failed("slides_style_session_required", "缺少 styleSessionId：先经 task=style 产出纵览候选并由用户挑选。");
  const session = deps.sessions.byId(sessionId);
  if (!session || session.roomId !== input.run.roomId) {
    return failed("slides_style_session_not_found", "风格会话不存在或不属于当前 Room。");
  }
  if (session.stage !== "images_ready") {
    return failed("slides_style_stage_conflict", `风格会话当前阶段是 ${session.stage}，不能重复提取。`);
  }
  const index = Number(input.candidateIndex ?? 0);
  const candidate = session.overviewImages[index - 1];
  if (!Number.isInteger(index) || index < 1 || !candidate) {
    return failed("slides_style_candidate_invalid", `候选序号无效（共 ${String(session.overviewImages.length)} 张，1 起）。`);
  }

  // 1. 读回选定的纵览图字节。
  const bytes = await deps.readMaterialBytes(candidate.contentHash);
  if (!bytes) return failed("slides_style_image_unreadable", "选定的纵览图读取失败；请重新生成候选。", true);

  // 2. 提取（VLM 不可用退缺省气质/装饰）。
  const failingVlm: VlmPromptAnalyzer = {
    model: "unavailable",
    analyze: async () => {
      throw new Error("vlm_unavailable");
    },
  };
  let extraction: OverviewExtraction;
  try {
    extraction = await extractFromOverview(bytes, deps.vlm ?? failingVlm, input.signal);
  } catch {
    // VLM 出界/不可用：聚类与角色仍是确定性的，气质/装饰退中性。
    const clusters = await extractColorClusters(bytes);
    extraction = {
      clusters,
      roles: assignPaletteRoles(clusters),
      font: { serif: false, weight: "regular", geometric: "neutral", rounded: false },
      decoration: { cornerRadius: "small", stroke: "none", shadow: "none", motif: "none" },
    };
  }

  // 3. styler settle（输入=聚类+属性+词表；失败退基线）。
  let outcome = styleParamsFromStyler(null, extraction);
  let settleDispatched = false;
  try {
    const invocation = await input.dispatch({
      agentId: "slides-styler",
      task: "风格参数复核",
      input: {
        task: "settle",
        instruction: session.instruction,
        clusters: extraction.clusters,
        roles: extraction.roles,
        fontTemperament: extraction.font,
        decorationReading: extraction.decoration,
        fontOptions: [...STYLE_FONT_OPTIONS],
      },
      idempotencyKey: `${input.run.runId}:styler:settle:${candidate.contentHash}`,
    });
    if (invocation.status === "completed") {
      settleDispatched = true;
      outcome = styleParamsFromStyler(structured(invocation as Invocation) ?? invocation.result?.text ?? null, extraction);
    }
  } catch {
    // dispatch 失败：保持基线。
  }
  const warnings: string[] = [];
  if (!settleDispatched || outcome.fellBack) warnings.push("风格参数由默认基线生成");

  // 4. 渲染自校（桌面渲染不可用退无图风格卡）。
  let params = outcome.params;
  let demoImageHash: string | null = null;
  try {
    const selfCheck = await runSelfCheck(params, deps.demoRenderer);
    params = selfCheck.params;
    const saved = await deps.saveDemoPng(selfCheck.demoPng, `slides-style-demo:${session.id}:${params.palette.background}`);
    demoImageHash = saved.contentHash;
  } catch {
    warnings.push("演示页渲染暂不可用，风格参数不受影响");
  }

  // 5. 会话推进 + 广播风格卡。
  deps.sessions.patch(session.id, {
    selectedImageHash: candidate.contentHash,
    styleParams: params,
    demoImageHash,
    stage: "card_ready",
  });
  const updated: SlidesStyleSessionData = { ...session, selectedImageHash: candidate.contentHash, styleParams: params, demoImageHash, stage: "card_ready" };
  const payload = styleCardPayload(updated, input.title?.trim().slice(0, 120), { warnings });
  input.onUpdate?.({ content: JSON.stringify(payload), details: payload as unknown as Record<string, unknown> });
  return {
    content: JSON.stringify({
      status: "style_card_ready",
      styleSessionId: session.id,
      message: "风格卡已生成并展示在确认卡上（色板、字号、版式线框与演示页）。告诉用户：看完可直接确认生成；想改就在输入框说效果（如「标题改小点」「主色换亮蓝」），我会更新风格卡；确认后开始逐页生成。",
      ...(warnings.length ? { warnings } : {}),
    }),
    details: { stage: "style_card_ready", styleSessionId: session.id },
  };
}
