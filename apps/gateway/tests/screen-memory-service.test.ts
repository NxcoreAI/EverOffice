import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { screenIntervals } from "../src/infrastructure/database/schema.js";
import {
  ScreenMemoryService,
  buildSummaryPrompt,
  parseSummaryResponse,
  type ScreenIntervalInput,
} from "../src/modules/screen-memory/service.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "screen-memory-"));
  dirs.push(dir);
  const { db } = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  return new ScreenMemoryService(db, logger);
}

function intervalPayload(overrides: Partial<ScreenIntervalInput> = {}): ScreenIntervalInput {
  return {
    bundleId: "com.apple.Safari",
    appName: "Safari",
    windowTitle: "PRD 评审",
    title: "PRD 评审",
    startedAt: "2026-10-12T14:00:00.000Z",
    endedAt: "2026-10-12T14:12:00.000Z",
    endReason: "app-switch",
    textLines: ["本地屏幕记忆方案评审", "OCR 采用 Vision 方案"],
    keyframes: [
      {
        capturedAt: "2026-10-12T14:00:05.000Z",
        imagePath: "/users/x/screen-memory/images/2026-10/SM-a.jpg",
        imageBytes: 120_000,
        perceptualHash: "00ff00ff00ff00ff",
        width: 2560,
        height: 1440,
        lineCount: 2,
        elapsedMs: 700,
      },
      {
        capturedAt: "2026-10-12T14:05:00.000Z",
        imagePath: "/users/x/screen-memory/images/2026-10/SM-b.jpg",
        imageBytes: 130_000,
        perceptualHash: "00ff00ff00ff00f0",
        width: 2560,
        height: 1440,
        lineCount: 3,
        elapsedMs: 650,
      },
    ],
    ...overrides,
  };
}

describe("ScreenMemoryService", () => {
  it("保存后可按 id 取回完整区间，关键帧保留原始时刻", async () => {
    const service = await setup();
    const { id } = await service.saveInterval(intervalPayload());
    const interval = await service.getInterval(id);
    expect(interval?.title).toBe("PRD 评审");
    expect(interval?.keyframes).toHaveLength(2);
    expect(interval?.keyframes?.[0]?.capturedAt).toBe("2026-10-12T14:00:05.000Z");
    expect(interval?.summaryStatus).toBe("pending");
  });

  it("同 id 重复投递幂等", async () => {
    const service = await setup();
    const payload = intervalPayload({ id: "fixed-interval-id-0001" });
    await service.saveInterval(payload);
    await service.saveInterval(payload);
    const { total } = await service.listIntervals({ limit: 10, offset: 0 });
    expect(total).toBe(1);
  });

  it("列表按时间过滤与总数正确", async () => {
    const service = await setup();
    await service.saveInterval(intervalPayload());
    await service.saveInterval(intervalPayload({
      bundleId: "com.apple.Terminal",
      startedAt: "2026-10-13T09:00:00.000Z",
      endedAt: "2026-10-13T09:30:00.000Z",
    }));
    const all = await service.listIntervals({ limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items[0]?.startedAt).toBe("2026-10-13T09:00:00.000Z");
    const filtered = await service.listIntervals({
      bundleId: "com.apple.Safari",
      limit: 10,
      offset: 0,
    });
    expect(filtered.total).toBe(1);
    const range = await service.listIntervals({
      from: new Date("2026-10-13T00:00:00.000Z"),
      to: new Date("2026-10-14T00:00:00.000Z"),
      limit: 10,
      offset: 0,
    });
    expect(range.total).toBe(1);
    expect(range.items[0]?.bundleId).toBe("com.apple.Terminal");
  });

  it("中文子串检索命中文本与标题", async () => {
    const service = await setup();
    await service.saveInterval(intervalPayload());
    await service.saveInterval(intervalPayload({
      title: "终端调试",
      textLines: ["npm run dev"],
      bundleId: "com.apple.Terminal",
      startedAt: "2026-10-13T09:00:00.000Z",
      endedAt: "2026-10-13T09:30:00.000Z",
    }));
    const byText = await service.searchIntervals({ q: "Vision 方案", limit: 10 });
    expect(byText.items).toHaveLength(1);
    expect(byText.items[0]?.bundleId).toBe("com.apple.Safari");
    const byTitle = await service.searchIntervals({ q: "终端调试", limit: 10 });
    expect(byTitle.items[0]?.bundleId).toBe("com.apple.Terminal");
  });

  it("纠正更新文本并标记用户编辑", async () => {
    const service = await setup();
    const { id } = await service.saveInterval(intervalPayload());
    const updated = await service.updateInterval(id, { textLines: ["纠正后的行"], title: "纠正后的标题" });
    expect(updated?.userEdited).toBe(true);
    expect(updated?.textLines).toEqual(["纠正后的行"]);
    expect(updated?.title).toBe("纠正后的标题");
  });

  it("stats 统计区间、关键帧与待摘要数", async () => {
    const service = await setup();
    await service.saveInterval(intervalPayload());
    const stats = await service.stats();
    expect(stats.intervals).toBe(1);
    expect(stats.keyframes).toBe(2);
    expect(stats.pendingSummaries).toBe(1);
  });
});


describe("摘要 worker", () => {
  it("prompt 包含应用与截断文本", () => {
    const prompt = buildSummaryPrompt({
      appName: "Safari",
      windowTitle: "评审文档",
      title: "评审文档",
      startedAt: new Date("2026-10-12T14:00:00.000Z"),
      endedAt: new Date("2026-10-12T14:20:00.000Z"),
      textLines: Array.from({ length: 200 }, (_, i) => `第${String(i)}行`),
    });
    expect(prompt).toContain("应用：Safari");
    expect(prompt).toContain("约 20 分钟");
    expect(prompt.length).toBeLessThan(4_500);
  });

  it("解析纯净 JSON 与包裹在文字中的 JSON", () => {
    expect(parseSummaryResponse('{"summary":"一句话","keyPoints":["a","b"]}')).toEqual({
      summary: "一句话",
      keyPoints: ["a", "b"],
    });
    expect(parseSummaryResponse('结果如下：\n{"summary":"摘要内容","keyPoints":[]} 请参考')).toEqual({
      summary: "摘要内容",
      keyPoints: [],
    });
    expect(() => parseSummaryResponse("没有任何 JSON")).toThrow(/unparsable/);
  });

  it("派发未允许或额度用尽时不认领；调用成功后置 ready 并计入当日", async () => {
    const dir = await mkdtemp(join(tmpdir(), "screen-memory-summary-"));
    dirs.push(dir);
    const { db } = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const resolver = {
      has: (id: string) => id === "main-lite",
      resolve: (id: string) => {
        if (id !== "main-lite") throw new Error("unexpected agent");
        return {
          start: async () => ({
            runtimeSessionRef: null,
            events: (async function* () {
              yield { type: "message.completed", payload: { content: '{"summary":"观察摘要","keyPoints":["要点一"]}' } };
            })(),
          }),
          deleteSession: async () => undefined,
          cancel: async () => undefined,
        };
      },
    };
    const service = new ScreenMemoryService(db, logger, resolver as never, 2);
    const first = await service.saveInterval(intervalPayload());
    await service.saveInterval(intervalPayload({ startedAt: "2026-10-13T09:00:00.000Z", endedAt: "2026-10-13T09:10:00.000Z" }));

    service.setSummaryDispatch(false);
    await service.processSummariesOnce();
    expect((await service.getInterval(first.id))?.summaryStatus).toBe("pending");

    service.setSummaryDispatch(true);
    await service.processSummariesOnce();
    const summarized = await service.getInterval(first.id);
    expect(summarized?.summaryStatus).toBe("ready");
    expect(summarized?.summary).toBe("观察摘要");
    expect(summarized?.summaryKeyPoints).toEqual(["要点一"]);

    await service.processSummariesOnce();
    const stats = await service.stats();
    expect(stats.summariesToday).toBe(2);
    expect(stats.dispatchAllowed).toBe(true);
  });

  it("LLM 失败置 waiting，五分钟后可重试回 pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "screen-memory-waiting-"));
    dirs.push(dir);
    const { db } = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    let attempts = 0;
    const resolver = {
      has: () => true,
      resolve: () => ({
        start: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("relay down");
          return {
            runtimeSessionRef: null,
            events: (async function* () {
              yield { type: "message.completed", payload: { content: '{"summary":"重试成功","keyPoints":[]}' } };
            })(),
          };
        },
        deleteSession: async () => undefined,
        cancel: async () => undefined,
      }),
    };
    const service = new ScreenMemoryService(db, logger, resolver as never);
    const { id } = await service.saveInterval(intervalPayload());
    service.setSummaryDispatch(true);
    await service.processSummariesOnce();
    expect((await service.getInterval(id))?.summaryStatus).toBe("waiting");
    db.update(screenIntervals)
      .set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(screenIntervals.id, id))
      .run();
    await service.processSummariesOnce();
    const retried = await service.getInterval(id);
    expect(retried?.summaryStatus).toBe("ready");
    expect(retried?.summary).toBe("重试成功");
  });
});
