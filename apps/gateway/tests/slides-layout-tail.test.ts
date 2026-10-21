import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { runLayouterTail, type LayouterTailDeps } from "../src/modules/subagents/slides-layout-tail.js";
import type { SlidesProgressTracker } from "../src/modules/subagents/slides-progress-tracker.js";

function invocationWithTree(tree: unknown, status = "completed"): SubagentInvocation {
  return {
    status,
    result: { structuredOutput: { status: "done", tree } },
  } as unknown as SubagentInvocation;
}

interface Harness {
  deps: LayouterTailDeps;
  bridge: {
    generate: ReturnType<typeof vi.fn>;
    fillPage: ReturnType<typeof vi.fn>;
    completeDeck: ReturnType<typeof vi.fn>;
  };
  progress: {
    arm: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    disarm: ReturnType<typeof vi.fn>;
  };
  dispatches: Array<{ input: Record<string, unknown>; key: string }>;
  settled: string[];
  trashed: string[];
}

function makeHarness(
  treesPerDispatch: Array<unknown | "FAIL">,
  persistentlyFailingPages: Set<number> = new Set(),
): Harness {
  const dispatches: Array<{ input: Record<string, unknown>; key: string }> = [];
  let dispatchCursor = 0;
  const bridge = {
    generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
    fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
    renderPage: vi.fn().mockResolvedValue(""),
    completeDeck: vi.fn().mockResolvedValue({ ok: true }),
  };
  const progress = {
    arm: vi.fn(),
    notify: vi.fn(),
    disarm: vi.fn(),
    setRelay: vi.fn(),
  };
  const settled: string[] = [];
  const trashed: string[] = [];
  const deps: LayouterTailDeps = {
    progress: progress as unknown as SlidesProgressTracker,
    bridge: bridge as never,
    visualReviewer: null,
    readMaterialBlob: vi.fn().mockResolvedValue(null),
    fetchImageHead: vi.fn().mockResolvedValue(null),
    makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
    dispatchPage: async (input, key) => {
      dispatches.push({ input, key });
      const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
      if (persistentlyFailingPages.has(pageIndex)) throw new Error("subagent_concurrency_limit");
      const entry = treesPerDispatch[dispatchCursor++] ?? treesPerDispatch[treesPerDispatch.length - 1];
      dispatchCursor = Math.min(dispatchCursor, treesPerDispatch.length - 1);
      if (entry === "FAIL") throw new Error("subagent_concurrency_limit");
      if (entry === "RUN_FAIL") {
        return { status: "failed", result: null, error_code: "runtime_error" } as unknown as SubagentInvocation;
      }
      return invocationWithTree(entry);
    },
  };
  return { deps, bridge, progress, dispatches, settled, trashed };
}

const CONTENT_TREE = {
  role: "content",
  title: "页一",
  direction: "row",
  weights: [1.6, 1],
  children: [
    { type: "image", url: "https://example.com/a.jpg" },
    { direction: "column", gapScale: 1.5, children: [
      { type: "text", variant: "heading", text: "小标题" },
      { type: "text", variant: "body", text: "要点内容", bullet: true },
    ] },
  ],
};

const CHART_TREE = {
  role: "data",
  title: "数据页",
  direction: "column",
  children: [
    { type: "chart", kind: "bar", categories: ["2025", "2026"], series: [{ name: "收入", values: [1, 2] }] },
  ],
};

const QUOTE_TREE = {
  role: "quote",
  title: "引用页",
  direction: "column",
  pad: 32,
  children: [
    { type: "text", variant: "heading", text: "一句话", align: "center" },
  ],
};

function planOf(trees: unknown[]): Record<string, unknown> {
  return {
    title: "测试演示",
    pages: trees.map((tree, index) => ({
      title: (tree as { title?: string }).title ?? `第 ${index + 1} 页`,
      role: (tree as { role?: string }).role,
      density: "standard",
      points: ["要点一", "要点二"],
    })),
  };
}

function armPlanOf(plan: Record<string, unknown>) {
  return {
    title: "测试演示",
    pages: (plan.pages as Array<{ title?: string }>).map((page) => ({ title: page.title ?? "" })),
    warnings: [],
  } as never;
}

function tailArgs(plan: Record<string, unknown>, harness: Harness) {
  return {
    roomId: "room-1",
    sessionId: "session-1",
    runId: "run-1",
    parentRunId: "parent-1",
    instruction: "测试",
    plan,
    armPlan: armPlanOf(plan),
    styleParams: null,
    draftDocumentId: "draft-1",
    settle: { styleSessionIdToSettle: "style-1" },
    styleSessions: { patch: (id: string) => harness.settled.push(id) },
    pageImagesStore: null,
    trashDraft: async (id: string) => {
      harness.trashed.push(id);
    },
  };
}

describe("runLayouterTail", () => {
  it("三页直落：按页序落页、逐页进度、回收草稿与落定风格", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.fileEntryId).toBe("file-1");
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1, 2]);
    expect(harness.progress.notify.mock.calls.map((call: unknown[]) => call[1])).toEqual([0, 1, 2]);
    expect(harness.progress.arm.mock.calls[0]![0]).toBe("slides-generate:run-1");
    expect(harness.progress.disarm).toHaveBeenCalledWith("slides-generate:run-1");
    expect(harness.trashed).toEqual(["draft-1"]);
    expect(harness.settled).toEqual(["style-1"]);
    expect(harness.dispatches.every((d) => d.input.deckToken === "run-1:layout")).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("全部页落定后发最终 page_applied 全量快照并补发 done（deferDone 真完成时机）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    // 骨架入库阶段不广播 done：generate 请求带 deferDone。
    expect(harness.bridge.generate).toHaveBeenCalledWith(expect.objectContaining({ deferDone: true }));
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({
      stage: "page_applied",
      completed: true,
      doneCount: 2,
      totalPages: 2,
      roomId: "room-1",
      documentId: "draft-1",
      fileEntryId: "file-1",
      fileName: "deck.pptx",
    });
    expect(typeof final.details.updatedAt).toBe("number");
    expect(final.details.failedPages).toBeUndefined();
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "file-1",
      completed: true,
      appliedPages: 2,
      totalPages: 2,
    }));
  });

  it("落页失败页进 failedPages 且补发 partial done（不做假完成）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    harness.bridge.fillPage.mockImplementation(async (input: { slideIndex: number }) =>
      input.slideIndex === 0 ? { ok: false, applied: false, error: "桌面端拒绝" } : { ok: true, applied: true });
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("partial");
    expect(payload.failedPages).toEqual([0]);
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({ stage: "page_applied", completed: false, doneCount: 1, failedPages: [0] });
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({
      completed: false,
      appliedPages: 1,
      failedPages: [0],
    }));
  });

  it("流式落页：首页树就绪即落页，不等后页树齐", async () => {
    let page1Resolved = false;
    let releasePage1: ((invocation: SubagentInvocation) => void) | null = null;
    const bridge = {
      generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
      fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
      renderPage: vi.fn().mockResolvedValue(""),
    };
    const progress = { arm: vi.fn(), notify: vi.fn(), disarm: vi.fn(), setRelay: vi.fn() };
    const deps: LayouterTailDeps = {
      progress: progress as unknown as SlidesProgressTracker,
      bridge: bridge as never,
      visualReviewer: null,
      readMaterialBlob: vi.fn().mockResolvedValue(null),
      fetchImageHead: vi.fn().mockResolvedValue(null),
      makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
      dispatchPage: (input: Record<string, unknown>) => {
        const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
        if (pageIndex === 0) return Promise.resolve(invocationWithTree(CONTENT_TREE));
        return new Promise<SubagentInvocation>((resolve) => {
          releasePage1 = (invocation) => {
            page1Resolved = true;
            resolve(invocation);
          };
        });
      },
    };
    const plan = planOf([CONTENT_TREE, CHART_TREE]);
    const runPromise = runLayouterTail(deps, {
      roomId: "room-1",
      sessionId: "session-1",
      runId: "run-1",
      parentRunId: "parent-1",
      instruction: "测试",
      plan,
      armPlan: armPlanOf(plan),
      styleParams: null,
      draftDocumentId: "draft-1",
      settle: { styleSessionIdToSettle: "style-1" },
      styleSessions: { patch: () => {} },
      pageImagesStore: null,
      trashDraft: async () => {},
    });
    await vi.waitFor(() => expect(bridge.fillPage).toHaveBeenCalledWith(expect.objectContaining({ slideIndex: 0 })));
    // 第 2 页树仍挂起时首页已落——落页与取树流水线化的直接证据。
    expect(page1Resolved).toBe(false);
    releasePage1!(invocationWithTree(CHART_TREE));
    const result = await runPromise;
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    const appliedIndexes = bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1]);
    expect(progress.notify.mock.calls.map((call: unknown[]) => call[1])).toEqual([0, 1]);
  });

  it("素材分辨率不足时丢图并告警，避免低清图铺满页面", async () => {
    const canvas = createCanvas(300, 168);
    const buffer = canvas.toBuffer("image/png");
    const tiny = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const harness = makeHarness([CONTENT_TREE]);
    harness.deps.readMaterialBlob = vi.fn(async () => tiny);
    const plan = {
      title: "封面测试",
      pages: [{
        title: "封面",
        role: "cover",
        density: "sparse",
        points: ["封面"],
        materials: [{ url: `everroom-material://${"a".repeat(64)}`, desc: "低清图" }],
      }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(harness.dispatches[0]!.input.materials).toBeUndefined();
    expect(payload.warnings.join("")).toContain("分辨率不足");
  });

  it("v2 页面：layouter 输入带 layoutVersion/copy/composition，且不传 points", async () => {
    const v2Tree = {
      version: 2,
      role: "data",
      composition: "hero-data",
      footer: { pageNumbers: true },
      nodes: [
        { type: "text", token: "hero", text: "2.7", slot: { col: [1, 4], row: [1, 3] } },
        { type: "stats", items: [{ value: "2.83", unit: "万亿元", label: "2020 年 GDP" }, { value: "3.87", unit: "万亿元", label: "2025 年 GDP" }], slot: { col: [5, 8], row: [1, 3] } },
      ],
    };
    const harness = makeHarness([v2Tree]);
    const plan = {
      title: "v2 deck",
      pages: [{
        title: "数据页",
        role: "data",
        density: "dense",
        points: ["兜底要点"],
        layoutVersion: 2,
        composition: "hero-data",
        emphasis: "number",
        intent: "建立规模事实。",
        takeaway: "两个量级。",
        copy: { message: "从 2.7 亿到 3.87 万亿元", supporting: [], facts: [], speakerNotes: "讲稿".repeat(20) },
        data: { stats: [{ value: "2.83", unit: "万亿元", label: "2020 年 GDP" }] },
        neighbors: [{ pageIndex: 1, composition: "editorial", takeaway: "下一句" }],
        budget: { prose: 60, copy: 120, notes: 260 },
      }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(harness.dispatches[0]!.input.layoutVersion).toBe(2);
    expect(harness.dispatches[0]!.input.composition).toBe("hero-data");
    expect(harness.dispatches[0]!.input.copy).toMatchObject({ message: "从 2.7 亿到 3.87 万亿元" });
    expect(harness.dispatches[0]!.input.points).toBeUndefined();
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
  });

  it("布局代理失败页落确定性兜底并告警，整册仍完成", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE], new Set([0]));
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.warnings.some((w: string) => /第 1 页布局代理未收敛/.test(w))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(3);
  });

  it("相邻页同构触发一次重排：重排 dispatch 带邻页签名并重落该页", async () => {
    const rerolled = { ...CONTENT_TREE, direction: "column" };
    const harness = makeHarness([CONTENT_TREE, CONTENT_TREE, QUOTE_TREE, rerolled]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CONTENT_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.warnings.some((w: string) => /第 2 页与邻页结构雷同/.test(w))).toBe(true);
    const rerollDispatch = harness.dispatches.find((d) => d.key.includes("reroll:1"));
    expect(rerollDispatch).toBeDefined();
    expect(Array.isArray(rerollDispatch!.input.neighborSignatures)).toBe(true);
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes.filter((i) => i === 1).length).toBe(2);
  });

  it("带引擎硬闸缺陷的页落兜底版式，不级联失败（真机 2026-10-15 事故回归）", async () => {
    const emojiTree = {
      role: "content",
      title: "会失败的页",
      direction: "column",
      children: [{ type: "text", variant: "body", text: "带 emoji 🎉 的树" }],
    };
    const harness = makeHarness([emojiTree, CHART_TREE, QUOTE_TREE]);
    harness.bridge.fillPage.mockImplementation(async (input: { slideIndex: number }) =>
      input.slideIndex === 0 ? { ok: false, applied: false, error: "桌面端拒绝" } : { ok: true, applied: true });
    const plan = {
      title: "测试演示",
      pages: [
        { title: "会失败的页", points: ["要点一"], role: "content", density: "standard" },
        { title: "数据页", role: "data", density: "standard" },
        { title: "引用页", role: "quote", density: "standard" },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    // 首页落页仍失败（模拟引擎拒绝兜底外的场景）→ 后续页按追加语义继续，不再越界级联。
    expect(payload.status).toBe("partial");
    expect(payload.warnings.some((w: string) => /第 1 页布局树未收敛/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /第 1 页落页失败/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /slideIndex must be an integer/.test(w))).toBe(false);
    expect(payload.warnings.some((w: string) => /第 [23] 页落页失败/.test(w))).toBe(false);
    expect(payload.pages).toBe(2);
    // 第 2、3 页：首页失败后 deck 仍 1 页骨架 → slideIndex 各为 1、2（追加语义）。
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1, 2]);
  });

  it("建 deck 失败回 failed 不落任何页", async () => {
    const harness = makeHarness([CONTENT_TREE]);
    harness.bridge.generate.mockResolvedValueOnce({ fileEntryId: "" });
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(0);
    expect(harness.trashed).toEqual([]);
  });

  it("布局代理未交树先减配重试：砍半要点/去图表行/降密度，重试树被采用", async () => {
    const harness = makeHarness(["RUN_FAIL", CHART_TREE, CONTENT_TREE]);
    const plan = {
      title: "测试演示",
      pages: [
        { title: "密集数据页", role: "data", density: "dense",
          points: ["要点一", "要点二", "要点三", "要点四"],
          data: "bar | categories: 甲, 乙 | 系列: 1, 2\n入境过夜游客: 1308.20 万人次（+34.0%）",
          notes: "环形图表现构成" },
        { title: "正常页", role: "content", density: "standard", points: ["要点一", "要点二"] },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /第 1 页布局代理减配重试后收敛/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /未收敛/.test(w))).toBe(false);
    const trimmed = harness.dispatches.find((d) => d.key.includes(":trimmed"));
    expect(trimmed).toBeDefined();
    expect(trimmed!.input.density).toBe("sparse");
    expect(trimmed!.input.points).toEqual(["要点一", "要点二"]);
    expect(String(trimmed!.input.data)).toBe("入境过夜游客: 1308.20 万人次（+34.0%）");
    expect(String(trimmed!.input.data)).not.toContain("categories");
    expect(trimmed!.input.notes).toBeUndefined();
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1]);
  });

  it("减配重试仍不收敛才落结构化兜底：pointList 条目 + stats KPI，不再是圆点文本墙", async () => {
    const harness = makeHarness(["RUN_FAIL"]);
    const plan = {
      title: "测试演示",
      pages: [
        { title: "入境游客数据页", role: "data", density: "dense",
          points: [
            "地标：平安金融中心 592.5 米，为深圳第一高楼。",
            "山海：梧桐山 943.7 米为深圳第一高峰。",
            "人文：世界之窗汇聚 130 余个微缩景观。",
            "湾区：湾区之光摩天轮位于宝安欢乐港湾。",
          ],
          data: "入境过夜游客: 1308.20 万人次（+34.0%）\n旅游外汇收入: 110.67 亿美元（+51.2%）\ndoughnut | categories: 甲, 乙 | 系列: 1, 2" },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /第 1 页布局代理未收敛，已用兜底版式/.test(w))).toBe(true);
    expect(harness.dispatches.some((d) => d.key.includes(":trimmed"))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
    const specJson = String((harness.bridge.fillPage.mock.calls[0]![0] as { specJson: string }).specJson);
    expect(specJson).toContain("地标");
    expect(specJson).toContain("人文");
    expect(specJson).toContain("1308.20");
    expect(specJson).toContain("入境过夜游客（+34.0%）");
    // 不再产出圆点 bullet 文本墙
    expect(specJson).not.toContain('"bullet":true');
  });

  it("styleTokens：v1/v2 layouter 输入都带风格卡确定性快照（composition/motif/decoration/componentDefaults，体积 ≤1200）", async () => {
    const styleParams = {
      composition: "poster",
      darkCover: false,
      motif: { kind: "color-band" },
      palette: {
        background: "#0e0d0c",
        surface: "#1a1917",
        primary: "#e8c468",
        accent: "#e85d3d",
        text: "#f7f4ec",
        textMuted: "#a8a399",
        onDarkText: "#f7f4ec",
        chartSeries: ["#e8c468", "#e85d3d", "#5b8def", "#8a94a8", "#c9a063", "#6e6a61"],
      },
      typography: { fontHeading: "Songti SC, Georgia", fontBody: "PingFang SC", headingBold: true },
      spacing: { margin: 64, gutter: 24, cardPadding: 20, cornerRadius: 16 },
      decoration: { cardShadow: "soft", divider: "none", imageFit: "contain" },
    };

    const v1Harness = makeHarness([CONTENT_TREE]);
    await runLayouterTail(v1Harness.deps, { ...tailArgs(planOf([CONTENT_TREE]), v1Harness), styleParams });

    const v2Tree = {
      version: 2,
      role: "cover",
      composition: "poster",
      nodes: [{ type: "text", token: "display", text: "海报标题", slot: { col: [1, 8], row: [1, 3] } }],
    };
    const v2Harness = makeHarness([v2Tree]);
    const v2Plan = {
      title: "海报 deck",
      pages: [{
        title: "海报页",
        role: "cover",
        density: "standard",
        layoutVersion: 2,
        composition: "poster",
        copy: { message: "海报标题" },
      }],
    };
    await runLayouterTail(v2Harness.deps, { ...tailArgs(v2Plan, v2Harness), styleParams });

    interface StyleTokensSnapshot {
      composition: string;
      darkCover: boolean;
      motif: Record<string, unknown>;
      palette: { accent: string; primary: string; chartSeries: string[]; [key: string]: unknown };
      typeScale: Record<string, number>;
      fonts: { heading?: string; [key: string]: unknown };
      decoration: Record<string, unknown>;
      componentDefaults: Record<string, unknown>;
    }
    const snapshots = [v1Harness, v2Harness].map((harness) => {
      // 首页 dispatch 的输入里必须带确定性 token 快照（v1 与 v2 同源同形）。
      expect(harness.dispatches.length).toBeGreaterThan(0);
      const raw = harness.dispatches[0]!.input.styleTokens;
      expect(raw).toBeDefined();
      expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1200);
      return raw as unknown as StyleTokensSnapshot;
    });
    const [v1Tokens, v2Tokens] = snapshots as [StyleTokensSnapshot, StyleTokensSnapshot];
    expect(v1Tokens).toEqual(v2Tokens);
    expect(v1Tokens.composition).toBe("poster");
    expect(v1Tokens.darkCover).toBe(false);
    expect(v1Tokens.motif).toEqual({ kind: "color-band" });
    expect(v1Tokens.decoration).toMatchObject({ cardShadow: "soft", divider: "none", imageFit: "contain" });
    expect(v1Tokens.palette.accent).toBe("#e85d3d");
    expect(v1Tokens.palette.primary).toBe("#e8c468");
    // chartSeries 只留 4 只，避免 token 快照膨胀。
    expect(v1Tokens.palette.chartSeries).toEqual(["#e8c468", "#e85d3d", "#5b8def", "#8a94a8"]);
    // 组件默认值 = 风格卡 design 轴：cardShadow 有值 → card；divider none → gap；poster → airy；accent 与 primary 不同 → accent。
    expect(v1Tokens.componentDefaults).toEqual({
      surface: "card",
      separator: "gap",
      align: "start",
      density: "airy",
      numeral: "serif",
      accent: "accent",
    });
    // 字体名只保留首字体（OOXML 单字体），超 40 字截断由 styleTokensFrom 处理。
    expect(v1Tokens.fonts.heading).toBe("Songti SC");
    expect(v1Tokens.typeScale.hero).toEqual(expect.any(Number));
  });

  it("reviewer 输入同样带 styleTokens（审页也能判断是否破坏风格卡）", async () => {
    const styleParams = {
      composition: "poster",
      darkCover: false,
      motif: { kind: "color-band" },
      palette: { background: "#0e0d0c", surface: "#1a1917", primary: "#e8c468", accent: "#e85d3d", text: "#f7f4ec", textMuted: "#a8a399", onDarkText: "#f7f4ec" },
      typography: { fontHeading: "Songti SC", fontBody: "PingFang SC", headingBold: true },
      spacing: { margin: 64, gutter: 24, cardPadding: 20, cornerRadius: 16 },
      decoration: { cardShadow: "soft", divider: "none", imageFit: "contain" },
    };
    const harness = makeHarness([CONTENT_TREE]);
    const reviews: Array<Record<string, unknown>> = [];
    harness.deps.dispatchReview = async (input) => {
      reviews.push(input as unknown as Record<string, unknown>);
      return {
        status: "completed",
        result: { structuredOutput: { status: "ok" } },
      } as unknown as SubagentInvocation;
    };
    await runLayouterTail(harness.deps, { ...tailArgs(planOf([CONTENT_TREE]), harness), styleParams });
    expect(reviews.length).toBeGreaterThan(0);
    const tokens = reviews[0]!.styleTokens as { composition?: string; decoration?: Record<string, unknown> } | undefined;
    expect(tokens).toBeDefined();
    expect(tokens!.composition).toBe("poster");
    expect(tokens!.decoration).toMatchObject({ divider: "none", imageFit: "contain" });
  });

  // 2026-10-20 事故回归：遗留 invocation 占满全局子代理并发窗口，整册页全部拿不到
  // 布局树却落兜底版式回 completed。页级退避 2s+6s（单页约 8s），用例保持 2~4 页。
  it("全部页布局代理并发不可用：不交付兜底整册，回报可重试失败", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE], new Set([0, 1]));
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("slides_layout_agents_unavailable");
    expect(payload.retryable).toBe(true);
    expect(payload.failedPages).toEqual([0, 1]);
    expect(payload.fileEntryId).toBe("file-1");
    expect(payload.warnings.some((w: string) => w.includes("布局代理并发不可用"))).toBe(true);
    // 已落页保留（兜底版式写入 deck），重试可复用；但绝不静默报成功。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(2);
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({ completed: false }));
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({ stage: "page_applied", completed: false, failedPages: [0, 1] });
    // 代理不可用不是「树不合格」：不派 reroll、不审页、不回草稿、不落定风格会话。
    expect(harness.dispatches.every((d) => !d.key.includes("reroll:"))).toBe(true);
    expect(harness.settled).toEqual([]);
  }, 30_000);

  it("过半页不可用即判定失败，不静默成功（容差边界 ceil(4/2)=2）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE, CONTENT_TREE], new Set([0, 2]));
    const result = await runLayouterTail(
      harness.deps,
      tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE, CONTENT_TREE]), harness),
    );
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("slides_layout_agents_unavailable");
    expect(payload.retryable).toBe(true);
    expect(payload.failedPages).toEqual(expect.arrayContaining([0, 2]));
    expect(payload.warnings.some((w: string) => w.includes("布局代理并发不可用"))).toBe(true);
  }, 30_000);
});
