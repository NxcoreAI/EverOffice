import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import type { DocumentService } from "../src/modules/documents/service.js";
import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import {
  createDeckPlanRecorder,
  renderDeckPlanDocument,
  type DeckPlanDraft,
} from "../src/modules/agent/deck-plan-record.js";
import { PlanService } from "../src/modules/plan/service.js";

/**
 * 演示文稿计划落地：
 * - 计划卡 → 云文档正文与验收标准（纯函数）；
 * - 同一 run 重出卡复用同一份云文档与同一条计划页任务，不重复建；
 * - 用户已推进任务（doing/已指派）时不覆盖人的编辑。
 */

let directory: string;
let database: DatabaseClient;
let clock: Date;
let plans: PlanService;

function tick(ms = 1_000): void {
  clock = new Date(clock.getTime() + ms);
}

function seedWorkspace(id: string): void {
  database.db.insert(agentWorkspaces).values({
    id,
    name: id,
    kind: "custom",
    createdAt: clock,
    updatedAt: clock,
    lastOpenedAt: clock,
  }).run();
}

function runInput(runId: string, workspaceId: string | null = "ws-1", responseLanguage?: string): StartRuntimeRunInput {
  return {
    runId,
    sessionId: "session-deck-plan",
    runtimeSessionRef: null,
    prompt: "生成 PPT",
    pageLabel: "Agent",
    workspaceId,
    ...(responseLanguage ? { responseLanguage } : {}),
  } as StartRuntimeRunInput;
}

const baseDraft: DeckPlanDraft = {
  planTitle: "产品介绍演示文稿制作计划",
  body: "素材来自工作区 3 份文档。",
  plan: ["读取产品资料", "定页面结构", "写 pptxgenjs 脚本", "生成 pptx"],
  palette: ["#0b5fff", "#f5f7fa", "#ff6b35"],
  fonts: { heading: "Source Han Sans", body: "PingFang SC" },
  notes: ["深色封面 + 浅色内容页"],
};

type DocumentsDep = Pick<DocumentService, "syncExternalMarkdown" | "bindDocumentWorkspace">;

function documentsHarness() {
  const harness = {
    syncExternalMarkdown: vi.fn(async (input: { documentId: string; title: string; markdown: string }) => ({
      id: input.documentId,
      title: input.title,
    })),
    bindDocumentWorkspace: vi.fn(),
  };
  return harness as unknown as DocumentsDep & typeof harness;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nxcore-deck-plan-test-"));
  database = createDatabase(join(directory, "gateway.sqlite"), resolve("drizzle"));
  clock = new Date("2026-11-11T09:00:00.000Z");
  seedWorkspace("ws-1");
  plans = new PlanService({ db: database.db, now: () => clock });
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("renderDeckPlanDocument", () => {
  it("渲染执行步骤/设计决策/说明/验收，色板以裸 hex 呈现", () => {
    const rendered = renderDeckPlanDocument(baseDraft);
    expect(rendered.markdown).toContain("## 执行步骤");
    expect(rendered.markdown).toContain("1. 读取产品资料");
    expect(rendered.markdown).toContain("## 设计决策");
    expect(rendered.markdown).toContain("`#0b5fff`");
    expect(rendered.markdown).toContain("- 标题字体：Source Han Sans");
    expect(rendered.markdown).toContain("- 深色封面 + 浅色内容页");
    expect(rendered.markdown).toContain("## 说明");
    expect(rendered.markdown).toContain("## 验收标准");
    expect(rendered.acceptance).toContain("按云文档《产品介绍演示文稿制作计划》中的计划生成整册演示文稿");
    expect(rendered.acceptance).toContain("色板与字体按「设计决策」执行");
  });

  it("没有设计决策时省略该节与验收里的配色要求", () => {
    const { fonts: _fonts, ...withoutFonts } = baseDraft;
    const rendered = renderDeckPlanDocument({ ...withoutFonts, palette: [], notes: [] });
    expect(rendered.markdown).not.toContain("## 设计决策");
    expect(rendered.acceptance).not.toContain("色板与字体");
  });

  it("英文 locale 渲染英文标题与验收，不混入中文", () => {
    const rendered = renderDeckPlanDocument(
      {
        ...baseDraft,
        planTitle: "About Me Profile Deck - Build Plan",
        plan: ["Read profile materials", "Define page structure", "Write pptxgenjs script", "Generate pptx"],
        notes: ["Dark navy cover and closing slides, light content pages"],
      },
      "en-US",
    );
    expect(rendered.markdown).toContain("## Steps");
    expect(rendered.markdown).toContain("1. Read profile materials");
    expect(rendered.markdown).toContain("## Design decisions");
    expect(rendered.markdown).toContain("- Palette: `#0b5fff`");
    expect(rendered.markdown).toContain("- Heading font: Source Han Sans");
    expect(rendered.markdown).toContain("## Acceptance criteria");
    expect(rendered.acceptance).toContain("\"About Me Profile Deck - Build Plan\"");
    // 固定文案不再混入中文标题。
    expect(rendered.markdown).not.toMatch(/执行步骤|设计决策|验收标准|说明/);
    expect(rendered.acceptance).not.toMatch(/云文档|演示文稿/);
  });

  it("未提供 locale 时保持中文（既有行为）", () => {
    const rendered = renderDeckPlanDocument(baseDraft);
    expect(rendered.markdown).toContain("## 执行步骤");
    expect(rendered.acceptance).toContain("按云文档《产品介绍演示文稿制作计划》");
  });
});

describe("createDeckPlanRecorder", () => {
  it("落成云文档 + 计划页任务（标题/验收/文档引用），并绑定工作空间", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    const record = await persist(runInput("run-1"), baseDraft);

    expect(documents.syncExternalMarkdown).toHaveBeenCalledTimes(1);
    const syncInput = documents.syncExternalMarkdown.mock.calls[0]![0];
    expect(syncInput.documentId).toBe(record.documentId);
    expect(syncInput.title).toBe("产品介绍演示文稿制作计划");
    expect(syncInput.markdown).toContain("## 执行步骤");
    expect(documents.bindDocumentWorkspace).toHaveBeenCalledWith(record.documentId, "ws-1");

    expect(record.planItemId).not.toBeNull();
    const item = plans.get(record.planItemId!);
    expect(item.title).toBe("产品介绍演示文稿制作计划");
    expect(item.status).toBe("todo");
    expect(item.createdBy).toBe("agent");
    expect(item.workspaceId).toBe("ws-1");
    expect(item.acceptance).toContain("按云文档《产品介绍演示文稿制作计划》");
    expect(item.refs).toEqual([{ kind: "document", id: record.documentId, title: "产品介绍演示文稿制作计划" }]);
    expect(item.detail).toContain("1. 读取产品资料");
  });

  it("同一 run 重出卡复用同一份云文档与同一条任务，只同步内容", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    const first = await persist(runInput("run-1"), baseDraft);
    tick();
    const adjusted: DeckPlanDraft = {
      ...baseDraft,
      palette: ["#7c3aed", "#f8fafc", "#f59e0b"],
      plan: ["读取产品资料", "改配色后重新出卡"],
    };
    const second = await persist(runInput("run-1"), adjusted);

    expect(second.documentId).toBe(first.documentId);
    expect(second.planItemId).toBe(first.planItemId);
    expect(documents.syncExternalMarkdown).toHaveBeenCalledTimes(2);
    expect(documents.syncExternalMarkdown.mock.calls[1]![0].documentId).toBe(first.documentId);
    const item = plans.get(first.planItemId!);
    expect(item.detail).toContain("改配色后重新出卡");
    expect(item.version).toBeGreaterThan(1);
  });

  it("用户已推进任务（doing）时不再覆盖内容", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    const first = await persist(runInput("run-1"), baseDraft);
    plans.move(first.planItemId!, { version: plans.get(first.planItemId!).version, status: "doing" }, { kind: "user" });

    const second = await persist(runInput("run-1"), { ...baseDraft, planTitle: "改过的标题" });
    expect(second.planItemId).toBe(first.planItemId);
    expect(plans.get(first.planItemId!).title).toBe("产品介绍演示文稿制作计划");
  });

  it("不同 run 各建一份（新的一轮计划 = 新的文档与任务）", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    const first = await persist(runInput("run-1"), baseDraft);
    const second = await persist(runInput("run-2"), baseDraft);
    expect(second.documentId).not.toBe(first.documentId);
    expect(second.planItemId).not.toBe(first.planItemId);
    expect(plans.list({ workspaceId: "ws-1" })).toHaveLength(2);
  });

  it("英文 locale 落成英文文档结构与英文计划任务说明", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    const englishDraft: DeckPlanDraft = {
      planTitle: "About Me Profile Deck - Build Plan",
      body: "Materials come from the workspace profile document.",
      plan: ["Read profile materials", "Define page structure", "Write pptxgenjs script"],
      palette: ["#0f1b2d", "#1c7293", "#f2a65a"],
      fonts: { heading: "Arial", body: "Arial" },
      notes: ["Dark navy cover and closing slides"],
    };
    const record = await persist(runInput("run-en", "ws-1", "en-US"), englishDraft);

    const syncInput = documents.syncExternalMarkdown.mock.calls[0]![0];
    expect(syncInput.title).toBe("About Me Profile Deck - Build Plan");
    expect(syncInput.markdown).toContain("## Steps");
    expect(syncInput.markdown).toContain("## Design decisions");
    expect(syncInput.markdown).toContain("## Acceptance criteria");
    expect(syncInput.markdown).not.toMatch(/执行步骤|设计决策|验收标准/);

    const item = plans.get(record.planItemId!);
    expect(item.detail).toContain("Plan document \"About Me Profile Deck - Build Plan\"");
    expect(item.detail).not.toContain("计划文档");
    expect(item.acceptance).toContain("cloud document \"About Me Profile Deck - Build Plan\"");
  });

  it("planTitle 为空时按 locale 取中/英缺省标题", async () => {
    const documents = documentsHarness();
    const persist = createDeckPlanRecorder({ documents, plans });

    await persist(runInput("run-zh-empty"), { ...baseDraft, planTitle: "" });
    expect(documents.syncExternalMarkdown.mock.calls[0]![0].title).toBe("演示文稿制作计划");

    await persist(runInput("run-en-empty", "ws-1", "en-US"), { ...baseDraft, planTitle: "" });
    expect(documents.syncExternalMarkdown.mock.calls[1]![0].title).toBe("Presentation plan");
  });
});
