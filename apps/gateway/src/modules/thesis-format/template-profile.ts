/**
 * 论文排版 v2 · 模板剖面（方案 §4.1 / §5）。
 *
 * 把「模版 OOXML 事实 + 已解析样式卡」整理成**可被映射引擎消费的剖面**：
 * 固定元素（页面/logo/页眉页脚/样式锁/编号）+ 槽位骨架（模板自身章节 → 槽位）。
 *
 * 本模块是纯确定性代码：不调用模型、不猜内容。识别不到就留空并记 gap，
 * 让上层显性报给用户（延续 templateFactsGaps 的「不静默降级」原则）。
 */

import { anchorKindOf, type AnchorKind } from "./thesis-anchors.js";
import { normalizeTitle, titleTokens } from "./text-normalize.js";
import type { OoxmlFacts, OoxmlNumberingFact, OoxmlOutlineEntry } from "./ooxml-facts.js";
import type { ThesisFontSpec, ThesisFormatCard, ThesisHfImage, ThesisParagraphSpec } from "./types.js";

/** 样式锁的语义键（内容侧只认这些键，不认模板里的 styleId）。 */
export type StyleKey =
  | "body"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "caption"
  | "tableText"
  | "listItem"
  | "formula"
  | "abstractTitle"
  | "abstractBody"
  | "keywords"
  | "referencesItem";

export interface StyleLock {
  key: StyleKey;
  font: ThesisFontSpec;
  paragraph: ThesisParagraphSpec;
  /** 该锁的来源：card=格式卡已有；style=从 styles.xml 推导；default=兜底（会记 gap）。 */
  origin: "card" | "style" | "default";
  /** 模板里的 styleId（诊断用，渲染不依赖）。 */
  styleId?: string;
}

export type SlotKind =
  | "cover"
  | "commitment"
  | "abstract_zh"
  | "abstract_en"
  | "toc"
  | "body"
  | "reference"
  | "appendix"
  | "acknowledgement"
  | "other";

export interface ThesisSlot {
  id: string;
  kind: SlotKind;
  /** 模板里的原标题（如「二、项目需求分析」「参考资料」）。 */
  title: string;
  matchKey: { normalized: string; tokens: string[] };
  /** 正文章节的层级（固定槽位不填）。 */
  level?: 1 | 2 | 3 | 4;
  styleKey: StyleKey;
  /** 输出时是否保留模板原标题文案（参考文献/附录等固定标题为 true）。 */
  emitTemplateTitle: boolean;
  /** single：只吃一个源章节；many：可继续吸收（正文容器）。 */
  capacity: "single" | "many";
  order: number;
}

export interface TemplateProfile {
  version: 2;
  sourceName: string;
  fixed: {
    page: ThesisFormatCard["page"];
    logos: Array<{
      role: "cover" | "header" | "footer" | "watermark";
      dataUrl: string;
      sha256Hint?: string;
      widthPx?: number;
      heightPx?: number;
      floating?: boolean;
      behind?: boolean;
    }>;
    header: ThesisFormatCard["header"];
    footer: ThesisFormatCard["footer"];
    styles: Record<string, StyleLock>;
    numbering: OoxmlNumberingFact;
  };
  slots: ThesisSlot[];
  /** 剖面自身的缺口（抽不到的东西），UI 必须显示。 */
  gaps: string[];
}

/** 锚点 → 槽位类型。 */
const ANCHOR_SLOT: Record<AnchorKind, SlotKind> = {
  commitment: "commitment",
  abstract_zh: "abstract_zh",
  abstract_en: "abstract_en",
  toc: "toc",
  reference: "reference",
  acknowledgement: "acknowledgement",
  appendix: "appendix",
};

/** 这些锚点槽位在输出里保留模板原标题文案。 */
const EMIT_TITLE_KINDS = new Set<SlotKind>(["reference", "appendix", "acknowledgement", "abstract_zh", "abstract_en", "toc", "commitment"]);

/** 标题层级 → 样式键。 */
function headingStyleKey(level: number): StyleKey {
  if (level <= 1) return "h1";
  if (level === 2) return "h2";
  if (level === 3) return "h3";
  return "h4";
}

/** 从格式卡取某个语义键的样式锁。 */
function lockFromCard(card: ThesisFormatCard, key: StyleKey): StyleLock | null {
  const cardHeading = (level: 1 | 2 | 3 | 4): StyleLock | null => {
    const rule = card.headings.find((entry) => entry.level === level);
    if (!rule) return null;
    return {
      key,
      font: rule.font,
      paragraph: rule.paragraph ?? {
        align: rule.align === "center" ? "center" : "left",
        firstLineIndentChars: 0,
        spaceBeforePt: 0,
        spaceAfterPt: 0,
      },
      origin: "card",
    };
  };
  switch (key) {
    case "h1": return cardHeading(1);
    case "h2": return cardHeading(2);
    case "h3": return cardHeading(3);
    case "h4": return cardHeading(4);
    case "body": return { key, font: card.base.font, paragraph: card.base.paragraph, origin: "card" };
    case "abstractTitle": return { key, font: card.abstract.titleFont, paragraph: card.base.paragraph, origin: "card" };
    case "abstractBody": return { key, font: card.abstract.bodyFont, paragraph: card.abstract.bodyParagraph, origin: "card" };
    case "keywords": return { key, font: card.abstract.bodyFont, paragraph: card.abstract.bodyParagraph, origin: "card" };
    case "referencesItem": return { key, font: card.references.listFont, paragraph: card.references.listParagraph, origin: "card" };
    default: return null;
  }
}

/** 从 styles 事实推导题注/表格/列表样式（模板常没有专门的格式卡字段）。 */
function lockFromStyleFacts(facts: OoxmlFacts, key: StyleKey, patterns: RegExp[]): StyleLock | null {
  const hit = facts.styles.find((style) => patterns.some((pattern) => pattern.test(style.name ?? "") || pattern.test(style.id ?? "")));
  if (!hit) return null;
  return {
    key,
    font: {
      eastAsia: hit.fontEastAsia ?? "宋体",
      ascii: hit.fontAscii ?? "Times New Roman",
      size: hit.sizePt ?? 10.5,
      bold: hit.bold ?? false,
    },
    paragraph: {
      align: (hit.align as ThesisParagraphSpec["align"]) ?? "left",
      firstLineIndentChars: hit.firstLineIndentChars ?? 0,
      ...(hit.lineSpacingMultiple !== undefined ? { lineSpacingMultiple: hit.lineSpacingMultiple } : {}),
      ...(hit.lineSpacingExactPt !== undefined ? { lineSpacingExactPt: hit.lineSpacingExactPt } : {}),
      spaceBeforePt: 0,
      spaceAfterPt: 0,
    },
    origin: "style",
    styleId: hit.id,
  };
}

/** 样式锁集合：卡里有的用卡，没有的从 styles 事实补，仍没有则记 gap（不静默编造）。 */
export function buildStyleLocks(facts: OoxmlFacts, card: ThesisFormatCard): { styles: Record<string, StyleLock>; gaps: string[] } {
  const styles: Record<string, StyleLock> = {};
  const gaps: string[] = [];
  const keys: StyleKey[] = [
    "body", "h1", "h2", "h3", "h4",
    "caption", "tableText", "listItem", "formula",
    "abstractTitle", "abstractBody", "keywords", "referencesItem",
  ];
  const stylePatterns: Record<string, RegExp[]> = {
    caption: [/^(caption|题注)$/i, /题注/],
    tableText: [/^(表|表格|table)/i],
    listItem: [/^(list|列表)/i],
    formula: [/^(formula|公式)/i],
  };
  for (const key of keys) {
    const fromCard = lockFromCard(card, key);
    if (fromCard) {
      styles[key] = fromCard;
      continue;
    }
    const patterns = stylePatterns[key];
    const fromStyle = patterns ? lockFromStyleFacts(facts, key, patterns) : null;
    if (fromStyle) {
      styles[key] = fromStyle;
      continue;
    }
    // 兜底：正文样式（保留 gap 提示，模板确实没定义这类样式）
    styles[key] = { key, font: card.base.font, paragraph: card.base.paragraph, origin: "default" };
    gaps.push(`模板未定义「${key}」样式，已回退正文样式`);
  }
  return { styles, gaps };
}

/** logo 集合：封面 / 页眉 / 页脚（含衬底水印标记）。 */
function collectLogos(facts: OoxmlFacts, card: ThesisFormatCard): TemplateProfile["fixed"]["logos"] {
  const logos: TemplateProfile["fixed"]["logos"] = [];
  const push = (role: TemplateProfile["fixed"]["logos"][number]["role"], image: ThesisHfImage): void => {
    logos.push({
      role,
      dataUrl: image.dataUrl,
      ...(image.widthPx !== undefined ? { widthPx: image.widthPx } : {}),
      ...(image.heightPx !== undefined ? { heightPx: image.heightPx } : {}),
      ...(image.floating !== undefined ? { floating: image.floating } : {}),
      ...(image.behind !== undefined ? { behind: image.behind } : {}),
    });
  };
  if (card.cover.logo) push("cover", card.cover.logo);
  for (const image of card.header.images ?? []) push(image.behind ? "watermark" : "header", image);
  for (const footer of facts.footers ?? []) for (const image of footer.images ?? []) push("footer", image);
  for (const image of facts.coverImages ?? []) {
    // 已从卡里拿过封面图就不再重复（同字节）
    if (!logos.some((logo) => logo.role === "cover" && logo.dataUrl === image.dataUrl)) push("cover", image);
  }
  return logos;
}

/**
 * 槽位识别：模板正文大纲 → 槽位骨架（方案 §5.1）。
 *
 * - 顶层标题（模板里最高的大纲层）逐个成为 body 槽位；
 * - 命中锚点词典的升级为固定槽位（参考文献/附录/致谢等保留原标题）；
 * - 模板没有正文骨架时返回空数组，由调用方降级为「单 body 容器 + 全追加」。
 */
export function identifySlots(facts: OoxmlFacts): { slots: ThesisSlot[]; gaps: string[] } {
  const gaps: string[] = [];
  // 模板剖面针对**单个** docx 成员（承载版式的那份），因此直接用成员事实。
  const outline: OoxmlOutlineEntry[] = (facts.outline ?? [])
    // 封面区的标题不算章节骨架（那是封面文案）
    .filter((entry) => !entry.inCoverRegion);
  if (outline.length === 0) {
    gaps.push("模板未识别出章节标题（可能整篇用表格排版或无标题样式），已降级为「全部追加」模式");
    return { slots: [], gaps };
  }
  const topLevel = Math.min(...outline.map((entry) => entry.level));
  const slots: ThesisSlot[] = [];
  let order = 0;
  for (const entry of outline) {
    // 只把顶层标题做成槽位；更深层留给内容侧按角色套样式
    if (entry.level !== topLevel) continue;
    const anchor = anchorKindOf(entry.text);
    const kind: SlotKind = anchor ? ANCHOR_SLOT[anchor] : "body";
    slots.push({
      id: `slot-${order + 1}`,
      kind,
      title: entry.text,
      matchKey: { normalized: normalizeTitle(entry.text), tokens: titleTokens(normalizeTitle(entry.text)) },
      ...(kind === "body" ? { level: 1 as const } : {}),
      styleKey: kind === "body" ? headingStyleKey(entry.level) : kind === "abstract_zh" || kind === "abstract_en" ? "abstractTitle" : "h1",
      emitTemplateTitle: EMIT_TITLE_KINDS.has(kind),
      capacity: kind === "body" ? "many" : "single",
      order,
    });
    order += 1;
  }
  if (!slots.some((slot) => slot.kind === "body")) {
    gaps.push("模板章节里没有正文章节（只有摘要/目录等固定槽位），正文将全部追加");
  }
  return { slots, gaps };
}

/** 构建模板剖面。 */
export function buildTemplateProfile(input: {
  facts: OoxmlFacts;
  card: ThesisFormatCard;
  sourceName: string;
}): TemplateProfile {
  const { facts, card, sourceName } = input;
  const styleLocks = buildStyleLocks(facts, card);
  const slotInfo = identifySlots(facts);
  const gaps = [...styleLocks.gaps, ...slotInfo.gaps];
  // 编号方案缺失也要显性说明：否则用户以为「按模板编号」其实没编号
  if (facts.numbering.scheme === "none") {
    gaps.push("模板未提取到标题编号方案，输出将不生成自动编号");
  }
  return {
    version: 2,
    sourceName,
    fixed: {
      page: card.page,
      logos: collectLogos(facts, card),
      header: card.header,
      footer: card.footer,
      styles: styleLocks.styles,
      numbering: facts.numbering,
    },
    slots: slotInfo.slots,
    gaps,
  };
}
