/**
 * generate 尾部（布局树链路）：契约注册 → 建骨架 deck → 每页并发 dispatch
 * slides-layouter（窗口 8）→ 按页序编译落页（进度广播）→ 页间树相似度审计
 * （超标页重排 ≤1 次）→ slides-reviewer 并发审页（截图直投多模态；revised 的
 * 页网关机械套用修正树重落一次）→ 汇总回收。
 * agent 只出树与判断；编译、落页、套用全部网关确定性执行。
 */

import { createHash, randomUUID } from "node:crypto";
import type { RuntimeAttachment } from "@nxcore/agent-runtime";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { SlidesProgressEvent, SlidesProgressPlan, SlidesProgressTracker } from "./slides-progress-tracker.js";
import type { OfficeBridgeClient, OfficeCompleteInput } from "../documents/capabilities/office-bridge-client.js";
import type { SlidesVisualReviewer, VisualReviewOutcome } from "../slides-visual-review/review.js";
import { MAX_PAGE_SPEC_LENGTH, skeletonPageSpec } from "../documents/capabilities/office-plugin.js";
import { contractFromStyleParams, type LayoutContract } from "../slides-layout/tree/layout-contract.js";
import { TYPE_TOKENS, type ResolvedTheme } from "../slides-layout/theme.js";
import { dropDeckLayoutContext, registerDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import {
  clearPagePreviewed,
  dropPagePreview,
  registerPagePreview,
  wasPagePreviewed,
} from "../slides-layout/page-preview-context.js";
import { pptxToPng } from "../slides-style/render.js";
import { normalizeTree, type LayoutTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { visualRichnessIssues } from "../slides-layout/tree/v2/richness.js";
import { measureDefects, shrinkToFit, type LayoutDefect } from "../slides-layout/tree/measure.js";
import { auditSimilarity, treeSignature } from "../slides-layout/tree/similarity.js";
import { imageDimensions, resolveImageArs } from "../slides-layout/tree/aspect-ratio.js";
import { dropReviewManuals, registerReviewManual } from "../slides-layout/review-context.js";
import { pngBase64ToJpegBase64 } from "./screenshot-jpeg.js";

const COMPOSITION_TENDENCY: Record<string, string> = {
  swiss: "强网格、克制留白、对齐严谨",
  editorial: "编辑杂志感、不对称分区、大图与文字块错落",
  poster: "海报感、大字主导、视觉冲击",
  immersive: "沉浸式、大图满版、文字叠于图上",
};

/** 落页尾部用到的 Office 桥子集；completeDeck 可选（旧 mock/宿主无此能力时不补完成通知）。 */
export type LayouterOfficeBridge = Pick<OfficeBridgeClient, "generate" | "fillPage" | "renderPage"> & {
  renderPptx?: OfficeBridgeClient["renderPptx"];
  completeDeck?: (input: OfficeCompleteInput) => Promise<{ ok: boolean }>;
};

export interface LayouterTailDeps {
  progress: SlidesProgressTracker | null;
  bridge: LayouterOfficeBridge | null;
  visualReviewer: SlidesVisualReviewer | null;
  readMaterialBlob(hash: string): Promise<Uint8Array | null>;
  fetchImageHead(url: string): Promise<Uint8Array | null>;
  /** 幂等键（tools.ts 的 dispatchKey 单一出处）。 */
  makeKey(runId: string, agentId: string, task: string, input: unknown): string;
  /** 带并发限额退避的 dispatch（tools.ts 的 dispatchWithConcurrencyRetry 单一出处）。 */
  dispatchPage(input: Record<string, unknown>, idempotencyKey: string, parentRunId: string | null): Promise<SubagentInvocation>;
  /** 审页 dispatch（截图走 attachments 直投多模态）；缺省＝无审页代理，视觉复检走旧 VLM 链。 */
  dispatchReview?(
    input: Record<string, unknown>,
    idempotencyKey: string,
    parentRunId: string | null,
    attachments: RuntimeAttachment[],
  ): Promise<SubagentInvocation>;
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
  /** 2 = v2 页面（storyboard 接线）：layouter 输出 version:2/composition/nodes。 */
  layoutVersion?: number;
  composition?: string;
  emphasis?: string;
  intent?: string;
  takeaway?: string;
  copy?: Record<string, unknown>;
  neighbors?: unknown[];
  budget?: Record<string, unknown>;
  /** 视觉丰富度闸门打回时给 layouter 的修正提示（只给一次）。 */
  revisionFeedback?: string;
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
    updatedAt: event.updatedAt,
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

/** styleTokens 体积上限（字符）：超了先丢图表色板，再只留三只基准色。 */
export const STYLE_TOKENS_MAX_CHARS = 1200;

function clippedStyleToken(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? [...text].slice(0, max).join("") : null;
}

function finiteStyleToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 丢掉空值（null/空串），数组与布尔照原样保留。 */
function compactStyleTokens(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

/**
 * 风格卡 → 布局代理输入里的确定性 token 快照（每 run 只算一次）。
 * agent 拿它当设计系统真源：palette/typeScale/fonts/spacing/decoration 是像素口径，
 * design 轴的默认值在 componentDefaults；组件只写语义 style，不写裸色号裸像素。
 * 长字符串截断（字体名 ≤40 字）、空值丢弃、图表色板只留 4 只；总长超 1200 字符时
 * 依次降级（丢 chartSeries → 只留 background/primary/accent），语义枚举与字号不动。
 */
export function styleTokensFrom(theme: ResolvedTheme): Record<string, unknown> {
  const design = theme.design;
  const tokens: Record<string, unknown> = compactStyleTokens({
    composition: design.composition,
    darkCover: design.darkCover,
    motif: compactStyleTokens({
      kind: design.motif.kind,
      spec: Object.keys(design.motif.spec).length > 0 ? design.motif.spec : null,
    }),
    palette: compactStyleTokens({
      background: clippedStyleToken(theme.colors.background, 9),
      surface: clippedStyleToken(theme.colors.surface, 9),
      primary: clippedStyleToken(theme.colors.primary, 9),
      accent: clippedStyleToken(theme.colors.accent, 9),
      text: clippedStyleToken(theme.colors.text, 9),
      textMuted: clippedStyleToken(theme.colors.textMuted, 9),
      onDarkText: clippedStyleToken(theme.colors.onDarkText, 9),
      chartSeries: theme.colors.chartSeries.slice(0, 4),
    }),
    typeScale: Object.fromEntries(TYPE_TOKENS.map((token) => [token, theme.typeScale[token]])),
    fonts: compactStyleTokens({
      heading: clippedStyleToken(theme.fonts.heading, 40),
      body: clippedStyleToken(theme.fonts.body, 40),
      headingBold: theme.fonts.headingBold,
    }),
    spacing: {
      margin: theme.spacing.margin,
      gutter: theme.spacing.gutter,
      cardPadding: theme.spacing.cardPadding,
      cornerRadius: theme.spacing.cornerRadius,
    },
    decoration: compactStyleTokens({
      cardStroke: theme.decoration.cardStroke === null ? null : clippedStyleToken(theme.decoration.cardStroke, 9),
      cardStrokeWidthPt: finiteStyleToken(theme.decoration.cardStrokeWidthPt),
      cardShadow: theme.decoration.cardShadow,
      divider: theme.decoration.divider,
      imageFit: theme.decoration.imageFit,
    }),
    componentDefaults: {
      surface: design.surface,
      separator: design.separator,
      align: design.align,
      density: design.density,
      numeral: design.numeral,
      accent: design.accent,
    },
  });

  if (JSON.stringify(tokens).length <= STYLE_TOKENS_MAX_CHARS) return tokens;
  delete (tokens.palette as Record<string, unknown>).chartSeries;
  if (JSON.stringify(tokens).length <= STYLE_TOKENS_MAX_CHARS) return tokens;
  const palette = tokens.palette as Record<string, unknown>;
  const reducedPalette: Record<string, unknown> = {};
  for (const key of ["background", "primary", "accent"]) {
    if (palette[key] !== undefined) reducedPalette[key] = palette[key];
  }
  tokens.palette = reducedPalette;
  return tokens;
}

/** 散文要点 → pointList 条目：找得到短帽（冒号/逗号/年份头）就拆标签，否则编号标签。 */
function pointListItem(point: string, index: number): { label: string; body: string } {
  const text = point.trim();
  const colon = text.search(/[：:]/);
  if (colon >= 2 && colon <= 12) {
    const body = text.slice(colon + 1).trim();
    if (body) return { label: text.slice(0, colon).trim(), body: body.slice(0, 100) };
  }
  const comma = /^([^，,。；\n]{2,12})[，,]/.exec(text);
  if (comma) {
    const body = text.slice(comma[1]!.length + 1).trim();
    if (body) return { label: comma[1]!.trim(), body: body.slice(0, 100) };
  }
  const year = /^([12]\d{3}\s*年(?:\s*[0-9一二三四五六七八九十]{1,3}\s*月)?)[\s，,]/.exec(text);
  if (year) {
    const body = text.slice(year[0].length).trim();
    if (body) return { label: year[1]!.trim(), body: body.slice(0, 100) };
  }
  return { label: `要点 ${String(index + 1).padStart(2, "0")}`, body: text.slice(0, 100) };
}

/** data 的 KPI 行（「指标: 数值 单位（+x%）」）→ stats 条目；图表行跳过；最多 4 条。 */
function kpiStatsItems(data: string): { value: string; label: string; unit?: string }[] {
  const items: { value: string; label: string; unit?: string }[] = [];
  for (const lineRaw of data.split("\n")) {
    if (items.length >= 4) break;
    const line = lineRaw.trim();
    if (!line || /^[a-zA-Z][a-zA-Z0-9]*\s*\|/.test(line)) continue;
    const at = line.search(/[：:]/);
    if (at < 1) continue;
    const rest = line.slice(at + 1).trim();
    const m = /^([\d,.．]+)\s*([^（(\s]+)?/.exec(rest);
    if (!m) continue;
    const growth = /[（(]([+±-][^）)]*)[）)]/.exec(rest);
    const base = line.slice(0, at).trim();
    const label = (growth ? `${base}（${growth[1]!.trim()}）` : base).slice(0, 40);
    const unit = m[2] ?? "";
    items.push({ value: m[1]!, label, ...(unit ? { unit: unit.slice(0, 8) } : {}) });
  }
  return items;
}

/**
 * 布局代理失败/未交树时的确定性兜底：要点条目化进 pointList、KPI 行进 stats。
 * 兜底保页数不断链，也保版式不退回圆点文本墙——最坏情况落地的仍是结构化条目。
 */
function fallbackTree(page: PageInput): LayoutTree {
  const points = Array.isArray(page.points)
    ? page.points.filter((p): p is string => typeof p === "string" && Boolean(p.trim())).slice(0, 4)
    : [];
  const statsItems = kpiStatsItems(typeof page.data === "string" ? page.data : "");
  const pointItems = points.slice(0, 3).map((point, index) => pointListItem(point, index));
  const children: unknown[] = [];
  const bothSections = pointItems.length >= 2 && statsItems.length >= 2;
  // 左右分栏时 stats 列变窄，长数字会触发组件宽度闸；窄列改用纵向布局，数字可跨满列。
  if (statsItems.length >= 2) children.push({ type: "component", name: "stats", ...(bothSections ? { layout: "column" } : {}), items: statsItems });
  if (pointItems.length >= 2) children.push({ type: "component", name: "pointList", numbered: true, items: pointItems });
  else if (pointItems.length === 1) children.push({ type: "text", variant: "body", text: points[0]!.slice(0, 200) });
  if (children.length === 0) children.push({ type: "text", variant: "subtitle", text: "内容生成中断，本页为兜底版式" });
  // 两段并存走左右分栏：上下叠放时 64pt KPI 与条目列的高度加起来装不下内容区。
  const both = children.length === 2;
  const normalized = normalizeTree({
    role: typeof page.role === "string" ? page.role : "content",
    ...(typeof page.title === "string" && page.title.trim() ? { title: page.title.slice(0, 80) } : {}),
    direction: both ? "row" : "column",
    gapScale: 1.5,
    ...(both ? { weights: [1, 1.4] } : {}),
    children,
  });
  return normalized;
}

/** 减配页输入：要点砍半（至少保 2 条）、去图表行、去备注、密度降档——布局代理未交树时的第二次机会。 */
function trimmedPage(page: PageInput): PageInput {
  const points = Array.isArray(page.points)
    ? (page.points as unknown[]).filter((p): p is string => typeof p === "string" && Boolean(p.trim()))
    : [];
  const data = typeof page.data === "string"
    ? page.data.split("\n").filter((line) => !/^[a-zA-Z][a-zA-Z0-9]*\s*\|/.test(line.trim())).join("\n").trim()
    : undefined;
  const v2 = page.layoutVersion === 2
    ? {
        layoutVersion: 2,
        ...(typeof page.composition === "string" ? { composition: page.composition } : {}),
        ...(typeof page.emphasis === "string" ? { emphasis: page.emphasis } : {}),
        ...(typeof page.intent === "string" ? { intent: page.intent } : {}),
        ...(typeof page.takeaway === "string" ? { takeaway: page.takeaway } : {}),
        ...(page.copy ? { copy: page.copy } : {}),
        ...(page.neighbors ? { neighbors: page.neighbors } : {}),
        ...(page.budget ? { budget: page.budget } : {}),
      }
    : {};
  return {
    ...v2,
    ...(typeof page.title === "string" ? { title: page.title } : {}),
    ...(typeof page.role === "string" ? { role: page.role } : {}),
    density: "sparse",
    ...(points.length > 0 ? { points: points.slice(0, Math.max(2, Math.ceil(points.length / 2))) } : {}),
    ...(data ? { data } : {}),
    ...(page.data !== undefined && typeof page.data !== "string" ? { data: page.data } : {}),
    ...(page.materials !== undefined ? { materials: page.materials } : {}),
  };
}

const PAGE_DISPATCH_RETRY_DELAYS_MS = [2000, 6000];

/** 并发限额拒绝（框架无排队，满窗即硬拒）：与「代理跑完但树不合格」是两种失败。 */
function isConcurrencyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "subagent_concurrency_limit" || message === "subagent_global_concurrency_limit";
}

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
  base: { token: string; totalPages: number; styleBrief: string; styleTokens: Record<string, unknown> },
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
  if (page.layoutVersion === 2) {
    return {
      task: "layout",
      deckToken: base.token,
      pageIndex: index,
      totalPages: base.totalPages,
      layoutVersion: 2,
      role: typeof page.role === "string" ? page.role : "content",
      density: typeof page.density === "string" ? page.density : "standard",
      ...(typeof page.composition === "string" ? { composition: page.composition } : {}),
      ...(typeof page.emphasis === "string" ? { emphasis: page.emphasis } : {}),
      ...(typeof page.intent === "string" ? { intent: page.intent.slice(0, 200) } : {}),
      ...(typeof page.takeaway === "string" ? { takeaway: page.takeaway.slice(0, 40) } : {}),
      // v2 不传 planner 的动作标题：模型会拿它当 h1，压过 copy.message 并导致长标题换行。
      ...(page.copy ? { copy: page.copy } : {}),
      ...(page.data !== undefined && page.data !== null ? { data: page.data } : {}),
      ...(materials.length > 0 ? { materials } : {}),
      ...(Array.isArray(page.neighbors) && page.neighbors.length > 0 ? { neighbors: page.neighbors.slice(0, 2) } : {}),
      ...(page.budget ? { budget: page.budget } : {}),
      ...(typeof page.revisionFeedback === "string" && page.revisionFeedback.trim()
        ? { revisionFeedback: page.revisionFeedback.slice(0, 300) }
        : {}),
      ...(base.styleBrief ? { styleBrief: base.styleBrief } : {}),
      styleTokens: base.styleTokens,
    };
  }
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
    styleTokens: base.styleTokens,
  };
}

/**
 * 素材库检索可能返回缩略图（实测封面 300×168、产品图 480×360）；铺满页面后会糊成一片。
 * 落页前按 blob 头尺寸丢掉低清图：封面/沉浸页要求 1280×720，其余配图要求 800×450；
 * 宁可退化为纯色/图形版式，也不交付糊图。
 */
async function dropLowResolutionMaterials(
  pages: PageInput[],
  deps: Pick<LayouterTailDeps, "readMaterialBlob" | "fetchImageHead">,
  warnings: string[],
): Promise<void> {
  for (const [index, page] of pages.entries()) {
    const hero = page.role === "cover" || page.composition === "immersive";
    if (!Array.isArray(page.materials)) continue;
    const minWidth = hero ? 1280 : 800;
    const minHeight = hero ? 720 : 450;
    const kept: unknown[] = [];
    let dropped = 0;
    for (const material of page.materials as PageMaterial[]) {
      const url = typeof material?.url === "string" ? material.url : "";
      if (!/^(everroom-material:\/\/|https?:\/\/)/i.test(url)) {
        kept.push(material);
        continue;
      }
      let bytes: Uint8Array | null = null;
      try {
        const hash = /^everroom-material:\/\/([0-9a-f]{64})$/i.exec(url)?.[1];
        bytes = hash ? await deps.readMaterialBlob(hash.toLowerCase()) : await deps.fetchImageHead(url);
      } catch {
        bytes = null;
      }
      const dims = bytes ? imageDimensions(bytes) : null;
      if (dims && (dims.w < minWidth || dims.h < minHeight)) {
        dropped += 1;
        continue;
      }
      kept.push(material);
    }
    if (dropped > 0) {
      page.materials = kept;
      // 没有可用大图后，immersive/editorial 的硬约束不再成立；降为纯文字构图，避免整页被 validate 拒收。
      if (page.composition === "immersive") page.composition = "poster";
      else if (page.composition === "editorial") page.composition = "swiss";
      warnings.push(`第 ${index + 1} 页配图分辨率不足（<${minWidth}×${minHeight}），已丢弃 ${dropped} 张并退化版式`);
    }
  }
}

interface FinalPage {
  spec: Record<string, unknown>;
  degraded: boolean;
  focusHints: string[];
  defects: LayoutDefect[];
}

function finalizeTree(
  tree: LayoutTree,
  contract: LayoutContract,
  imageArs: Map<string, number>,
  options?: { pageIndex?: number; pageCount?: number },
): FinalPage {
  const result = compileTree(tree, contract, undefined, options);
  const defects = measureDefects(result, contract, { imageArs });
  if (defects.length === 0) {
    return { spec: result.spec as unknown as Record<string, unknown>, degraded: false, focusHints: [], defects };
  }
  const shrunk = shrinkToFit(tree, contract, { imageArs });
  return {
    spec: shrunk.result.spec as unknown as Record<string, unknown>,
    degraded: shrunk.degraded,
    focusHints: shrunk.defects.map((d) => `${d.path}：${d.detail}`),
    defects: shrunk.defects,
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

  const warnings: string[] = [];
  /** deck 标题（收尾真完成载荷与补发 done 共用）。 */
  const deckTitle = (typeof plan.title === "string" && plan.title.trim() ? plan.title : armPlan.title).slice(0, 120);
  /** 已落定页（页号）；最终 page_applied 的 doneCount 与 completed 都以它为准。 */
  const appliedPages = new Set<number>();
  const appliedSlideIndex = new Map<number, number>();
  const appliedFocusHints = new Map<number, string[]>();
  /** 失败/退化页（页号）：引擎降档、兜底版式、落页失败、未落定。 */
  const degradedPages = new Set<number>();
  const contract = contractFromStyleParams(args.styleParams as never);
  // 风格卡 token 快照每 run 只算一次，v1/v2/重排/减配输入共用同一份。
  const styleTokens = styleTokensFrom(contract.theme);
  await dropLowResolutionMaterials(pages, deps, warnings);
  const imageArs = await resolveImageArs(materialUrls(pages), {
    readMaterialBlob: deps.readMaterialBlob,
    fetchHead: deps.fetchImageHead,
  });
  const token = `${args.runId}:layout`;
  registerDeckLayoutContext(token, { contract, imageArs });
  const bridge = deps.bridge;
  if (bridge && typeof bridge.renderPptx === "function") {
    registerPagePreview(token, {
      contract,
      imageArs,
      pageCount: pages.length,
      previewed: new Set(),
      render: async (rawTree, pageIndex) => {
        let tree: LayoutTree;
        try {
          tree = normalizeTree(rawTree);
        } catch (error) {
          return { defects: [{ path: "root", type: "overflow", detail: error instanceof Error ? error.message : String(error), hint: "按 v2 语法修正树" }], png: null, visual: null };
        }
        const compiled = compileTree(tree, contract, undefined, { pageIndex: pageIndex + 1, pageCount: pages.length });
        const defects = measureDefects(compiled, contract, { imageArs });
        const blocking = new Set(["overlap", "emoji", "overflow", "font_floor", "canvas", "element_cap"]);
        if (defects.some((defect) => blocking.has(defect.type))) {
          return { defects, png: null, visual: null };
        }
        try {
          if (!bridge.renderPptx) return { defects, png: null, visual: null, error: "renderPptx unavailable" };
          const pptx = await bridge.renderPptx({ title: "单页预览", pages: [JSON.stringify(compiled.spec)] });
          const png = await pptxToPng(pptx);
          const visual = deps.visualReviewer ? await deps.visualReviewer.reviewDesign(png) : null;
          return { defects, png, visual };
        } catch (error) {
          return { defects, png: null, visual: null, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  }

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

  let fileEntryId = "";
  let originalName: string | null = null;

  /** 最终全量快照：全部页落定后的真完成载荷（failedPages 用 0 起页序）。 */
  const finalPayloadFor = (completed: boolean, failedPages: number[]): Record<string, unknown> => ({
    stage: "page_applied",
    title: deckTitle,
    totalPages: pages.length,
    doneCount: appliedPages.size,
    roomId: args.roomId,
    documentId: args.draftDocumentId,
    pages: armPlan.pages.slice(0, 24),
    completed,
    ...(fileEntryId ? { fileEntryId } : {}),
    ...(originalName ? { fileName: originalName } : {}),
    ...(completed && args.draftDocumentId ? { draftArchived: true } : {}),
    ...(failedPages.length > 0 ? { failedPages } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(armPlan.narrative ? { narrative: armPlan.narrative } : {}),
    updatedAt: Date.now(),
  });
  /** 补发 done：deferDone 生成期不广播，「全部页落定」才是真完成。失败不阻塞工具结果。 */
  const notifyComplete = async (completed: boolean, failedPages: number[]): Promise<void> => {
    if (!fileEntryId) return;
    try {
      await bridge.completeDeck?.({
        fileId: fileEntryId,
        title: deckTitle,
        ...(originalName ? { originalName } : {}),
        roomId: args.roomId,
        completed,
        appliedPages: appliedPages.size,
        totalPages: pages.length,
        ...(failedPages.length > 0 ? { failedPages } : {}),
      });
    } catch {
      // 完成通知是体验增强，失败不影响已落好的产物。
    }
  };

  try {
    const outline = pages.map((p) => (typeof p.title === "string" && p.title.trim() ? p.title : "未命名页").slice(0, 80));
    const deckIdempotency = `agent-slides:${createHash("sha256").update(JSON.stringify([args.runId, deckTitle]), "utf8").digest("hex")}`;
    const created = await bridge.generate({
      title: deckTitle,
      format: "pptx",
      pages: [skeletonPageSpec(deckTitle, outline[0]!, 0, outline.length)],
      roomId: args.roomId,
      fileName: null,
      idempotencyKey: deckIdempotency,
      deferDone: true,
    });
    if (!created.fileEntryId) return fail("slides_office_generation_failed", "桌面端未返回文件条目");
    fileEntryId = created.fileEntryId;
    originalName = created.originalName ?? null;
    deps.visualReviewer?.forgetDeck(fileEntryId);

    const styleBrief = styleBriefFrom(args.styleParams);
    const base = { token, totalPages: pages.length, styleBrief, styleTokens };

    // 每页并发取树（页序占位）。窗口=网关全局子代理并发默认值（NXCORE_SUBAGENT_MAX_CONCURRENT，
    // 缺省 8；环境改小时 dispatch 被拒会走页级退避重试，安全）。失败页确定性兜底，不中断整册。
    // 落页与取树流水线化：worker 只负责挂起限流，落页循环另行按页序消费同一批 promise，
    // 树到一页落一页，不等整册树齐。
    type TreeOutcome = { tree: LayoutTree; fellBack: boolean; unavailable?: boolean };
    const trees: TreeOutcome[] = new Array(pages.length);
    const treePromises: Promise<TreeOutcome>[] = new Array(pages.length);
    const fetchTreeOutcome = async (index: number): Promise<TreeOutcome> => {
      const input = layouterInputFor(base, pages[index]!, index);
      try {
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `page:${index}`, input), args.parentRunId));
        const placed = treeFromInvocation(invocation, pages[index]!);
        if (!placed.fellBack) {
          const page = pages[index]!;
          if (page.layoutVersion === 2 && typeof page.composition === "string"
            && placed.tree.version === 2 && placed.tree.v2?.composition !== page.composition) {
            warnings.push(
              `第 ${index + 1} 页 composition 与 storyboard 不一致（${page.composition}→${placed.tree.v2?.composition ?? "?"}），按实际落页`,
            );
          }
          if (page.layoutVersion === 2 && placed.tree.version === 2 && placed.tree.v2) {
            const richness = visualRichnessIssues(placed.tree.v2);
            if (richness.length > 0) {
              const revisionPage = { ...page, revisionFeedback: richness.join("；") };
              const revisionInput = layouterInputFor(base, revisionPage, index);
              try {
                const revision = await dispatchWithPageRetry(() =>
                  deps.dispatchPage(revisionInput, deps.makeKey(args.runId, "slides-layouter", `visual:${index}`, revisionInput), args.parentRunId));
                const revised = treeFromInvocation(revision, revisionPage);
                if (!revised.fellBack && revised.tree.version === 2 && revised.tree.v2
                  && visualRichnessIssues(revised.tree.v2).length === 0) {
                  warnings.push(`第 ${index + 1} 页视觉丰富度不足，已按闸门提示补图形`);
                  return revised;
                }
              } catch {
                // 视觉补救失败：保留原树并告警，不阻塞整册。
              }
              warnings.push(`第 ${index + 1} 页视觉丰富度不足（纯文字白底），保留当前树`);
            }
          }
          return placed;
        }
        // 布局代理未交树（失败/超时/坏树）：减配重试一次——砍半要点、去图表行、
        // 去备注、密度降档；仍不收敛才落兜底。dispatch 被拒（并发限额）不算未交树，走 catch 退避。
        const trimmed = trimmedPage(pages[index]!);
        const retryInput = layouterInputFor(base, trimmed, index);
        try {
          const retry = await dispatchWithPageRetry(() =>
            deps.dispatchPage(retryInput, deps.makeKey(args.runId, "slides-layouter", `page:${index}:trimmed`, retryInput), args.parentRunId));
          const retryPlaced = treeFromInvocation(retry, pages[index]!);
          if (retryPlaced.fellBack) return placed;
          warnings.push(`第 ${index + 1} 页布局代理减配重试后收敛`);
          return retryPlaced;
        } catch {
          return placed;
        }
      } catch (error) {
        // 并发窗口被占满（dispatch 退避/容量等待都耗尽）＝代理不可用，不是「代理交了坏树」：
        // 记为 unavailable 供整册判定，避免把「20 页兜底版式」当成成功交付（2026-10-20 事故）。
        return {
          tree: fallbackTree(pages[index]!),
          fellBack: true,
          ...(isConcurrencyLimitError(error) ? { unavailable: true } : {}),
        };
      }
    };
    let cursor = 0;
    const workerCount = Math.min(8, pages.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= pages.length) return;
        treePromises[index] = fetchTreeOutcome(index);
        // worker 等本页完成才认领下一页：并发窗口语义不变（fetchTreeOutcome 永不 reject）。
        await treePromises[index];
      }
    });

    // 按页序流式落页：第 N 页树就绪即 fill + 进度广播，不等整册树齐。
    // 两条防线：① 降档后仍有引擎硬闸类缺陷（重叠/emoji/溢出）的页落确定性兜底版式，
    // 不把会被引擎拒绝的 spec 送下去；② slideIndex 跟踪 deck 活页数（某页失败后
    // 后续页按「追加」语义落，不会越界级联失败）。重排重落不重复计数：按页号集合统计。
    const BLOCKING_DEFECTS = new Set(["overlap", "emoji", "overflow", "font_floor", "canvas", "element_cap"]);
    let livePageCount = 1;
    const applyPage = async (index: number, tree: LayoutTree): Promise<boolean> => {
      // 页脚页码用逻辑页号（1 基）；总页数按计划页数（落页失败的页不占页码）。
      const footerOpts = { pageIndex: index + 1, pageCount: pages.length };
      let final = finalizeTree(tree, contract, imageArs, footerOpts);
      if (final.degraded) {
        degradedPages.add(index);
        clearPagePreviewed(token, index);
        warnings.push(`第 ${index + 1} 页经引擎降档兜底装下内容`);
      }
      if (final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
        degradedPages.add(index);
        clearPagePreviewed(token, index);
        warnings.push(`第 ${index + 1} 页布局树未收敛（${final.defects[0]!.type}），已用兜底版式`);
        final = finalizeTree(fallbackTree(pages[index]!), contract, imageArs, footerOpts);
      }
      const specJson = JSON.stringify(final.spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        degradedPages.add(index);
        warnings.push(`第 ${index + 1} 页 PageSpec 超长，跳过`);
        return false;
      }
      const slideIndex = Math.min(index, livePageCount);
      const result = await bridge.fillPage({ fileId: fileEntryId, slideIndex, specJson });
      if (!result.ok || result.applied !== true) {
        degradedPages.add(index);
        warnings.push(`第 ${index + 1} 页落页失败（${result.error ?? "桌面端拒绝"}）`);
        return false;
      }
      livePageCount = Math.max(livePageCount, slideIndex + 1);
      progress?.notify(progressKey, slideIndex);
      appliedPages.add(index);
      appliedSlideIndex.set(index, slideIndex);
      if (final.focusHints.length > 0) appliedFocusHints.set(index, final.focusHints);
      // 无审页代理时退回旧 VLM 封闭清单复检（有 dispatchReview 时审页统一在收尾阶段做）。
      if (!deps.dispatchReview && deps.visualReviewer) {
        let review: VisualReviewOutcome | null = null;
        try {
          review = await deps.visualReviewer.reviewPage({
            fileId: fileEntryId,
            slideIndex,
            fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId: fileEntryId, slideIndex }), "base64"),
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
      const outcome = await treePromises[index]!;
      trees[index] = outcome;
      if (outcome.fellBack) {
        warnings.push(`第 ${index + 1} 页布局代理未收敛，已用兜底版式`);
      }
      await applyPage(index, outcome.tree);
    }
    // 兜底：顺序循环 await 到最后一页后 workers 必已近尾，此处只收尾微任务。
    await Promise.all(workers);

    // 代理不可用（并发窗口被占满、dispatch 容量等待耗尽）的页达到半数：这一轮根本没拿到
    // 版面，落下的是兜底版式整册。不要以 completed 交付——2026-10-20 事故里 20/20 页兜底
    // 却回成功，用户拿到一本无配图、无图表的 deck。这里回报可重试失败（已落页保留，
    // 重试可复用已完成页），让上层重试而不是假装完成。
    const unavailablePages = trees
      .map((outcome, index) => (outcome?.unavailable === true ? index : -1))
      .filter((index) => index >= 0);
    if (unavailablePages.length >= Math.max(1, Math.ceil(pages.length / 2))) {
      const busyFailedPages = [...new Set([
        ...unavailablePages,
        ...[...pages.keys()].filter((index) => !appliedPages.has(index)),
      ])].sort((a, b) => a - b);
      warnings.push(`布局代理并发不可用：${unavailablePages.length}/${pages.length} 页未取到布局树，本轮不交付兜底整册`);
      const busyPayload = finalPayloadFor(false, busyFailedPages);
      args.onUpdate?.({ content: JSON.stringify(busyPayload), details: busyPayload });
      await notifyComplete(false, busyFailedPages);
      return fail(
        "slides_layout_agents_unavailable",
        `布局代理并发窗口被占满（${unavailablePages.length}/${pages.length} 页未取到布局树）。本轮不产出兜底整册：已落页进度保留，稍后重试会复用已完成页面。`,
        true,
        {
          ...(fileEntryId ? { fileEntryId } : {}),
          failedPages: busyFailedPages,
          warnings,
        },
      );
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
          clearPagePreviewed(token, index);
          warnings.push(`第 ${index + 1} 页与邻页结构雷同，已重排`);
          await applyPage(index, rerolled.tree);
        }
      } catch {
        // 重排失败保留原页
      }
    }

    // 审页阶段：slides-reviewer 并发看最终页态（窗口 4）。截图经 attachments 直投
    // 多模态模型；revised 的页网关机械套用修正树重落一次（每页至多一次修正）。
    // 审页代理失败/超时的页降级跑旧 VLM 封闭清单（warning 保底）。
    if (deps.dispatchReview) {
      // 已在 layouter 内通过 slides_page_preview 自查的页，不再另起 reviewer；
      // 未预览的页仍保留 reviewer 兜底（兼容旧链路/模型未调用预览）。
      const reviewIndexes = [...appliedPages].filter((pageIndex) => !wasPagePreviewed(token, pageIndex)).sort((a, b) => a - b);
      let reviewCursor = 0;
      const reviewWorker = async (): Promise<void> => {
        for (;;) {
          const index = reviewCursor++;
          if (index >= reviewIndexes.length) return;
          const pageIndex = reviewIndexes[index]!;
          const slideIndex = appliedSlideIndex.get(pageIndex) ?? pageIndex;
          const manualToken = `${token}#${String(pageIndex)}`;
          registerReviewManual(manualToken, {
            deckToken: token,
            page: pages[pageIndex] as Record<string, unknown>,
            currentTree: trees[pageIndex]!.tree,
          });
          try {
            // 压缩后再投：PNG 无损在背景图页可达 1.5MB+，直投会 413；失败回退原图。
            const rawPng = await bridge.renderPage({ fileId: fileEntryId, slideIndex });
            let shotBase64 = rawPng;
            let shotMime = "image/png";
            try {
              shotBase64 = await pngBase64ToJpegBase64(rawPng);
              shotMime = "image/jpeg";
            } catch {
              // sips 不可用时保持原 PNG 行为
            }
            const invocation = await dispatchWithPageRetry(() => deps.dispatchReview!(
              {
                task: "review",
                manualToken,
                pageIndex,
                totalPages: pages.length,
                ...(typeof (pages[pageIndex] as { title?: unknown }).title === "string"
                  ? { title: (pages[pageIndex] as { title: string }).title.slice(0, 80) }
                  : {}),
                ...(typeof (pages[pageIndex] as { role?: unknown }).role === "string"
                  ? { role: (pages[pageIndex] as { role: string }).role }
                  : {}),
                ...(typeof (pages[pageIndex] as { density?: unknown }).density === "string"
                  ? { density: (pages[pageIndex] as { density: string }).density }
                  : {}),
                styleTokens: base.styleTokens,
                ...((pages[pageIndex] as PageInput).layoutVersion === 2
                  ? {
                      layoutVersion: 2,
                      ...(typeof (pages[pageIndex] as PageInput).composition === "string"
                        ? { composition: (pages[pageIndex] as PageInput).composition as string }
                        : {}),
                      ...(typeof (pages[pageIndex] as PageInput).emphasis === "string"
                        ? { emphasis: (pages[pageIndex] as PageInput).emphasis as string }
                        : {}),
                      ...((pages[pageIndex] as PageInput).budget
                        ? { budget: (pages[pageIndex] as PageInput).budget }
                        : {}),
                    }
                  : {}),
              },
              deps.makeKey(args.runId, "slides-reviewer", `review:${pageIndex}`, { pageIndex }),
              args.parentRunId,
              [{ filename: `page-${String(pageIndex + 1)}.${shotMime === "image/jpeg" ? "jpg" : "png"}`, mimeType: shotMime, kind: "image", dataUrl: `data:${shotMime};base64,${shotBase64}` }],
            ));;
            if (invocation.status !== "completed") {
              throw new Error(invocation.errorCode ?? invocation.status);
            }
            const structured = invocation.result?.structuredOutput;
            const revisedTree = structured !== null && typeof structured === "object" && !Array.isArray(structured)
              ? (structured as Record<string, unknown>).tree
              : null;
            if (revisedTree !== null && typeof revisedTree === "object" && !Array.isArray(revisedTree)) {
              let tree: LayoutTree;
              try {
                tree = normalizeTree(revisedTree);
              } catch {
                warnings.push(`第 ${pageIndex + 1} 页审页修正树非法，保留原页`);
                continue;
              }
              if ((pages[pageIndex] as PageInput).layoutVersion === 2 && tree.version !== 2) {
                warnings.push(`第 ${pageIndex + 1} 页审页修正降回 v1，保留原页`);
                continue;
              }
              const final = finalizeTree(tree, contract, imageArs);
              if (final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
                warnings.push(`第 ${pageIndex + 1} 页审页修正未收敛，保留原页`);
                continue;
              }
              const reapplied = await bridge.fillPage({
                fileId: fileEntryId,
                slideIndex,
                specJson: JSON.stringify(final.spec),
              });
              if (reapplied.ok && reapplied.applied === true) {
                trees[pageIndex] = { tree, fellBack: false };
                warnings.push(`第 ${pageIndex + 1} 页经审页代理重排`);
              } else {
                warnings.push(`第 ${pageIndex + 1} 页审页重落失败，保留原页`);
              }
            }
          } catch {
            // 审页代理不可用/失败：该页降级跑旧 VLM 封闭清单。
            if (deps.visualReviewer) {
              try {
                const review = await deps.visualReviewer.reviewPage({
                  fileId: fileEntryId,
                  slideIndex,
                  fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId: fileEntryId, slideIndex }), "base64"),
                  ...(appliedFocusHints.get(pageIndex)?.length ? { focusHints: appliedFocusHints.get(pageIndex)! } : {}),
                });
                if (review.status === "fail") {
                  warnings.push(`第 ${pageIndex + 1} 页视觉复检不通过${review.retriesExhausted ? "（重试上限，放行）" : ""}`);
                }
              } catch {
                // 复检也失败：放行（warning 已有审页失败信息时不再叠加）
              }
            } else {
              warnings.push(`第 ${pageIndex + 1} 页审页代理失败，跳过审页`);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, reviewIndexes.length) }, () => reviewWorker()));
    }

    // 失败/退化页（0 起页序）：未落定、引擎降档兜底、布局代理兜底都算——完成摘要要能定位。
    const failedPages = [...new Set(
      [...pages.keys()].filter((index) =>
        !appliedPages.has(index) || degradedPages.has(index) || trees[index]?.fellBack === true),
    )].sort((a, b) => a - b);
    const completed = appliedPages.size === pages.length;
    if (appliedPages.size === 0) {
      const zeroPayload = finalPayloadFor(false, failedPages);
      args.onUpdate?.({ content: JSON.stringify(zeroPayload), details: zeroPayload });
      await notifyComplete(false, failedPages);
      return fail("slides_layout_apply_failed", "全部页面落页失败；方案已就绪，可重试 generate。", true, { fileEntryId, failedPages });
    }
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
    // 最终全量快照 + 真完成通知（done 后移到全部页落定）。
    const finalPayload = finalPayloadFor(completed, failedPages);
    args.onUpdate?.({ content: JSON.stringify(finalPayload), details: finalPayload });
    await notifyComplete(completed, failedPages);
    return {
      content: JSON.stringify({
        ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
        status: completed ? "completed" : "partial",
        fileEntryId,
        fileName: originalName,
        pages: appliedPages.size,
        outline,
        warnings,
        ...(failedPages.length > 0 ? { failedPages } : {}),
        summary: completed
          ? `已生成 ${appliedPages.size} 页演示文稿`
          : `已生成 ${appliedPages.size}/${pages.length} 页，未完成页可重试`,
      }),
      details: { fileEntryId, pages: appliedPages.size, warnings, failedPages },
    };
  } catch (error) {
    // 异常也尽量给出可定位的失败页并补完成通知，避免前端停在「生成中」。
    const failedPages = [...pages.keys()].filter((index) => !appliedPages.has(index));
    const catchPayload = finalPayloadFor(false, failedPages);
    args.onUpdate?.({ content: JSON.stringify(catchPayload), details: catchPayload });
    await notifyComplete(false, failedPages);
    return fail(
      "slides_layout_tail_failed",
      `布局树落页失败：${error instanceof Error ? error.message : String(error)}`,
      true,
      { ...(fileEntryId ? { fileEntryId } : {}), failedPages },
    );
  } finally {
    dropDeckLayoutContext(token);
    dropPagePreview(token);
    dropReviewManuals(`${token}#`);
    progress?.disarm(progressKey);
  }
}
