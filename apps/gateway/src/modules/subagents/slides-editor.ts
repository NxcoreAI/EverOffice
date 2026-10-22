/**
 * slides-editor 影子模式：用户确认草稿后，把 draftPages 交给 slides-editor 压成
 * storyboard/v2，并在网关侧做确定性预算与保真检查。
 *
 * M1 只做影子：结果落库 + 进 tool details，不替换现有 planner arrange 方案；
 * 装配层默认启用，不依赖 .env；关闭只需在 create-server 不传 slidesEditor。
 */

import { createHash } from "node:crypto";
import type { SubagentInvocation } from "@nxcore/agent-contract";

export const EDITOR_COMPOSITIONS = ["immersive", "hero-data", "editorial", "swiss", "poster", "chapter"] as const;

/** 风格卡构图家族 → storyboard 允许的构图集合（核心家族必须出现，且至少半数页落在家族内）。 */
export const DECK_COMPOSITION_FAMILIES = {
  swiss: { core: "swiss", preferred: ["swiss", "hero-data", "editorial"] },
  editorial: { core: "editorial", preferred: ["editorial", "swiss", "quote", "hero-data"] },
  poster: { core: "poster", preferred: ["poster", "hero-data", "chapter", "immersive"] },
  immersive: { core: "immersive", preferred: ["immersive", "chapter", "poster", "hero-data"] },
} as const;

export interface StoryboardCheckOptions {
  /** 风格卡 composition：用于校验 storyboard 的构图节奏是否忠于风格卡。 */
  deckComposition?: string;
}
export const EDITOR_ROLES = ["cover", "section", "content", "data", "table", "flow", "quote", "closing"] as const;
export const EDITOR_EMPHASIS = ["title", "number", "image", "quote", "chart", "table"] as const;
export const EDITOR_DENSITIES = ["sparse", "standard", "dense"] as const;

const METADATA_RE = /全篇|页数|页配比|板块配比|平均每页|约\s*\d+\s*分钟|共\s*\d+\s*页|受众[:：]|制作说明/;
/** 页面文案里的 AI 套话/免责声明：只应进 speakerNotes，不应进 copy。 */
const AI_FLAVOR_RE = /(统计口径|口径待|待核实|待补充|未核实|仅作参考|仅供参考|本页为|占位|待确认|不完全对应|尚无第三方验证|未附证明|未标注负责|按原始口径)/;
const ELLIPSIS_RE = /(?:…{2,}|\.{3,}|·{4,}|···)/;

function hasAiFlavor(value: string | undefined): boolean {
  return Boolean(value && (AI_FLAVOR_RE.test(value) || ELLIPSIS_RE.test(value)));
}

function cleanCopyText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/(?:…{2,}|\.{3,}|·{4,}|···)/g, "").trim();
  return text || undefined;
}

/** 页面 copy 去 AI 味：去掉免责声明/省略号；口径与待核实留给讲稿。 */
export function scrubPageCopy(copy: EditorCopy): EditorCopy {
  const supporting = copy.supporting.filter((item) => !hasAiFlavor(item));
  const facts = copy.facts
    .filter((fact) => !hasAiFlavor(fact.label) && !hasAiFlavor(fact.value) && !hasAiFlavor(fact.body))
    .map(({ note, ...rest }) => ({
      ...rest,
      ...(note && !hasAiFlavor(note) ? { note } : {}),
    }));
  const sourceParts = (copy.source ?? "").split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  const source = sourceParts.filter((part) => !hasAiFlavor(part)).join("；").slice(0, 80) || undefined;
  const quote = copy.quote
    ? {
        ...(cleanCopyText(copy.quote.text) ? { text: cleanCopyText(copy.quote.text)! } : {}),
        ...(cleanCopyText(copy.quote.attribution) ? { attribution: cleanCopyText(copy.quote.attribution)! } : {}),
      }
    : undefined;
  return {
    ...copy,
    ...(copy.kicker ? { kicker: cleanCopyText(copy.kicker) ?? "" } : {}),
    message: cleanCopyText(copy.message) ?? copy.message,
    supporting,
    facts,
    ...(source ? { source } : {}),
    ...(quote && (quote.text || quote.attribution) ? { quote } : {}),
  };
}

export interface EditorFact {
  label?: string;
  value?: string;
  unit?: string;
  body?: string;
  note?: string;
}

export interface EditorCopy {
  kicker?: string;
  message: string;
  supporting: string[];
  facts: EditorFact[];
  quote?: { text?: string; attribution?: string };
  source?: string;
  speakerNotes: string;
}

export interface EditorDropped {
  from: string;
  text: string;
  reason: string;
  movedToNotes?: boolean;
}

export interface EditorPage {
  id: string;
  role: string;
  density: string;
  composition: string;
  emphasis: string;
  intent: string;
  takeaway: string;
  copy: EditorCopy;
  data?: Record<string, unknown>;
  visual?: Record<string, unknown>;
  dropped: EditorDropped[];
}

export interface EditorStoryboard {
  schemaVersion: "storyboard/v2";
  deck: {
    title: string;
    audience?: string;
    occasion?: string;
    durationMin?: number;
    spine: string;
    visualThesis?: string;
  };
  pages: EditorPage[];
  warnings: string[];
}

export interface EditorDraftPage {
  title?: string;
  points?: string[];
  data?: string;
  materialHints?: string;
  notes?: string;
}

export interface StoryboardCheck {
  errors: string[];
  warnings: string[];
  stats: {
    pages: number;
    draftPages: number;
    compositions: string[];
    proseChars: number;
    copyChars: number;
    draftPointsChars: number;
    dropped: number;
    speakerNotesChars: number;
  };
}

export interface ShadowPageReport {
  id: string;
  role: string;
  composition: string;
  emphasis: string;
  proseChars: number;
  copyChars: number;
  messageChars: number;
  supporting: number;
  facts: number;
  dropped: number;
  speakerNotesChars: number;
}

export interface EditorShadowReport {
  draftHash: string;
  pageCount: number;
  draftPageCount: number;
  compositions: string[];
  proseChars: number;
  copyChars: number;
  draftPointsChars: number;
  reductionPct: number | null;
  dropped: number;
  passed: boolean;
  errors: string[];
  warnings: string[];
  pages: ShadowPageReport[];
}

export function draftPagesHash(pages: EditorDraftPage[]): string {
  return createHash("sha256").update(JSON.stringify(pages), "utf8").digest("hex");
}

function stringValue(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxChars));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeDropped(value: unknown): EditorDropped[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw): EditorDropped | null => {
      const item = objectValue(raw);
      if (!item) return null;
      const from = stringValue(item.from, 80);
      const text = stringValue(item.text, 300);
      const reason = stringValue(item.reason, 120);
      if (!from || !text || !reason) return null;
      return { from, text, reason, ...(item.movedToNotes === true ? { movedToNotes: true } : {}) };
    })
    .filter((item): item is EditorDropped => item !== null)
    .slice(0, 40);
}

function normalizeCopy(value: unknown): EditorCopy {
  const raw = objectValue(value) ?? {};
  const quote = objectValue(raw.quote);
  return {
    ...(stringValue(raw.kicker, 40) ? { kicker: stringValue(raw.kicker, 40) } : {}),
    message: stringValue(raw.message, 200),
    supporting: stringArray(raw.supporting, 1, 120),
    facts: Array.isArray(raw.facts)
      ? raw.facts.slice(0, 3).map((item) => {
        const fact = objectValue(item) ?? {};
        return {
          ...(stringValue(fact.label, 40) ? { label: stringValue(fact.label, 40) } : {}),
          ...(stringValue(fact.value, 40) ? { value: stringValue(fact.value, 40) } : {}),
          ...(stringValue(fact.unit, 20) ? { unit: stringValue(fact.unit, 20) } : {}),
          ...(stringValue(fact.body, 60) ? { body: stringValue(fact.body, 60) } : {}),
          ...(stringValue(fact.note, 60) ? { note: stringValue(fact.note, 60) } : {}),
        };
      })
      : [],
    ...(quote && (stringValue(quote.text, 80) || stringValue(quote.attribution, 80))
      ? {
          quote: {
            ...(stringValue(quote.text, 80) ? { text: stringValue(quote.text, 80) } : {}),
            ...(stringValue(quote.attribution, 80) ? { attribution: stringValue(quote.attribution, 80) } : {}),
          },
        }
      : {}),
    ...(stringValue(raw.source, 120) ? { source: stringValue(raw.source, 120) } : {}),
    speakerNotes: stringValue(raw.speakerNotes, 400),
  };
}

/** 只做结构归一（id 补位、数组裁上限），不静默修预算——预算违规交给 checkStoryboard 报错。 */
export function normalizeStoryboard(raw: unknown): { storyboard: EditorStoryboard | null; errors: string[] } {
  const errors: string[] = [];
  const record = objectValue(raw);
  const body = record && objectValue(record.storyboard) ? objectValue(record.storyboard)! : record;
  if (!body) return { storyboard: null, errors: ["storyboard 不是对象"] };
  const deckRaw = objectValue(body.deck) ?? {};
  const title = stringValue(deckRaw.title, 120);
  const spine = stringValue(deckRaw.spine, 300);
  if (!title) errors.push("deck.title 缺失");
  if (!spine) errors.push("deck.spine 缺失");
  const pagesRaw = Array.isArray(body.pages) ? body.pages : [];
  if (pagesRaw.length < 1 || pagesRaw.length > 24) errors.push(`pages 数量 ${pagesRaw.length} 不在 1~24`);
  const pages: EditorPage[] = pagesRaw.slice(0, 24).map((item, index) => {
    const page = objectValue(item) ?? {};
    if (!Array.isArray(page.dropped)) errors.push(`第 ${index + 1} 页缺 dropped 数组`);
    return {
      id: stringValue(page.id, 64) || `page-${String(index + 1).padStart(2, "0")}`,
      role: stringValue(page.role, 20) || "content",
      density: stringValue(page.density, 20) || "standard",
      composition: stringValue(page.composition, 20) || "swiss",
      emphasis: stringValue(page.emphasis, 20) || "title",
      intent: stringValue(page.intent, 200),
      takeaway: stringValue(page.takeaway, 120),
      copy: normalizeCopy(page.copy),
      ...(objectValue(page.data) ? { data: objectValue(page.data)! } : {}),
      ...(objectValue(page.visual) ? { visual: objectValue(page.visual)! } : {}),
      dropped: normalizeDropped(page.dropped),
    };
  });
  return {
    storyboard: {
      schemaVersion: "storyboard/v2",
      deck: {
        title,
        ...(stringValue(deckRaw.audience, 300) ? { audience: stringValue(deckRaw.audience, 300) } : {}),
        ...(stringValue(deckRaw.occasion, 300) ? { occasion: stringValue(deckRaw.occasion, 300) } : {}),
        ...(typeof deckRaw.durationMin === "number" && Number.isFinite(deckRaw.durationMin)
          ? { durationMin: Math.max(1, Math.min(180, Math.round(deckRaw.durationMin))) }
          : {}),
        spine,
        ...(stringValue(deckRaw.visualThesis, 500) ? { visualThesis: stringValue(deckRaw.visualThesis, 500) } : {}),
      },
      pages,
      warnings: stringArray(body.warnings, 10, 300),
    },
    errors,
  };
}

export function proseLength(copy: EditorCopy): number {
  return [copy.message, ...copy.supporting, copy.quote?.text ?? ""].filter(Boolean).join(" ").length;
}

export function copyLength(copy: EditorCopy): number {
  return [
    copy.kicker,
    copy.message,
    ...copy.supporting,
    ...copy.facts.flatMap((fact) => [fact.label, fact.value, fact.unit, fact.body, fact.note]),
    copy.quote?.text,
    copy.quote?.attribution,
    copy.source,
  ].filter((value): value is string => typeof value === "string").join(" ").length;
}

function proseBudget(role: string): number {
  if (role === "cover") return 60;
  if (role === "data" || role === "table") return 60;
  return 80;
}

/**
 * 确定性验收：与设计文档 §6.1 C1~C9 同口径。返回的 errors 非空即 editor 输出不可用；
 * 影子模式下只记录，不阻塞现有生成。
 */
export function checkStoryboard(
  storyboard: EditorStoryboard,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): StoryboardCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pages = storyboard.pages;
  if (pages.length !== draftPages.length) {
    errors.push(`页数 ${pages.length} 与草稿 ${draftPages.length} 不一致`);
  }
  if (!storyboard.deck.title) errors.push("deck.title 缺失");
  if (!storyboard.deck.spine) errors.push("deck.spine 缺失");
  let proseChars = 0;
  let copyChars = 0;
  let speakerNotesChars = 0;
  let dropped = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const copy = page.copy;
    const where = `第 ${index + 1} 页`;
    if (!EDITOR_ROLES.includes(page.role as never)) errors.push(`${where}: role 非法 ${page.role}`);
    if (!EDITOR_DENSITIES.includes(page.density as never)) errors.push(`${where}: density 非法 ${page.density}`);
    if (!EDITOR_COMPOSITIONS.includes(page.composition as never)) errors.push(`${where}: composition 非法 ${page.composition}`);
    if (!EDITOR_EMPHASIS.includes(page.emphasis as never)) errors.push(`${where}: emphasis 非法 ${page.emphasis}`);
    const visualKind = page.visual && typeof page.visual.kind === "string" ? page.visual.kind : "none";
    if (!["none", "material", "generated"].includes(visualKind)) errors.push(`${where}: visual.kind 非法 ${visualKind}`);
    if (page.intent.length < 10 || page.intent.length > 60) errors.push(`${where}: intent ${page.intent.length} 字，需 10~60`);
    if (!page.takeaway || page.takeaway.length > 22) errors.push(`${where}: takeaway 需 1~22 字（当前 ${page.takeaway.length}）`);
    if (!copy.message || copy.message.length > 24) errors.push(`${where}: message 需 1~24 字（当前 ${copy.message.length}）`);
    if (copy.supporting.length > 1) errors.push(`${where}: supporting 最多 1 行`);
    if (copy.supporting.some((item) => item.length > 32)) errors.push(`${where}: supporting 单行超过 32 字`);
    if (copy.facts.length > 3) errors.push(`${where}: facts 最多 3 条`);
    for (const fact of copy.facts) {
      if (fact.label && fact.label.length > 10) errors.push(`${where}: fact label「${fact.label}」超过 10 字`);
      const value = fact.body ?? fact.value ?? "";
      if (value.length > 14) errors.push(`${where}: fact 值「${value}」超过 14 字`);
    }
    if (copy.kicker && copy.kicker.length > 12) errors.push(`${where}: kicker 超过 12 字`);
    if (copy.speakerNotes.length < 60 || copy.speakerNotes.length > 260) {
      errors.push(`${where}: speakerNotes 需 60~260 字（当前 ${copy.speakerNotes.length}）`);
    }
    if (copy.source && copy.source.length > 80) errors.push(`${where}: source 超过 80 字`);
    const prose = proseLength(copy);
    if (prose > proseBudget(page.role)) errors.push(`${where}: 叙事文字 ${prose} 字，超过 ${page.role} 预算 ${proseBudget(page.role)}`);
    const onSlide = [copy.kicker, copy.message, ...copy.supporting, copy.quote?.text].filter(Boolean).join(" ");
    if (METADATA_RE.test(onSlide)) errors.push(`${where}: 页面上出现制作元数据（页数/时长/受众/配比）`);
    const flavorText = [
      copy.kicker, copy.message, ...copy.supporting,
      ...copy.facts.flatMap((fact) => [fact.label, fact.value, fact.note]),
      copy.quote?.text, copy.source,
    ].filter(Boolean).join(" ");
    if (AI_FLAVOR_RE.test(flavorText) || ELLIPSIS_RE.test(flavorText)) {
      warnings.push(`${where}: copy 出现口径/待核实/省略号等 AI 套话——页面只留结论，meta 信息移讲稿`);
    }
    if (!Array.isArray(page.dropped)) errors.push(`${where}: dropped 必须是数组`);
    const draft = draftPages[index];
    const draftPoints = draft?.points?.length ?? 0;
    if (draftPoints > 0 && page.dropped.length === 0 && copy.supporting.length + copy.facts.length < draftPoints) {
      warnings.push(`${where}: 草稿 ${draftPoints} 条要点，本页 dropped 为空——请确认压缩项都有记录`);
    }
    proseChars += prose;
    copyChars += copyLength(copy);
    speakerNotesChars += copy.speakerNotes.length;
    dropped += page.dropped.length;
  }
  const compositions = [...new Set(pages.map((page) => page.composition))];
  if (pages.length >= 8 && compositions.length < 3) errors.push(`composition 仅 ${compositions.length} 种，≥8 页 deck 至少 3 种`);
  for (let index = 1; index < pages.length; index += 1) {
    if (pages[index]!.composition === pages[index - 1]!.composition) {
      warnings.push(`第 ${index + 1} 页与上一页 composition 相同，节奏可能单调`);
    }
  }
  if (pages.length >= 8) {
    const sparse = pages.filter((page) => page.density === "sparse").length;
    if (sparse < 2) warnings.push(`sparse 页仅 ${sparse} 页（≥8 页 deck 建议 ≥2）`);
  }
  const family = options.deckComposition
    ? DECK_COMPOSITION_FAMILIES[options.deckComposition as keyof typeof DECK_COMPOSITION_FAMILIES]
    : undefined;
  if (family && pages.length > 0) {
    const preferred = family.preferred as readonly string[];
    const inFamily = pages.filter((page) => preferred.includes(page.composition));
    const need = Math.ceil(pages.length / 2);
    if (!pages.some((page) => page.composition === family.core)) {
      errors.push(`构图家族 ${options.deckComposition}：没有一页使用 ${family.core} 作为核心构图——请至少安排 1 页 ${family.core}`);
    }
    if (inFamily.length < need) {
      errors.push(`构图家族 ${options.deckComposition}：仅 ${inFamily.length}/${pages.length} 页落在 ${preferred.join("/")}，需 ≥${need} 页`);
    }
  }
  return {
    errors,
    warnings,
    stats: {
      pages: pages.length,
      draftPages: draftPages.length,
      compositions,
      proseChars,
      copyChars,
      draftPointsChars: draftPages.reduce((sum, page) => sum + (page.points ?? []).reduce((n, point) => n + point.length, 0), 0),
      dropped,
      speakerNotesChars,
    },
  };
}

export function buildShadowReport(
  storyboard: EditorStoryboard,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): EditorShadowReport {
  const check = checkStoryboard(storyboard, draftPages, options);
  const { stats } = check;
  const reductionPct = stats.draftPointsChars > 0
    ? Math.round((1 - stats.proseChars / stats.draftPointsChars) * 100)
    : null;
  return {
    draftHash: draftPagesHash(draftPages),
    pageCount: stats.pages,
    draftPageCount: stats.draftPages,
    compositions: stats.compositions,
    proseChars: stats.proseChars,
    copyChars: stats.copyChars,
    draftPointsChars: stats.draftPointsChars,
    reductionPct,
    dropped: stats.dropped,
    passed: check.errors.length === 0,
    errors: check.errors,
    warnings: check.warnings,
    pages: storyboard.pages.map((page) => ({
      id: page.id,
      role: page.role,
      composition: page.composition,
      emphasis: page.emphasis,
      proseChars: proseLength(page.copy),
      copyChars: copyLength(page.copy),
      messageChars: page.copy.message.length,
      supporting: page.copy.supporting.length,
      facts: page.copy.facts.length,
      dropped: page.dropped.length,
      speakerNotesChars: page.copy.speakerNotes.length,
    })),
  };
}

export interface EditorDispatchInput {
  /** storyboard 批量压缩时本批首屏在整本 deck 中的 0-based 页码。 */
  pageOffset?: number;
  /** 整本 deck 页数；批量模式用于保持全局构图节奏。 */
  pageCount?: number;
  instruction: string;
  roomId: string;
  title: string;
  draftPages: EditorDraftPage[];
  audience?: string;
  occasion?: string;
  durationMin?: number;
  visualThesis?: string;
  /** 风格卡给内容侧的最小 design brief（构图家族/明暗/母题/主色系）。 */
  deckStyle?: Record<string, unknown>;
  /** 构图家族校验未过时的重排反馈（只用于第二次 dispatch）。 */
  compositionFeedback?: string;
}

export function buildEditorInput(input: EditorDispatchInput): Record<string, unknown> {
  return {
    instruction: input.instruction,
    roomId: input.roomId,
    title: input.title.slice(0, 120),
    draftPages: input.draftPages,
    ...(typeof input.pageOffset === "number" ? { pageOffset: input.pageOffset } : {}),
    ...(typeof input.pageCount === "number" ? { pageCount: input.pageCount } : {}),
    ...(input.audience ? { audience: input.audience.slice(0, 300) } : {}),
    ...(input.occasion ? { occasion: input.occasion.slice(0, 300) } : {}),
    ...(typeof input.durationMin === "number" ? { durationMin: input.durationMin } : {}),
    ...(input.visualThesis ? { visualThesis: input.visualThesis.slice(0, 500) } : {}),
    ...(input.deckStyle ? { deckStyle: input.deckStyle } : {}),
    ...(input.compositionFeedback ? { compositionFeedback: input.compositionFeedback.slice(0, 500) } : {}),
  };
}

/** 取 invocation 的结构化 storyboard；失败/未提交返回 null（影子模式只告警，不阻塞）。 */
export function storyboardFromInvocation(
  invocation: SubagentInvocation,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): { storyboard: EditorStoryboard | null; errors: string[] } {
  if (invocation.status !== "completed") {
    return { storyboard: null, errors: [`editor ${invocation.status}${invocation.errorCode ? `: ${invocation.errorCode}` : ""}`] };
  }
  const structured = invocation.result?.structuredOutput;
  const raw = structured !== null && typeof structured === "object" && !Array.isArray(structured)
    ? structured
    : (invocation.result?.text ?? "");
  const normalized = normalizeStoryboard(raw);
  if (!normalized.storyboard) return { storyboard: null, errors: normalized.errors };
  const check = checkStoryboard(normalized.storyboard, draftPages, options);
  return { storyboard: normalized.storyboard, errors: [...normalized.errors, ...check.errors] };
}


/** planner arrange 的 plan page → editor 输入页（白名单，避免把 materials 等未知字段塞进 input schema）。 */
export function editorPagesFromPlan(plan: Record<string, unknown>): EditorDraftPage[] {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  return pages
    .filter((page): page is Record<string, unknown> => page !== null && typeof page === "object" && !Array.isArray(page))
    .map((page) => ({
      ...(typeof page.title === "string" ? { title: page.title.slice(0, 80) } : {}),
      ...(Array.isArray(page.points)
        ? { points: (page.points as unknown[]).filter((point): point is string => typeof point === "string").slice(0, 8) }
        : {}),
      ...(typeof page.data === "string" ? { data: page.data.slice(0, 2000) } : {}),
      ...(typeof page.notes === "string" ? { notes: page.notes.slice(0, 300) } : {}),
    }));
}

function budgetForRole(role: string): { prose: number; copy: number; notes: number } {
  const prose = role === "cover" ? 60 : role === "data" || role === "table" ? 60 : 80;
  return { prose, copy: 120, notes: 260 };
}

/**
 * editor storyboard + planner plan → layouter 的 v2 plan。
 * 保留 plan 的 points/materials 作为 v1 兜底与配图来源；只把文案/构图/密度换成 storyboard 口径。
 * 页数不一致返回 null（调用方回退 v1，不静默错位）。
 */
export function mergeStoryboardIntoPlan(
  plan: Record<string, unknown>,
  storyboard: EditorStoryboard,
): Record<string, unknown> | null {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  if (pages.length !== storyboard.pages.length) return null;
  const merged = pages.map((raw, index) => {
    const page = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const story = storyboard.pages[index]!;
    const neighbors = [
      ...(index > 0
        ? [{
            pageIndex: index - 1,
            composition: storyboard.pages[index - 1]!.composition,
            takeaway: storyboard.pages[index - 1]!.takeaway.slice(0, 40),
          }]
        : []),
      ...(index + 1 < storyboard.pages.length
        ? [{
            pageIndex: index + 1,
            composition: storyboard.pages[index + 1]!.composition,
            takeaway: storyboard.pages[index + 1]!.takeaway.slice(0, 40),
          }]
        : []),
    ];
    return {
      ...page,
      role: story.role,
      density: story.density,
      layoutVersion: 2,
      composition: story.composition,
      emphasis: story.emphasis,
      intent: story.intent,
      takeaway: story.takeaway,
      copy: scrubPageCopy(story.copy),
      ...(story.data ? { data: story.data } : {}),
      ...(neighbors.length > 0 ? { neighbors } : {}),
      budget: budgetForRole(story.role),
    };
  });
  return { ...plan, pages: merged };
}


export interface EditorBatchDispatchArgs {
  draftPages: EditorDraftPage[];
  /** 由调用方注入完整 input 构造（包含 instruction/roomId/title 等）。 */
  buildInput: (pages: EditorDraftPage[], batchIndex: number, batchCount: number) => Record<string, unknown>;
  dispatch: (input: Record<string, unknown>, batchIndex: number) => Promise<SubagentInvocation>;
  options?: StoryboardCheckOptions;
  batchSize?: number;
  concurrency?: number;
}

/**
 * 压缩文稿分片：每批 6 页并行（最多 2 批同时），再合并成整本 storyboard。
 * 目的不是改变验收口径，而是把单次 24 页的巨型输出拆成 4 次小输出，避免 420s invocation 超时。
 */
export async function dispatchEditorStoryboard(args: EditorBatchDispatchArgs): Promise<{
  storyboard: EditorStoryboard | null;
  errors: string[];
  warnings: string[];
}> {
  const batchSize = Math.max(1, Math.min(8, args.batchSize ?? 6));
  const concurrency = Math.max(1, Math.min(3, args.concurrency ?? 2));
  const batches: EditorDraftPage[][] = [];
  for (let i = 0; i < args.draftPages.length; i += batchSize) {
    batches.push(args.draftPages.slice(i, i + batchSize));
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const outcomes: Array<{ storyboard: EditorStoryboard | null; errors: string[] }> = new Array(batches.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const index = cursor;
      cursor += 1;
      const pages = batches[index]!;
      try {
        const input = args.buildInput(pages, index, batches.length);
        const invocation = await args.dispatch(input, index);
        const got = storyboardFromInvocation(invocation, pages);
        outcomes[index] = { storyboard: got.storyboard, errors: got.errors };
      } catch (error) {
        outcomes[index] = { storyboard: null, errors: [error instanceof Error ? error.message : String(error)] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  const stories: EditorStoryboard[] = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes[i];
    if (!outcome?.storyboard) {
      errors.push(`批次 ${i + 1}/${batches.length}：${outcome?.errors.join("; ") || "未返回 storyboard"}`);
      continue;
    }
    errors.push(...outcome.errors.map((error) => `批次 ${i + 1}/${batches.length}：${error}`));
    warnings.push(...outcome.storyboard.warnings.map((warning) => `批次 ${i + 1}/${batches.length}：${warning}`));
    stories.push(outcome.storyboard);
  }
  if (stories.length !== batches.length) {
    return { storyboard: null, errors, warnings };
  }
  const first = stories[0]!;
  const merged: EditorStoryboard = {
    schemaVersion: "storyboard/v2",
    deck: first.deck,
    pages: stories.flatMap((story) => story.pages),
    warnings,
  };
  const fullCheck = checkStoryboard(merged, args.draftPages, args.options ?? {});
  errors.push(...fullCheck.errors);
  warnings.push(...fullCheck.warnings);
  return { storyboard: merged, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
