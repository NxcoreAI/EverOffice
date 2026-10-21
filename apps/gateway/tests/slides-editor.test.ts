import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  buildShadowReport,
  checkStoryboard,
  dispatchEditorStoryboard,
  editorPagesFromPlan,
  mergeStoryboardIntoPlan,
  normalizeStoryboard,
  scrubPageCopy,
  type EditorStoryboard,
  type EditorDraftPage,
} from "../src/modules/subagents/slides-editor.js";
import { SlidesStoryboardStore } from "../src/modules/subagents/slides-storyboards-store.js";

const drafts = [
  {
    title: "封面",
    points: [
      "深圳城市专题：从 1979 年建市与 1980 年设经济特区讲起，讲到今天的产业底盘与城市生活。",
      "全篇只保留少数最能说明问题的数据，并标注口径：1980 年为期初口径，2025 年为初步统计数。",
    ],
  },
  {
    title: "45 年：从 2.7 亿元到 3.87 万亿元",
    points: [
      "1980 年深圳地区生产总值约 2.7 亿元，这是特区建立初期的期初口径。",
      "2025 年深圳地区生产总值 38731.80 亿元，比上年增长 5.5%，这是初步统计数。",
      "两个数字口径不同，不可直接比较，只用于说明量级变化。",
    ],
    data: "bar | categories: 2020 年, 2025 年 | 地区生产总值(万亿元): 2.83, 3.87",
  },
  {
    title: "蛇口建港填海",
    points: [
      "蛇口原是一个不足千人的滨海村镇，它开始建港填海。",
      "1979 年 4 月，广东省委提出兴办对外加工贸易区的建议；邓小平同志提出「就叫特区」。",
    ],
  },
];

function fixture(): EditorStoryboard {
  return {
    schemaVersion: "storyboard/v2",
    deck: { title: "深圳：一座仍在生长的城市", spine: "城市不是自然生长出来的。", visualThesis: "极简人文" },
    pages: [
      {
        id: "page-01",
        role: "cover",
        density: "sparse",
        composition: "immersive",
        emphasis: "title",
        intent: "先给城市定性：不是自然生长出来的。",
        takeaway: "四十五年，一座城仍在生长。",
        copy: {
          kicker: "深圳专题 · 2026",
          message: "深圳：一座仍在生长的城市",
          supporting: ["从 1979 年建市到 2025 年，四十五年造出一座城"],
          facts: [],
          source: "数据口径：1980 年期初 · 2025 年初步统计",
          speakerNotes: "开场先不报数据。用这张照片让听众先看到尺度，停顿两秒再报标题。全片只讲一条主线：城市是被设计出来的。".repeat(2).slice(0, 100),
        },
        dropped: [{ from: "draft-page-01", text: "主要数据来源", reason: "进讲稿", movedToNotes: true }],
      },
      {
        id: "page-02",
        role: "data",
        density: "dense",
        composition: "hero-data",
        emphasis: "number",
        intent: "用一个量级跨越建立规模的事实底座。",
        takeaway: "四十五年，经济量级已完全不同。",
        copy: {
          kicker: "45 年 · 经济总量",
          message: "从 2.7 亿到 3.87 万亿元",
          supporting: [],
          facts: [
            { label: "1980 年 GDP", value: "2.7", unit: "亿元", note: "期初口径" },
            { label: "2025 年 GDP", value: "3.87", unit: "万亿元", note: "初步统计" },
          ],
          source: "数据来源：深圳市 2025 年统计公报。口径不同，只列绝对数。",
          speakerNotes: "这一页只让听众记住两个量级，不展开讲增速。右上角小图只作为证据，不逐条念数字。口径差异要主动说明，避免被追问。四十五年的跨度用两个数字就够，不要把它讲成一串增长率。",
        },
        dropped: [{ from: "draft-page-05", text: "增速居一线城市首位", reason: "进讲稿", movedToNotes: true }],
      },
      {
        id: "page-03",
        role: "content",
        density: "standard",
        composition: "editorial",
        emphasis: "quote",
        intent: "把制度起点落到一个具体动作上：蛇口填海。",
        takeaway: "蛇口的一声炮响，拉开了特区建设的帷幕。",
        copy: {
          kicker: "1979 · 蛇口",
          message: "蛇口，拉开特区建设的帷幕",
          supporting: [],
          facts: [
            { label: "起点规模", body: "不足千人的滨海村镇" },
            { label: "起点动作", body: "建港填海" },
            { label: "时间区间", body: "1979—1980 年" },
          ],
          quote: { text: "就叫特区", attribution: "——邓小平同志" },
          source: "资料：招商局史、深圳市志",
          speakerNotes: "讲蛇口不要铺陈背景，只讲一个动作：填海。就叫特区这句话放在页面中部，是全片的情绪锚点。三组事实留给听众自己扫读，讲的时候只展开不足千人和 1979 到 1980 两个数字。",
        },
        dropped: [{ from: "draft-page-03", text: "深圳承载着改革试验田的功能", reason: "进讲稿", movedToNotes: true }],
      },
    ],
    warnings: [],
  };
}

describe("slides-editor shadow checks", () => {
  it("deckComposition：核心构图必须出现，且至少半数页落在风格卡家族内", () => {
    const board = fixture();
    for (const page of board.pages) page.composition = "swiss";
    const poster = checkStoryboard(board, drafts, { deckComposition: "poster" });
    expect(poster.errors.some((error) => error.includes("构图家族 poster"))).toBe(true);

    // 两页落回 poster 家族（core + hero-data）后应通过构图家族校验。
    board.pages[0]!.composition = "poster";
    board.pages[1]!.composition = "hero-data";
    const fixed = checkStoryboard(board, drafts, { deckComposition: "poster" });
    expect(fixed.errors.some((error) => error.includes("构图家族"))).toBe(false);

    // 未传 deckComposition 时不启用家族约束。
    expect(checkStoryboard(board, drafts).errors.some((error) => error.includes("构图家族"))).toBe(false);
  });
  it("passes a valid 3-page storyboard and reports prose reduction", () => {
    const report = buildShadowReport(fixture(), drafts);
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.pageCount).toBe(3);
    expect(report.draftPageCount).toBe(3);
    expect(report.compositions).toEqual(["immersive", "hero-data", "editorial"]);
    expect(report.reductionPct).not.toBeNull();
    expect(report.pages[1]?.proseChars).toBeLessThan(40);
  });

  it("rejects message over 24 chars and notes outside 60~260", () => {
    const board = fixture();
    board.pages[0]!.copy.message = "这是一句远远超过二十四字预算的页面主张文案，必须被拒收";
    board.pages[1]!.copy.speakerNotes = "太短";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("message"))).toBe(true);
    expect(check.errors.some((error) => error.includes("speakerNotes"))).toBe(true);
  });

  it("rejects metadata on slide and supporting overflow", () => {
    const board = fixture();
    board.pages[0]!.copy.message = "全篇 12 页，约 15 分钟";
    board.pages[0]!.copy.supporting = ["一行", "两行"];
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("制作元数据"))).toBe(true);
    expect(check.errors.some((error) => error.includes("supporting"))).toBe(true);
  });

  it("rejects page count mismatch and same adjacent composition", () => {
    const board = fixture();
    board.pages.pop();
    board.pages[1]!.composition = "immersive";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("页数"))).toBe(true);
    expect(check.warnings.some((warning) => warning.includes("composition"))).toBe(true);
  });

  it("normalizes missing ids and filters malformed dropped entries", () => {
    const raw = fixture() as unknown as Record<string, unknown>;
    const pages = raw.pages as Array<Record<string, unknown>>;
    delete pages[0]!.id;
    pages[0]!.dropped = [{ from: "draft", reason: "缺 text" }, { from: "draft", text: "x", reason: "ok" }];
    const normalized = normalizeStoryboard(raw);
    expect(normalized.storyboard?.pages[0]?.id).toBe("page-01");
    expect(normalized.storyboard?.pages[0]?.dropped).toEqual([{ from: "draft", text: "x", reason: "ok" }]);
  });
});

describe("copy scrub", () => {
  it("removes caveat clauses and ellipses from page copy, keeps source name", () => {
    const copy = scrubPageCopy({
      kicker: "市场基础",
      message: "需求同源于户外……",
      supporting: ["飞行俱乐部 1500+", "口径待核实"],
      facts: [
        { label: "机场", value: "20061", note: "待核实" },
        { label: "来源", value: "BP", note: "2024 年" },
      ],
      source: "数据来源：Nexwing BP；口径待核实；统计口径不完全对应",
      speakerNotes: "讲稿保留全部口径与待核实说明。",
    });
    expect(copy.message).toBe("需求同源于户外");
    expect(copy.supporting).toEqual(["飞行俱乐部 1500+"]);
    expect(copy.facts).toHaveLength(2);
    expect(copy.facts[0]).not.toHaveProperty("note");
    expect(copy.facts[1]?.note).toBe("2024 年");
    expect(copy.source).toBe("数据来源：Nexwing BP");
    expect(copy.speakerNotes).toContain("口径");
  });
});

describe("storyboard plan merge", () => {
  it("keeps planner materials/points and adds v2 copy/composition/neighbors", () => {
    const plan = {
      title: "深圳",
      pages: [
        { title: "封面", role: "cover", density: "sparse", points: ["a"], materials: [{ url: "everroom-material://x" }] },
        { title: "数据", role: "data", density: "dense", points: ["b"], data: "bar | categories: 1, 2 | x: 1, 2" },
        { title: "叙事", role: "content", density: "standard", points: ["c"] },
      ],
    };
    const merged = mergeStoryboardIntoPlan(plan, fixture());
    expect(merged).not.toBeNull();
    const pages = (merged as any).pages as Array<Record<string, any>>;
    expect(pages[0]!.layoutVersion).toBe(2);
    expect(pages[0]!.materials).toEqual([{ url: "everroom-material://x" }]);
    expect(pages[0]!.points).toEqual(["a"]);
    expect(pages[0]!.copy.message).toBe("深圳：一座仍在生长的城市");
    expect(pages[1]!.composition).toBe("hero-data");
    expect(pages[1]!.neighbors).toHaveLength(2);
    expect(pages[1]!.neighbors[0].composition).toBe("immersive");
    expect(pages[1]!.budget.prose).toBe(60);
  });

  it("returns null when page counts differ", () => {
    const plan = { title: "x", pages: [{ title: "only one" }] };
    expect(mergeStoryboardIntoPlan(plan, fixture())).toBeNull();
  });

  it("whitelists plan pages for editor input", () => {
    const pages = editorPagesFromPlan({
      pages: [{ title: "x", points: ["p"], data: "d", materials: [{ url: "u" }], notes: "n", imagePrompt: "i" }],
    });
    expect(pages[0]).toMatchObject({ title: "x", points: ["p"], data: "d", notes: "n" });
    expect(pages[0]).not.toHaveProperty("materials");
    expect(pages[0]).not.toHaveProperty("imagePrompt");
  });
});


describe("dispatchEditorStoryboard", () => {
  it("splits a long draft into bounded batches and merges pages in order", async () => {
    const calls: EditorDraftPage[][] = [];
    const result = await dispatchEditorStoryboard({
      draftPages: drafts,
      batchSize: 2,
      buildInput: (pages) => ({ draftPages: pages }),
      dispatch: async (input) => {
        const pages = (input.draftPages as EditorDraftPage[]) ?? [];
        calls.push(pages);
        const start = drafts.findIndex((draft) => draft.title === pages[0]?.title);
        const board = fixture();
        return {
          status: "completed",
          result: { structuredOutput: { ...board, pages: board.pages.slice(start, start + pages.length) } },
        } as never;
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.storyboard?.pages).toHaveLength(drafts.length);
    expect(result.storyboard?.pages.map((page) => page.role)).toEqual(fixture().pages.map((page) => page.role));
  });
});

describe("SlidesStoryboardStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the migration table and upserts by draft hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "nxcore-slides-storyboard-"));
    dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const store = new SlidesStoryboardStore(database.db);
    const board = fixture();
    const report = buildShadowReport(board, drafts);
    store.save({ roomId: "room-1", draftDocumentId: "doc-1", draftHash: "hash-1", storyboard: board, report });
    const found = store.byDraft("room-1", "doc-1");
    expect(found?.draftHash).toBe("hash-1");
    expect(found?.report.pageCount).toBe(3);
    store.save({ roomId: "room-1", draftDocumentId: "doc-1", draftHash: "hash-1", storyboard: board, report });
    expect(store.byDraftHash("room-1", "doc-1", "hash-1")?.draftHash).toBe("hash-1");
    expect(store.byDraft("room-1", "doc-1")?.report.pageCount).toBe(3);
  });
});
