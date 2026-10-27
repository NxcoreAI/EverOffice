/**
 * thesis-format 编排：模版解析（归一化 → 子代理 parse_template → 校验入库）
 * 与论文装订（桌面 describe → 子代理 bind_thesis → 桌面 build 渲染入库）。
 * 块区间的事实源是桌面 describe 的 Block 序号，bind 只做映射不重算索引。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { FilesService } from "../files/service.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import type { OfficeBridgeClient } from "../documents/capabilities/office-bridge-client.js";
import { ThesisFormatCardStore } from "./card-store.js";
import { buildTemplateFacts, normalizeMembersToDocx, unpackTemplateInput } from "./normalize.js";
import { validateThesisFormatCard } from "./validate.js";
import { buildTemplateProfile } from "./template-profile.js";
import { buildContentProfile } from "./content-profile.js";
import { buildMappingPlan } from "./mapping-plan.js";
import { planToBindingSpec } from "./plan-to-spec.js";
import type { ThesisBindingSpec, ThesisFormatCard, ThesisHfImage, ThesisTemplateFacts } from "./types.js";

const THESIS_FORMATTER_AGENT_ID = "thesis-formatter";

export interface ThesisParseResult {
  cardId: string;
  sourceName: string;
  card: ThesisFormatCard;
  /** 解析代理申报的「模版事实缺口」：未能确定的版式信息（图片抽不出、条文冲突等）。
   *  空数组 = 模版完整可读。UI 据此提示，杜绝静默降级到默认样式。 */
  factGaps: string[];
}

export interface ThesisReformatResult {
  fileEntryId: string;
  originalName: string;
  /** v2 映射报告（守恒核对、规则、未匹配块、待复核章节）；老卡片路径没有。 */
  report?: Record<string, unknown>;
}

export class ThesisFormatService {
  private readonly store: ThesisFormatCardStore;

  constructor(private readonly deps: {
    db: GatewayDatabase;
    files: FilesService;
    orchestrator: SubagentOrchestrator;
    officeBridge: OfficeBridgeClient | null;
  }) {
    this.store = new ThesisFormatCardStore(deps.db);
  }

  cardStore(): ThesisFormatCardStore {
    return this.store;
  }

  async parseFromLibrary(roomId: string, fileEntryId: string): Promise<ThesisParseResult> {
    const entry = this.deps.files.catalogEntry(fileEntryId);
    if (!entry) throw new Error("thesis_template_file_not_found");
    const storagePath = this.deps.files.catalogStoragePathOf(fileEntryId);
    if (!storagePath) throw new Error("thesis_template_file_not_readable");
    const bytes = await readFile(storagePath);
    const result = await this.parseBytes(bytes, entry.originalName);
    const row = this.store.upsert({ roomId, card: result.card, sourceFileEntryId: fileEntryId, sourceName: entry.originalName });
    return { cardId: row.id, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps };
  }

  async parseFromUpload(roomId: string, bytes: Buffer, name: string): Promise<ThesisParseResult> {
    const result = await this.parseBytes(bytes, name);
    const row = this.store.upsert({ roomId, card: result.card, sourceFileEntryId: null, sourceName: name });
    return { cardId: row.id, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps };
  }

  removeCard(roomId: string, cardId: string): boolean {
    return this.store.remove(roomId, cardId);
  }

  private async parseBytes(bytes: Buffer, name: string): Promise<{ sourceName: string; card: ThesisFormatCard; factGaps: string[] }> {
    // 全链路显性失败：解包/归一化/事实抽取任一步失败都直接抛错（带阶段名），
    // 由 routes 层回 400 与 UI toast——绝不静默降级用默认样式出卡。
    const members = await unpackTemplateInput(bytes, name).catch((error: unknown) => {
      throw new Error(`thesis_template_unpack_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    const normalized = await normalizeMembersToDocx(members).catch((error: unknown) => {
      throw new Error(`thesis_template_normalize_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    const facts = await buildTemplateFacts(normalized).catch((error: unknown) => {
      throw new Error(`thesis_template_facts_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    const task = `解析论文格式模版并产出格式卡：${name}`;
    const input = {
      task: "parse_template" as const,
      sourceName: name.slice(0, 300),
      // 图片字节不进模型（网关确定性写入卡片）：一份校徽 base64 就有 4 万 token。
      facts: factsForAgent(facts),
    };
    const structured = await this.dispatchAgent(task, input);
    const rawCard = structured?.formatCard;
    if (!rawCard || typeof rawCard !== "object") throw new Error("thesis_format_card_missing");
    // 图片字节一律由网关从模版事实确定性写入卡片，**不经过解析代理**：
    // 让模型回显 base64 既烧输出预算（一份 logo 动辄上万 token），又容易抄错。
    const card = mergeTemplateImages(validateThesisFormatCard(rawCard, name), facts);
    // v2 模板剖面：取承载版式的 docx 成员（第一个有正文大纲的），挂到卡片上供
    // reformat 用。剖面里不含图片字节（卡片已有），只有角色与尺寸。
    const layoutMember = (facts.ooxml ?? []).find((member) => (member.outline ?? []).length > 0) ?? facts.ooxml?.[0];
    if (layoutMember) {
      card.profile = buildTemplateProfile({
        facts: {
          styles: layoutMember.styles ?? [],
          sections: (layoutMember.sections ?? []) as never,
          headers: (layoutMember.headers ?? []) as never,
          footers: (layoutMember.footers ?? []) as never,
          coverImages: (layoutMember.coverImages ?? []) as never,
          coverText: layoutMember.coverText ?? [],
          outline: layoutMember.outline ?? [],
          numbering: layoutMember.numbering ?? { scheme: "none", levels: [] },
        },
        card,
        sourceName: name,
      } satisfies Parameters<typeof buildTemplateProfile>[0]);
    }
    const rawGaps = structured?.templateFactsGaps;
    const factGaps = Array.isArray(rawGaps)
      ? rawGaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 20)
      : [];
    return { sourceName: name, card, factGaps };
  }

  async reformat(roomId: string, fileEntryId: string, cardId?: string): Promise<ThesisReformatResult> {
    const row = cardId ? this.store.byId(roomId, cardId) : this.store.latest(roomId);
    if (!row) throw new Error("thesis_format_card_not_found");
    const card = row.card;
    const bridge = this.deps.officeBridge;
    if (!bridge) throw new Error("thesis_bridge_unavailable");
    const entry = this.deps.files.catalogEntry(fileEntryId);
    if (!entry) throw new Error("thesis_source_file_not_found");
    if (extname(entry.originalName).toLowerCase() !== ".docx") throw new Error("thesis_source_not_docx");
    const storagePath = this.deps.files.catalogStoragePathOf(fileEntryId);
    if (!storagePath) throw new Error("thesis_source_not_readable");
    const bytes = await readFile(storagePath);

    const described = await bridge.describeThesisDocx({ docxBase64: bytes.toString("base64") });
    if (described.outline.length === 0) throw new Error("thesis_source_outline_empty");

    const titleHint = entry.originalName.replace(/\.[^.]+$/, "").slice(0, 300);
    const v2 = this.mapWithProfile(card, described.outline, titleHint);
    let spec: ThesisBindingSpec;
    let report: Record<string, unknown> | undefined;
    if (v2) {
      // v2：模板剖面 + 规则映射（确定性），不再让代理编区间
      spec = v2.spec;
      report = v2.report;
    } else {
      const task = `映射论文块大纲到装订规格（${entry.originalName}）`;
      const input = {
        task: "bind_thesis" as const,
        formatCard: cardForAgent(card),
        sourceOutline: described.outline,
        titleHint,
      };
      const structured = await this.dispatchAgent(task, input);
      spec = this.validateBindingSpec(structured?.bindingSpec, described.blockCount);
    }

    const built = await bridge.reformatThesisDocx({
      docxBase64: bytes.toString("base64"),
      formatCard: card,
      bindingSpec: spec,
      roomId,
      sourceFileName: entry.originalName,
      sourceFileEntryId: fileEntryId,
      idempotencyKey: `thesis-reformat:${fileEntryId}:${row.id}:${card.cardMeta.parsedAt}`,
    });
    return { fileEntryId: built.fileEntryId, originalName: built.originalName, ...(report ? { report } : {}) };
  }

  /**
   * v2 映射：卡片带模板剖面时，用「内容剖面 → 映射计划 → 装订规格」确定性产出，
   * 不再派代理猜区间。返回 null = 老卡片，调用方回落原路径。
   */
  private mapWithProfile(
    card: ThesisFormatCard,
    outline: Array<{ index: number; kind: string; level?: number; text: string }>,
    titleHint: string,
  ): { spec: ThesisBindingSpec; report: Record<string, unknown> } | null {
    const profile = card.profile;
    if (!profile || profile.slots.length === 0) return null;
    const knownKinds = new Set(["heading", "paragraph", "table", "image", "list"]);
    const blocks = outline.map((block) => ({
      index: block.index,
      kind: (knownKinds.has(block.kind) ? block.kind : "paragraph") as "heading" | "paragraph" | "table" | "image" | "list",
      ...(block.level !== undefined ? { level: block.level } : {}),
      text: block.text,
    }));
    const content = buildContentProfile(blocks);
    const plan = buildMappingPlan({ template: profile, content });
    const { spec, notes } = planToBindingSpec({ plan, content, titleHint });
    return {
      spec,
      report: {
        version: 2,
        conservation: plan.conservation,
        report: plan.report,
        assignments: plan.assignments.map((entry) => ({
          slotId: entry.slotId,
          headingText: entry.headingText,
          rule: entry.rule,
          confidence: Number(entry.confidence.toFixed(2)),
          blockRange: entry.blockRange,
          notes: entry.notes,
        })),
        unmatched: plan.unmatched,
        // 0.40–0.62 区间的归属靠顺序推断，UI 提醒用户核对（不派代理，保持确定性）
        needsReview: plan.pendingForSemantic.map((entry) => ({
          chapterText: entry.chapterText,
          candidates: entry.candidates.map((candidate) => candidate.slotId),
        })),
        gaps: [...profile.gaps, ...content.gaps],
        notes,
      },
    };
  }

  private async dispatchAgent(task: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const registered = this.deps.orchestrator.listDefinitions().some((d) => d.id === THESIS_FORMATTER_AGENT_ID);
    if (!registered) throw new Error("thesis_formatter_agent_not_registered");
    const invocation = await this.deps.orchestrator.dispatch({
      agentId: THESIS_FORMATTER_AGENT_ID,
      task,
      input,
      idempotencyKey: randomUUID(),
      source: "internal_workflow",
    });
    if (invocation.status !== "completed") {
      throw new Error(invocation.errorMessage || `thesis_formatter_failed:${invocation.status}`);
    }
    const structured = (invocation.result?.structuredOutput ?? null) as Record<string, unknown> | null;
    if (!structured) throw new Error("thesis_formatter_no_structured_output");
    return structured;
  }

  /** 区间合法性：夹回 [0, blockCount)；倒序/空区间剔除。 */
  private validateBindingSpec(raw: unknown, blockCount: number): ThesisBindingSpec {
    if (!raw || typeof raw !== "object") throw new Error("thesis_binding_spec_missing");
    const src = raw as Record<string, unknown>;
    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
    const strArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const clampRange = (start: unknown, end: unknown): { start: number; end: number } | null => {
      const s = Math.max(0, Math.min(blockCount, Number(start)));
      const e = Math.max(0, Math.min(blockCount, Number(end)));
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
    };
    const chapters = (Array.isArray(src.chapters) ? src.chapters : [])
      .map((c) => {
        const chapter = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const range = clampRange(chapter.blockStart, chapter.blockEnd);
        if (!range) return null;
        const level = Number(chapter.level);
        return {
          level: (level >= 1 && level <= 4 ? level : 1) as 1 | 2 | 3 | 4,
          headingText: str(chapter.headingText).slice(0, 200),
          blockStart: range.start,
          blockEnd: range.end,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.headingText.length > 0);
    if (chapters.length === 0) throw new Error("thesis_binding_spec_no_chapters");
    const appendixRaw = (src.appendixBlocks && typeof src.appendixBlocks === "object")
      ? src.appendixBlocks as Record<string, unknown>
      : null;
    return {
      title: str(src.title).slice(0, 300),
      coverFields: (src.coverFields && typeof src.coverFields === "object")
        ? Object.fromEntries(Object.entries(src.coverFields as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, (v as string).slice(0, 200)]))
        : {},
      abstractZh: str(src.abstractZh),
      keywordsZh: strArray(src.keywordsZh),
      abstractEn: str(src.abstractEn),
      keywordsEn: strArray(src.keywordsEn),
      chapters,
      references: strArray(src.references).map((r) => r.slice(0, 600)),
      appendixBlocks: appendixRaw ? clampRange(appendixRaw.start, appendixRaw.end) : null,
      acknowledgementParagraphs: strArray(src.acknowledgementParagraphs).map((p) => p.slice(0, 2000)),
      achievements: strArray(src.achievements).map((a) => a.slice(0, 600)),
    };
  }
}

/**
 * 送给解析代理的模版事实：**剥掉图片字节**，只留尺寸/版位等元信息。
 *
 * 一份校徽 png 122KB ≈ 4 万 token：塞进输入既挤占窗口（把输出预算挤到截断），
 * 又诱导模型把 base64 抄进卡里。图片字节本来由网关确定性写入格式卡，代理只需
 * 知道「这里有张多大的图、放在哪」。
 */
export function factsForAgent(facts: ThesisTemplateFacts): unknown {
  const strip = (images: ThesisHfImage[] | undefined) => (images ?? []).map((image) => ({
    hasBytes: true,
    ...(image.widthPx !== undefined ? { widthPx: image.widthPx } : {}),
    ...(image.heightPx !== undefined ? { heightPx: image.heightPx } : {}),
    ...(image.floating !== undefined ? { floating: image.floating } : {}),
    ...(image.behind !== undefined ? { behind: image.behind } : {}),
    ...(image.posH !== undefined ? { posH: image.posH } : {}),
    ...(image.posV !== undefined ? { posV: image.posV } : {}),
    ...(image.posHRel !== undefined ? { posHRel: image.posHRel } : {}),
    ...(image.posVRel !== undefined ? { posVRel: image.posVRel } : {}),
    ...(image.posXPx !== undefined ? { posXPx: image.posXPx } : {}),
    ...(image.posYPx !== undefined ? { posYPx: image.posYPx } : {}),
  }));
  return {
    ooxml: (facts.ooxml ?? []).map((member) => ({
      ...member,
      headers: (member.headers ?? []).map((header) => ({ ...header, images: strip(header.images) })),
      footers: (member.footers ?? []).map((footer) => ({ ...footer, images: strip(footer.images) })),
      coverImages: strip(member.coverImages),
    })),
    documentsText: facts.documentsText ?? [],
  };
}

/** 单张图片的元信息（无字节）：代理只需知道「有多大、放哪儿」。 */
function imageMeta(image: ThesisHfImage): Record<string, unknown> {
  return {
    hasBytes: true,
    ...(image.widthPx !== undefined ? { widthPx: image.widthPx } : {}),
    ...(image.heightPx !== undefined ? { heightPx: image.heightPx } : {}),
    ...(image.floating !== undefined ? { floating: image.floating } : {}),
    ...(image.behind !== undefined ? { behind: image.behind } : {}),
    ...(image.posH !== undefined ? { posH: image.posH } : {}),
    ...(image.posV !== undefined ? { posV: image.posV } : {}),
    ...(image.posHRel !== undefined ? { posHRel: image.posHRel } : {}),
    ...(image.posVRel !== undefined ? { posVRel: image.posVRel } : {}),
    ...(image.posXPx !== undefined ? { posXPx: image.posXPx } : {}),
    ...(image.posYPx !== undefined ? { posYPx: image.posYPx } : {}),
  };
}

/**
 * 送给装订代理的格式卡：同样剥掉图片字节。
 *
 * 卡片里的图片（cover.logo 122KB ≈ 4 万 token）如果随 bind_thesis 输入发出去，
 * 会把输出窗口挤到截断——实测排版因此报「模型输出上限」。字节只在网关→桌面桥
 * 那一跳需要，代理判断章节/标题映射时不需要。
 */
export function cardForAgent(card: ThesisFormatCard): unknown {
  return {
    ...card,
    header: { ...card.header, images: (card.header.images ?? []).map(imageMeta) },
    cover: { ...card.cover, ...(card.cover.logo ? { logo: imageMeta(card.cover.logo) } : {}) },
  };
}

/** validate 对 cover.degreeLine 的兜底值：卡里等于它时视为「代理没给」，可被封面文本改写。 */
const DEFAULT_DEGREE_LINE = "本科毕业论文（设计）";

/**
 * 把模版里抽出的图片事实写进格式卡（页眉图 + 封面图）。
 *
 * 确定性合并：只补卡片里缺的字段，不覆盖已解析代理给出的合法值；没有图片事实
 * 时保持字段缺省——绝不编造 logo。
 */
export function mergeTemplateImages(card: ThesisFormatCard, facts: ThesisTemplateFacts): ThesisFormatCard {
  const members = facts.ooxml ?? [];
  const headerImages = members.map((member) => member.headers ?? []).flat()
    .map((header) => header.images ?? []).find((images) => images.length > 0) ?? [];
  const coverImage = members.map((member) => member.coverImages ?? []).flat()[0];

  const next: ThesisFormatCard = { ...card, cover: { ...card.cover } };
  // 封面文字兜底：模版封面区文本就摆在 facts 里，但解析代理可能整段留空、让校验层
  // 填 schema 默认值（卡外观完整、内容却不是模版的）。这里用确定性规则补最机械的几项，
  // 只填空缺、绝不覆盖代理给出的非空值。
  const lines = members.flatMap((member) => member.coverText ?? []).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    if (!next.cover.schoolName) {
      const school = lines
        .filter((line) => /(学院|大学|学校|研究院|职业技术学院)$/.test(line) && line.length <= 24)
        .sort((a, b) => b.length - a.length)[0];
      if (school) next.cover.schoolName = school;
    }
    if (!next.cover.degreeLine || next.cover.degreeLine === DEFAULT_DEGREE_LINE) {
      const degree = lines.find((line) => /(课程考核报告|毕业设计|毕业论文|实践报告|课程设计报告|设计报告|研究报告)$/.test(line) && line.length <= 30);
      if (degree && degree !== next.cover.degreeLine) next.cover.degreeLine = degree;
    }
    if (!next.cover.yearLine) {
      const year = lines.find((line) => /20\d{2}\s*[-–—~至]\s*20\d{2}\s*学年/.test(line) || /^(二[〇零]|20\d{2})\S*年\S*学期/.test(line));
      if (year) next.cover.yearLine = year;
    }
    if (!next.cover.footerLine) {
      const footer = lines.find((line) => /制$/.test(line) && line.length <= 24);
      if (footer) next.cover.footerLine = footer;
    }
  }
  if ((next.header.images ?? []).length === 0 && headerImages.length > 0) {
    next.header = { ...next.header, images: headerImages.slice(0, 6) };
  }
  if (!next.cover.logo && coverImage) {
    next.cover = { ...next.cover, logo: coverImage };
  }
  return next;
}
