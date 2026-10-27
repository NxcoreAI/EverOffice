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
import type { ThesisBindingSpec, ThesisFormatCard, ThesisTemplateFacts } from "./types.js";

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
      facts,
    };
    const structured = await this.dispatchAgent(task, input);
    const rawCard = structured?.formatCard;
    if (!rawCard || typeof rawCard !== "object") throw new Error("thesis_format_card_missing");
    // 图片字节一律由网关从模版事实确定性写入卡片，**不经过解析代理**：
    // 让模型回显 base64 既烧输出预算（一份 logo 动辄上万 token），又容易抄错。
    const card = mergeTemplateImages(validateThesisFormatCard(rawCard, name), facts);
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

    const task = `映射论文块大纲到装订规格（${entry.originalName}）`;
    const input = {
      task: "bind_thesis" as const,
      formatCard: card,
      sourceOutline: described.outline,
      titleHint: entry.originalName.replace(/\.[^.]+$/, "").slice(0, 300),
    };
    const structured = await this.dispatchAgent(task, input);
    const spec = this.validateBindingSpec(structured?.bindingSpec, described.blockCount);

    const built = await bridge.reformatThesisDocx({
      docxBase64: bytes.toString("base64"),
      formatCard: card,
      bindingSpec: spec,
      roomId,
      sourceFileName: entry.originalName,
      sourceFileEntryId: fileEntryId,
      idempotencyKey: `thesis-reformat:${fileEntryId}:${row.id}:${card.cardMeta.parsedAt}`,
    });
    return { fileEntryId: built.fileEntryId, originalName: built.originalName };
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

  const next: ThesisFormatCard = { ...card };
  if ((next.header.images ?? []).length === 0 && headerImages.length > 0) {
    next.header = { ...next.header, images: headerImages.slice(0, 6) };
  }
  if (!next.cover.logo && coverImage) {
    next.cover = { ...next.cover, logo: coverImage };
  }
  return next;
}
