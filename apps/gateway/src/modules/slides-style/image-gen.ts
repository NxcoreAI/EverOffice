/**
 * 纵览图生成：经 ai-relay 会话直连中转的 /v1/images/generations
 * （qwen-image-3.0，1792×1024，prompt_extend:false 防改写版式规格，
 * watermark:false；单张 ~100s，候选并行生成）。产物走 FilesService
 * 入 file_blobs（agent-generated，sourceKey 含幂等键：重试同键同内容
 * 去重）。不挂 room 管线——纵览候选是过程产物，只按 hash 寻址供
 * 风格卡/提取用，不进产物库。
 */

import { randomUUID } from "node:crypto";
import type { AiRelaySessionStore } from "../ai-relay/session.js";
import { relayPathPrefix } from "../ai-relay/session.js";
import type { FilesService } from "../files/service.js";
import { proxyFetch } from "../../infrastructure/network/proxy-fetch.js";

/** 生图模型与出图规格（中转实测配方，勿改 prompt_extend/watermark）。 */
const SLIDES_IMAGE_MODEL = "qwen-image-3.0";
const SLIDES_IMAGE_SIZE = "1792x1024";
/** 单张生图实测 ~100s；超时给到 180s。 */
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** 一次「挑图」节点最多出的候选数。 */
const MAX_OVERVIEW_CANDIDATES = 4;
/** 生图通道有频率限制（实测连发 3 张会 429）：429/5xx 退避重试，间隔可注入（测试用毫秒级）。 */
const DEFAULT_RETRY_DELAYS_MS = [0, 20_000, 40_000];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可重试：限流（429）与网关侧瞬时错误（502/503/504）。4xx 参数错误重试无意义。 */
function isRetryableGenerationError(message: string): boolean {
  return /\bHTTP 429\b/.test(message) || /\bHTTP 5\d\d\b/.test(message);
}

export interface OverviewImageInput {
  /** 已含风格方向与累积负面反馈的完整生图提示词。 */
  prompt: string;
  /** 候选数（1~4，向上取整钳制）。 */
  count: number;
  /** 幂等键：同键同内容去重、同键新内容走版本链；重生成轮次由调用方拼进键。 */
  idempotencyKey: string;
}

export interface OverviewImageResult {
  contentHash: string;
  fileEntryId: string;
}

export class SlidesStyleImageGenerator {
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly sessions: AiRelaySessionStore,
    private readonly files: FilesService,
    private readonly fetchImpl: FetchLike = proxyFetch as FetchLike,
    options: { retryDelaysMs?: number[] } = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async generateOverviewImages(input: OverviewImageInput): Promise<OverviewImageResult[]> {
    const session = this.sessions.current();
    if (!session) {
      throw new Error("生图中转会话不可用：需要已订阅账号且网关在线");
    }
    const count = Math.max(1, Math.min(MAX_OVERVIEW_CANDIDATES, Math.floor(input.count)));
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("生图提示词不能为空");
    // 部分成功即接受：限流窗口内能出几张是几张（≥1 张用户就能挑/说不满意），
    // 只有全军覆没才向上抛。
    const settled = await Promise.allSettled(Array.from({ length: count }, (_, index) =>
      this.generateOneWithRetry(session, prompt, input.idempotencyKey, index)));
    const succeeded = settled
      .flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    if (succeeded.length === 0) {
      const firstError = settled.find((outcome) => outcome.status === "rejected");
      const reason = firstError && firstError.status === "rejected" ? firstError.reason : null;
      throw reason instanceof Error ? reason : new Error("生图全部失败");
    }
    return succeeded;
  }

  private async generateOneWithRetry(
    session: { baseUrl: string; token: string },
    prompt: string,
    idempotencyKey: string,
    index: number,
  ): Promise<OverviewImageResult> {
    let lastError: unknown;
    for (const delayMs of this.retryDelaysMs) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        return await this.generateOne(session, prompt, idempotencyKey, index);
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !isRetryableGenerationError(error.message)) throw error;
      }
    }
    throw lastError;
  }

  private async generateOne(
    session: { baseUrl: string; token: string },
    prompt: string,
    idempotencyKey: string,
    index: number,
  ): Promise<OverviewImageResult> {
    const endpoint = `${session.baseUrl.replace(/\/+$/, "")}${relayPathPrefix(session.baseUrl)}/images/generations`;
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SLIDES_IMAGE_MODEL,
        prompt,
        n: 1,
        size: SLIDES_IMAGE_SIZE,
        prompt_extend: false,
        watermark: false,
      }),
      signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`生图请求失败（HTTP ${String(response.status)}）${detail.slice(0, 200)}`);
    }
    const body = await response.json() as { data?: Array<{ url?: unknown; b64_json?: unknown }> };
    const item = body.data?.[0];
    if (!item) throw new Error("生图响应缺少 data");
    // 实测接口成功时返回 b64_json:""（空串）+ 有效 url——只有非空 b64 才走内联，
    // 空串必须落回 url 下载（按“是否字符串”判断会把空串当内联数据解出 0 字节）。
    const inline = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
    const buffer = inline.length > 0
      ? Buffer.from(inline, "base64")
      : await this.downloadImage(item.url);
    if (buffer.byteLength === 0) throw new Error("生图结果为空");

    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const extension = isJpeg ? "jpg" : "png";
    const imported = await this.files.importFile({
      sourceKind: "agent-generated",
      sourceKey: `slides-style:${idempotencyKey}:${String(index)}`,
      originalName: `style-overview-${randomUUID().slice(0, 8)}.${extension}`,
      buffer,
      mime: isJpeg ? "image/jpeg" : "image/png",
      pipelines: { room: false, wiki: false, memory: false },
    });
    return { contentHash: imported.contentHash, fileEntryId: imported.fileEntryId };
  }

  private async downloadImage(url: unknown): Promise<Buffer> {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new Error("生图响应既无 b64_json 也无可下载 url");
    }
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`生图结果下载失败（HTTP ${String(response.status)}）`);
    return Buffer.from(await response.arrayBuffer());
  }
}
