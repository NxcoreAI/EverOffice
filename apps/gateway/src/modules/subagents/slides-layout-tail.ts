/**
 * generate 尾部（布局树链路）：契约注册 → 建骨架 deck → 每页并发 dispatch
 * slides-layouter（窗口 4）→ 按页序编译落页（进度广播 + VLM 视觉复检）→
 * 页间树相似度审计（超标页重排 ≤1 次）→ 汇总回收。
 * agent 只出树；编译、落页、复检全部网关确定性执行。
 */

import { createHash } from "node:crypto";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { SlidesProgressEvent, SlidesProgressPlan, SlidesProgressTracker } from "./slides-progress-tracker.js";
import type { OfficeBridgeClient } from "../documents/capabilities/office-bridge-client.js";
import type { SlidesVisualReviewer, VisualReviewOutcome } from "../slides-visual-review/review.js";
import { MAX_PAGE_SPEC_LENGTH, skeletonPageSpec } from "../documents/capabilities/office-plugin.js";
import { contractFromStyleParams, type LayoutContract } from "../slides-layout/tree/layout-contract.js";
import { dropDeckLayoutContext, registerDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { normalizeTree, type LayoutTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { measureDefects, shrinkToFit } from "../slides-layout/tree/measure.js";
import { auditSimilarity, treeSignature } from "../slides-layout/tree/similarity.js";
import { resolveImageArs } from "../slides-layout/tree/aspect-ratio.js";

const COMPOSITION_TENDENCY: Record<string, string> = {
  swiss: "强网格、克制留白、对齐严谨",
  editorial: "编辑杂志感、不对称分区、大图与文字块错落",
  poster: "海报感、大字主导、视觉冲击",
  immersive: "沉浸式、大图满版、文字叠于图上",
};

export interface LayouterTailDeps {
  progress: SlidesProgressTracker | null;
  bridge: OfficeBridgeClient | null;
  visualReviewer: SlidesVisualReviewer | null;
  readMaterialBlob(hash: string): Promise<Uint8Array | null>;
  fetchImageHead(url: string): Promise<Uint8Array | null>;
  /** 幂等键（tools.ts 的 dispatchKey 单一出处）。 */
  makeKey(runId: string, agentId: string, task: string, input: unknown): string;
  /** 带并发限额退避的 dispatch（tools.ts 的 dispatchWithConcurrencyRetry 单一出处）。 */
  dispatchPage(input: Record<string, unknown>, idempotencyKey: string, parentRunId: string | null): Promise<SubagentInvocation>;
}

export interface LayouterTailArgs {
  roomId: string;
  sessionId: string;
  runId: string;
  parentRunId: string | null;
  instruction: string;
  plan: Record<string, unknown>;
  armPlan: SlidesProgressPlan;
  styleParams: Record<string, unknown> | null;
  draftDocumentId: string;
  settle: { pageImagesSessionId?: string; styleSessionIdToSettle?: string | null };
  styleSessions: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  pageImagesStore: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  trashDraft: (documentId: string) => Promise<void>;
  signal?: AbortSignal;
  onUpdate?: (update: { content: string; details: unknown }) => void;
}

interface PageInput {
  title?: string;
  role?: string;
  density?: string;
  points?: unknown;
  data?: unknown;
  materials?: unknown;
  notes?: unknown;
}

/** 进度事件 → 渲染层进度卡载荷（tools.ts 的 relay 共用；单一出处在本模块）。 */
export function slidesProgressUpdatePayload(event: SlidesProgressEvent): Record<string, unknown> {
  const snapshot = event.snapshot;
  return {
    stage: "page_applied",
    slideIndex: event.slideIndex,
    title: snapshot.title,
    totalPages: snapshot.totalPages,
    pages: snapshot.pages,
    doneCount: snapshot.doneCount,
    ...(snapshot.narrative ? { narrative: snapshot.narrative } : {}),
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
  };
}

function styleBriefFrom(styleParams: Record<string, unknown> | null): string {
  if (!styleParams) return "";
  const parts: string[] = [];
  const composition = styleParams.composition;
  if (typeof composition === "string" && COMPOSITION_TENDENCY[composition]) {
    parts.push(COMPOSITION_TENDENCY[composition]!);
  }
  const effectLines = styleParams.effectLines;
  if (Array.isArray(effectLines)) {
    for (const line of effectLines) {
      if (typeof line === "string" && line.trim() && !/^构图[:：]/.test(line.trim())) {
        parts.push(line.trim());
      }
    }
  }
  return parts.join("；").slice(0, 400);
}

/** 布局代理失败/未交树时的确定性兜底：标题 + 要点竖排。 */
function fallbackTree(page: PageInput): LayoutTree {
  const points = Array.isArray(page.points)
    ? page.points.filter((p): p is string => typeof p === "string" && Boolean(p.trim())).slice(0, 5)
    : [];
  return normalizeTree({
    role: typeof page.role === "string" ? page.role : "content",
    ...(typeof page.title === "string" && page.title.trim() ? { title: page.title.slice(0, 80) } : {}),
    direction: "column",
    gapScale: 1.5,
    children: [
      ...(points.length > 0
        ? points.map((point) => ({ type: "text", variant: "body", text: point.slice(0, 200), bullet: true }))
        : [{ type: "text", variant: "subtitle", text: "内容生成中断，本页为兜底版式" }]),
    ],
  });
}

const PAGE_DISPATCH_RETRY_DELAYS_MS = [2000, 6000];

/** 页级 dispatch 长退避：并发限额是常态（窗口 4 对全局 4），拒绝即退避重试，耗尽才落兜底。 */
async function dispatchWithPageRetry(
  fn: () => Promise<SubagentInvocation>,
): Promise<SubagentInvocation> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const delay = PAGE_DISPATCH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function treeFromInvocation(invocation: SubagentInvocation, page: PageInput): { tree: LayoutTree; fellBack: boolean } {
  if (invocation.status === "completed") {
    const structured = invocation.result?.structuredOutput;
    if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
      const raw = (structured as Record<string, unknown>).tree;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        try {
          return { tree: normalizeTree(raw), fellBack: false };
        } catch {
          // 落到兜底
        }
      }
    }
  }
  return { tree: fallbackTree(page), fellBack: true };
}

interface PageMaterial { url?: unknown; desc?: unknown; aspectRatio?: unknown }

function materialUrls(pages: PageInput[]): string[] {
  const urls = new Set<string>();
  for (const page of pages) {
    if (!Array.isArray(page.materials)) continue;
    for (const material of page.materials as PageMaterial[]) {
      if (material !== null && typeof material === "object" && typeof material.url === "string"
        && /^(https?:\/\/|everroom-material:\/\/)/i.test(material.url)) {
        urls.add(material.url);
      }
    }
  }
  return [...urls];
}

/** 页内容 → layouter 输入（白名单拷贝，schema 对齐 agents/slides-layouter/schemas/input.schema.json）。 */
function layouterInputFor(
  base: { token: string; totalPages: number; styleBrief: string },
  page: PageInput,
  index: number,
  neighborSignatures?: string[],
): Record<string, unknown> {
  const materials = Array.isArray(page.materials)
    ? (page.materials as PageMaterial[])
        .filter((m) => m !== null && typeof m === "object" && typeof m.url === "string")
        .slice(0, 4)
        .map((m) => ({
          url: (m.url as string).slice(0, 500),
          ...(typeof m.desc === "string" ? { desc: m.desc.slice(0, 200) } : {}),
          ...(typeof m.aspectRatio === "number" && Number.isFinite(m.aspectRatio) && m.aspectRatio > 0
            ? { aspectRatio: m.aspectRatio }
            : {}),
        }))
    : [];
  return {
    task: "layout",
    deckToken: base.token,
    pageIndex: index,
    totalPages: base.totalPages,
    role: typeof page.role === "string" ? page.role : "content",
    density: typeof page.density === "string" ? page.density : "standard",
    ...(typeof page.title === "string" && page.title.trim() ? { title: page.title.slice(0, 80) } : {}),
    ...(Array.isArray(page.points)
      ? { points: (page.points as unknown[]).filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 400)).slice(0, 8) }
      : {}),
    ...(typeof page.data === "string" && page.data.trim() ? { data: page.data.slice(0, 2000) } : {}),
    ...(materials.length > 0 ? { materials } : {}),
    ...(typeof page.notes === "string" && page.notes.trim() ? { notes: page.notes.slice(0, 1000) } : {}),
    ...(base.styleBrief ? { styleBrief: base.styleBrief } : {}),
    ...(neighborSignatures && neighborSignatures.length > 0 ? { neighborSignatures: neighborSignatures.slice(0, 4) } : {}),
  };
}

interface FinalPage {
  spec: Record<string, unknown>;
  degraded: boolean;
  focusHints: string[];
}

function finalizeTree(tree: LayoutTree, contract: LayoutContract, imageArs: Map<string, number>): FinalPage {
  const result = compileTree(tree, contract);
  const defects = measureDefects(result, contract, { imageArs });
  if (defects.length === 0) {
    return { spec: result.spec as unknown as Record<string, unknown>, degraded: false, focusHints: [] };
  }
  const shrunk = shrinkToFit(tree, contract, { imageArs });
  return {
    spec: shrunk.result.spec as unknown as Record<string, unknown>,
    degraded: shrunk.degraded,
    focusHints: shrunk.defects.map((d) => `${d.path}：${d.detail}`),
  };
}

export async function runLayouterTail(
  deps: LayouterTailDeps,
  args: LayouterTailArgs,
): Promise<{ content: string; details: unknown }> {
  const { plan, armPlan } = args;
  const pages = (Array.isArray(plan.pages) ? plan.pages : []).filter(
    (p): p is PageInput => p !== null && typeof p === "object" && !Array.isArray(p),
  );
  const fail = (errorCode: string, message: string, retryable = false, extra: Record<string, unknown> = {}) => ({
    content: JSON.stringify({
      ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
      status: "failed",
      errorCode,
      retryable,
      message,
      ...extra,
    }),
    details: { errorCode },
  });

  if (pages.length < 1 || pages.length > 24) return fail("slides_layout_pages_invalid", "方案页数无效（1~24 页）", true);
  if (!deps.bridge) return fail("slides_office_bridge_unavailable", "桌面 Office 桥未配置，无法落页");

  const contract = contractFromStyleParams(args.styleParams as never);
  const imageArs = await resolveImageArs(materialUrls(pages), {
    readMaterialBlob: deps.readMaterialBlob,
    fetchHead: deps.fetchImageHead,
  });
  const token = `${args.runId}:layout`;
  registerDeckLayoutContext(token, { contract, imageArs });
  const bridge = deps.bridge;

  const progressKey = `slides-generate:${args.runId}`;
  const progress = deps.progress;
  if (progress) {
    progress.arm(progressKey, armPlan);
    if (args.onUpdate) {
      progress.setRelay(progressKey, (event) => {
        const payload = slidesProgressUpdatePayload(event);
        args.onUpdate?.({ content: JSON.stringify(payload), details: payload });
      });
    }
  }

  const warnings: string[] = [];
  let fileEntryId = "";
  let originalName: string | null = null;
  try {
    const deckTitle = (typeof plan.title === "string" && plan.title.trim() ? plan.title : armPlan.title).slice(0, 120);
    const outline = pages.map((p) => (typeof p.title === "string" && p.title.trim() ? p.title : "未命名页").slice(0, 80));
    const deckIdempotency = `agent-slides:${createHash("sha256").update(JSON.stringify([args.runId, deckTitle]), "utf8").digest("hex")}`;
    const created = await bridge.generate({
      title: deckTitle,
      format: "pptx",
      pages: [skeletonPageSpec(deckTitle, outline[0]!, 0, outline.length)],
      roomId: args.roomId,
      fileName: null,
      idempotencyKey: deckIdempotency,
    });
    if (!created.fileEntryId) return fail("slides_office_generation_failed", "桌面端未返回文件条目");
    fileEntryId = created.fileEntryId;
    originalName = created.originalName ?? null;
    deps.visualReviewer?.forgetDeck(fileEntryId);

    const styleBrief = styleBriefFrom(args.styleParams);
    const base = { token, totalPages: pages.length, styleBrief };

    // 每页并发取树（窗口 4，页序占位）。失败页确定性兜底，不中断整册。
    const trees: { tree: LayoutTree; fellBack: boolean }[] = new Array(pages.length);
    let cursor = 0;
    const workerCount = Math.min(4, pages.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= pages.length) return;
        const input = layouterInputFor(base, pages[index]!, index);
        try {
          const invocation = await dispatchWithPageRetry(() =>
            deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `page:${index}`, input), args.parentRunId));
          trees[index] = treeFromInvocation(invocation, pages[index]!);
        } catch {
          trees[index] = { tree: fallbackTree(pages[index]!), fellBack: true };
        }
        if (trees[index]!.fellBack) {
          warnings.push(`第 ${index + 1} 页布局代理未收敛，已用兜底版式`);
        }
      }
    });
    await Promise.all(workers);

    // 按页序编译落页：fill → 进度广播 → VLM 复检（复检含降档页 focusHints）。
    // 重排重落不重复计数：按页号集合统计。
    const appliedPages = new Set<number>();
    const applyPage = async (index: number, tree: LayoutTree): Promise<boolean> => {
      const final = finalizeTree(tree, contract, imageArs);
      if (final.degraded) warnings.push(`第 ${index + 1} 页经引擎降档兜底装下内容`);
      const specJson = JSON.stringify(final.spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        warnings.push(`第 ${index + 1} 页 PageSpec 超长，跳过`);
        return false;
      }
      const result = await bridge.fillPage({ fileId: fileEntryId, slideIndex: index, specJson });
      if (!result.ok || result.applied !== true) {
        warnings.push(`第 ${index + 1} 页落页失败（${result.error ?? "桌面端拒绝"}）`);
        return false;
      }
      progress?.notify(progressKey, index);
      appliedPages.add(index);
      if (deps.visualReviewer) {
        let review: VisualReviewOutcome | null = null;
        try {
          review = await deps.visualReviewer.reviewPage({
            fileId: fileEntryId,
            slideIndex: index,
            fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId: fileEntryId, slideIndex: index }), "base64"),
            ...(final.focusHints.length > 0 ? { focusHints: final.focusHints } : {}),
          });
        } catch {
          review = null;
        }
        if (review?.status === "fail") {
          warnings.push(`第 ${index + 1} 页视觉复检不通过${review.retriesExhausted ? "（重试上限，放行）" : ""}`);
        }
      }
      return true;
    };

    for (let index = 0; index < pages.length; index++) {
      await applyPage(index, trees[index]!.tree);
    }

    // 页间相似度审计：相邻同签名页重排一次（带邻页签名提示），重排结果替换重落。
    const rerollTargets = auditSimilarity(trees.map((t) => t.tree));
    for (const index of rerollTargets.slice(0, 2)) {
      const signatures = [
        ...(index > 0 ? [treeSignature(trees[index - 1]!.tree)] : []),
        ...(index + 1 < trees.length ? [treeSignature(trees[index + 1]!.tree)] : []),
      ];
      const input = layouterInputFor(base, pages[index]!, index, signatures);
      try {
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `reroll:${index}`, input), args.parentRunId));
        const rerolled = treeFromInvocation(invocation, pages[index]!);
        if (!rerolled.fellBack && treeSignature(rerolled.tree) !== treeSignature(trees[index]!.tree)) {
          trees[index] = rerolled;
          warnings.push(`第 ${index + 1} 页与邻页结构雷同，已重排`);
          await applyPage(index, rerolled.tree);
        }
      } catch {
        // 重排失败保留原页
      }
    }

    if (appliedPages.size === 0) {
      return fail("slides_layout_apply_failed", "全部页面落页失败；方案已就绪，可重试 generate。", true, { fileEntryId });
    }
    const completed = appliedPages.size === pages.length;
    if (completed && args.draftDocumentId) {
      void args.trashDraft(args.draftDocumentId).catch(() => {});
    }
    const settleStyleSessionId = args.settle.styleSessionIdToSettle ?? null;
    if (completed && settleStyleSessionId && args.styleSessions) {
      args.styleSessions.patch(settleStyleSessionId, { stage: "confirmed" });
    }
    if (completed && args.settle.pageImagesSessionId && args.pageImagesStore) {
      args.pageImagesStore.patch(args.settle.pageImagesSessionId, { stage: "resolved" });
    }
    return {
      content: JSON.stringify({
        ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
        status: completed ? "completed" : "partial",
        fileEntryId,
        fileName: originalName,
        pages: appliedPages.size,
        outline,
        warnings,
        summary: completed
          ? `已生成 ${appliedPages.size} 页演示文稿`
          : `已生成 ${appliedPages.size}/${pages.length} 页，未完成页可重试`,
      }),
      details: { fileEntryId, pages: appliedPages.size, warnings },
    };
  } catch (error) {
    return fail(
      "slides_layout_tail_failed",
      `布局树落页失败：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    dropDeckLayoutContext(token);
    progress?.disarm(progressKey);
  }
}
