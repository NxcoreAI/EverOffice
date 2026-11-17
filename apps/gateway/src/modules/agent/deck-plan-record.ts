import { randomUUID } from "node:crypto";

import type { PlanRef } from "@nxcore/agent-contract";
import { DEFAULT_AGENT_WORKSPACE_ID } from "@nxcore/agent-contract";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";

import type { DocumentService } from "../documents/service.js";
import { DEFAULT_DOCUMENT_WORKSPACE_ID } from "../documents/workspace-index.js";
import { PlanError, type PlanActor, type PlanService } from "../plan/service.js";

/**
 * 演示文稿计划卡的持久化：把 agent_confirm 的「计划步骤 + 色板 + 字体 + 要点」
 * 落成两件真实产物，而不是只留在聊天卡片里——
 *
 * 1. 一份工作空间云文档：用户能在「云文档」里读到、改到、版本化；
 * 2. 一条计划页任务（workspace_plan_items）：看板上能跟踪、能交给 Agent、能验收。
 *
 * 同一 run 内重复出卡（用户取消 → 按反馈调整再确认）复用同一份文档与同一条任务，
 * 只做内容同步，不会给计划页刷出一堆重复卡片。
 */

/** 计划确认卡里与计划落地相关的内容（由 agent_confirm 归一后的字段）。 */
export interface DeckPlanDraft {
  /** 计划文档/任务标题。 */
  planTitle: string;
  /** 卡片正文（背景、取舍说明），可空。 */
  body?: string;
  /** 执行步骤（卡片 plan 列表）。 */
  plan: string[];
  /** 设计决策色板（#rrggbb）。 */
  palette: string[];
  fonts?: { heading?: string; body?: string };
  /** 其他风格要点。 */
  notes: string[];
}

/**
 * 计划文档/计划页任务里的固定文案（标题、标签、验收句）。
 * 跟随运行的 responseLanguage：英文界面出英文；未提供或中文回落中文，
 * 与 agent-card-tools 的 planSavedNote 同一判定口径。
 */
interface DeckPlanCopy {
  stepsHeading: string;
  designHeading: string;
  descriptionHeading: string;
  acceptanceHeading: string;
  paletteLabel: string;
  headingFontLabel: string;
  bodyFontLabel: string;
  colorSeparator: string;
  acceptanceStepLine: string;
  acceptanceDesignLine: string;
  acceptanceVerbatimLine: string;
  acceptanceSummarySteps: (title: string) => string;
  acceptanceSummaryDesign: string;
  acceptanceSummaryVerbatim: string;
  fallbackTitle: string;
  planDetailIntro: (title: string) => string;
}

const ZH_COPY: DeckPlanCopy = {
  stepsHeading: "执行步骤",
  designHeading: "设计决策",
  descriptionHeading: "说明",
  acceptanceHeading: "验收标准",
  paletteLabel: "色板：",
  headingFontLabel: "标题字体：",
  bodyFontLabel: "正文字体：",
  colorSeparator: "、",
  acceptanceStepLine: "按「执行步骤」生成整册演示文稿，页面结构与本计划一致。",
  acceptanceDesignLine: "色板与字体按「设计决策」执行，不擅自更换。",
  acceptanceVerbatimLine: "用户给定的标题、文案与数字逐字保留，不改写、不补值。",
  acceptanceSummarySteps: (title) => `按云文档《${title}》中的计划生成整册演示文稿，页面结构一致。`,
  acceptanceSummaryDesign: "色板与字体按「设计决策」执行。",
  acceptanceSummaryVerbatim: "用户给定的标题、文案与数字逐字保留。",
  fallbackTitle: "演示文稿制作计划",
  planDetailIntro: (title) => `计划文档《${title}》（工作空间「云文档」）记录本册结构与设计决策。`,
};

const EN_COPY: DeckPlanCopy = {
  stepsHeading: "Steps",
  designHeading: "Design decisions",
  descriptionHeading: "Description",
  acceptanceHeading: "Acceptance criteria",
  paletteLabel: "Palette: ",
  headingFontLabel: "Heading font: ",
  bodyFontLabel: "Body font: ",
  colorSeparator: ", ",
  acceptanceStepLine: "Generate the full deck following these steps; the page structure must match this plan.",
  acceptanceDesignLine: "Apply the palette and fonts from \"Design decisions\"; do not swap in your own.",
  acceptanceVerbatimLine: "Keep user-provided titles, copy, and numbers verbatim; no rewriting or invented values.",
  acceptanceSummarySteps: (title) => `Generate the full deck following the plan in cloud document "${title}"; the page structure must match.`,
  acceptanceSummaryDesign: "Apply the palette and fonts from \"Design decisions\".",
  acceptanceSummaryVerbatim: "Keep user-provided titles, copy, and numbers verbatim.",
  fallbackTitle: "Presentation plan",
  planDetailIntro: (title) => `Plan document "${title}" (workspace cloud documents) records this deck's structure and design decisions.`,
};

function deckPlanCopy(language: string | null | undefined): DeckPlanCopy {
  return /^en/i.test((language ?? "").trim()) ? EN_COPY : ZH_COPY;
}

/** 计划落地结果：云文档 id + 计划页任务 id（任务未建成为 null）。 */
export interface DeckPlanRecord {
  documentId: string;
  documentTitle: string;
  planItemId: string | null;
  planItemTitle: string;
}

/** 云文档正文与计划任务的验收标准（纯函数，单测直击）。 */
export interface DeckPlanDocument {
  markdown: string;
  acceptance: string;
}

const DOCUMENT_TITLE_MAX = 120;

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DOCUMENT_TITLE_MAX);
}

/** 把计划卡渲染成一份可读的云文档正文（文档标题由编辑器渲染为 H1，章节从 ## 起）。 */
export function renderDeckPlanDocument(
  draft: DeckPlanDraft,
  language?: string | null,
): DeckPlanDocument {
  const copy = deckPlanCopy(language);
  const steps = draft.plan.map((step) => step.trim()).filter(Boolean);
  const palette = draft.palette.filter(Boolean);
  const fonts: string[] = [];
  if (draft.fonts?.heading) fonts.push(`- ${copy.headingFontLabel}${draft.fonts.heading}`);
  if (draft.fonts?.body) fonts.push(`- ${copy.bodyFontLabel}${draft.fonts.body}`);
  const notes = draft.notes.map((note) => note.trim()).filter(Boolean);
  const body = (draft.body ?? "").trim();

  const lines: string[] = [];
  if (steps.length) {
    lines.push(`## ${copy.stepsHeading}`, "");
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push("");
  }
  if (palette.length || fonts.length || notes.length) {
    lines.push(`## ${copy.designHeading}`, "");
    if (palette.length) {
      lines.push(`- ${copy.paletteLabel}${palette.map((color) => `\`${color}\``).join(copy.colorSeparator)}`);
    }
    lines.push(...fonts);
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (body) {
    lines.push(`## ${copy.descriptionHeading}`, "", body, "");
  }
  const hasDecisions = palette.length > 0 || fonts.length > 0;
  lines.push(`## ${copy.acceptanceHeading}`, "");
  lines.push(`- ${copy.acceptanceStepLine}`);
  if (hasDecisions) lines.push(`- ${copy.acceptanceDesignLine}`);
  lines.push(`- ${copy.acceptanceVerbatimLine}`);
  lines.push("");

  const acceptance = [
    copy.acceptanceSummarySteps(cleanTitle(draft.planTitle)),
    hasDecisions ? copy.acceptanceSummaryDesign : "",
    copy.acceptanceSummaryVerbatim,
  ].filter(Boolean).join("");

  return { markdown: lines.join("\n"), acceptance };
}

export interface DeckPlanRecorderDeps {
  documents: Pick<DocumentService, "syncExternalMarkdown" | "bindDocumentWorkspace">;
  plans: Pick<PlanService, "create" | "update" | "get" | "agentIdForSession">;
  /** 单进程内记住的 run → 产物映射上限（防长驻进程里无限增长）。 */
  maxRuns?: number;
}

const DEFAULT_MAX_RUNS = 100;

/** 建计划持久化器：同一 run 内复用云文档与计划任务，只同步内容。 */
export function createDeckPlanRecorder(
  deps: DeckPlanRecorderDeps,
): (input: StartRuntimeRunInput, draft: DeckPlanDraft) => Promise<DeckPlanRecord> {
  const maxRuns = deps.maxRuns ?? DEFAULT_MAX_RUNS;
  const records = new Map<string, { documentId: string; planItemId: string | null }>();

  return async (input, draft) => {
    const copy = deckPlanCopy(input.responseLanguage);
    const planTitle = cleanTitle(draft.planTitle) || copy.fallbackTitle;
    const rendered = renderDeckPlanDocument({ ...draft, planTitle }, input.responseLanguage);
    const workspaceId = (input.workspaceId ?? "").trim();
    const documentWorkspaceId = workspaceId || DEFAULT_DOCUMENT_WORKSPACE_ID;
    const planWorkspaceId = workspaceId || DEFAULT_AGENT_WORKSPACE_ID;

    // 1. 云文档：同 run 复用同一 id，重出卡时覆盖为最新计划（用户可见、可编辑）。
    const previous = records.get(input.runId);
    const documentId = previous?.documentId ?? randomUUID();
    const synced = await deps.documents.syncExternalMarkdown({
      documentId,
      roomId: null,
      title: planTitle,
      markdown: rendered.markdown,
      origin: "native",
    });
    deps.documents.bindDocumentWorkspace(synced.id, documentWorkspaceId);

    // 2. 计划页任务：用户没动过（仍是待开始 + 未指派）才同步内容，否则不覆盖人的推进。
    const actor: PlanActor = {
      kind: "agent",
      id: deps.plans.agentIdForSession(input.sessionId),
      sessionId: input.sessionId,
    };
    const refs: PlanRef[] = [{ kind: "document", id: documentId, title: planTitle }];
    const detail = [
      copy.planDetailIntro(planTitle),
      "",
      ...draft.plan.map((step, index) => `${index + 1}. ${step}`),
    ].join("\n").trim();

    let planItemId = previous?.planItemId ?? null;
    if (planItemId) {
      try {
        const current = deps.plans.get(planItemId);
        if (current.status === "todo" && current.ownerKind === "unassigned") {
          deps.plans.update(planItemId, {
            version: current.version,
            title: planTitle.slice(0, 200),
            detail,
            acceptance: rendered.acceptance,
            refs,
          }, actor);
        }
      } catch (error) {
        // 用户把任务删了/看板重建过：重新建一条，不让计划页留空。
        if (error instanceof PlanError && error.code === "plan_item_not_found") planItemId = null;
        else throw error;
      }
    }
    if (!planItemId) {
      const created = deps.plans.create({
        workspaceId: planWorkspaceId,
        title: planTitle.slice(0, 200),
        detail,
        acceptance: rendered.acceptance,
        refs,
        createdBy: "agent",
        createdByAgentId: actor.id ?? null,
      }, actor);
      planItemId = created.id;
    }

    records.set(input.runId, { documentId, planItemId });
    if (records.size > maxRuns) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }

    return {
      documentId,
      documentTitle: planTitle,
      planItemId,
      planItemTitle: planTitle,
    };
  };
}
