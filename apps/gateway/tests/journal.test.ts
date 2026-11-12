import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { journalEntries } from "../src/infrastructure/database/schema.js";
import type { MemoryHit } from "../src/modules/memory/hippo-adapter.js";
import {
  collectJournalSignals,
  dayWindow,
  fingerprintOf,
  memorySignalWeight,
} from "../src/modules/journal/collector.js";
import {
  buildJournalPrompt,
  composeJournal,
  parseJournalComposition,
  templateComposition,
} from "../src/modules/journal/composer.js";
import {
  buildSubmitToolSchema,
  createJournalSubmitTool,
  JOURNAL_SUBMIT_TOOL_NAME,
  runJournalSubmit,
} from "../src/modules/journal/agent.js";
import { JournalScheduler } from "../src/modules/journal/scheduler.js";
import { JournalService } from "../src/modules/journal/service.js";
import type { AgentRuntime, RuntimeRun } from "@nxcore/agent-runtime";

/**
 * 每日洞察（主页「今日洞察」）的验收：
 * - 采集：只认本地当天的记忆条目；同标签聚成一簇、权重排序稳定；
 * - 提炼：编造的 sourceIds 一律丢弃；模型不可用/解析失败走模板并标 `model: null`；
 * - 落盘：一天多版、指纹未变不重写、force 才重写；
 * - 调度：去抖合并、最小间隔、每日上限、单飞行补跑。
 */

const TIMEZONE = "Asia/Shanghai";

function hit(partial: Partial<MemoryHit> & { id: string; content: string; createdAt: string }): MemoryHit {
  return {
    tags: [],
    strength: 1,
    halfLifeDays: 365,
    retrievalCount: 0,
    score: 0,
    category: "fact",
    layer: "semantic",
    scope: null,
    confidence: "observed",
    ...partial,
  } as MemoryHit;
}

describe("collector", () => {
  // 2026-11-03 10:00 (+08:00)
  const now = new Date("2026-11-03T02:00:00.000Z");

  it("按本地时区切日：昨天 23:59 与今天 00:01 分属两天", () => {
    const { start, end } = dayWindow("2026-11-03", TIMEZONE);
    expect(start.toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-03T16:00:00.000Z");
  });

  it("只采当天条目，越界的丢掉", () => {
    const snapshot = collectJournalSignals({
      list: () => [
        hit({ id: "today", content: "今天写的", createdAt: "2026-11-02T16:05:00.000Z" }),
        hit({ id: "yesterday", content: "昨天写的", createdAt: "2026-11-02T15:59:00.000Z" }),
        hit({ id: "tomorrow", content: "明天的", createdAt: "2026-11-03T16:00:00.000Z" }),
      ],
      timezone: () => TIMEZONE,
      now: () => now,
    });
    expect(snapshot.date).toBe("2026-11-03");
    expect(snapshot.signals.map((signal) => signal.id)).toEqual(["memory:today"]);
    expect(snapshot.signalCount).toBe(1);
  });

  it("标签重合的条目聚成一簇，只出一条信号并记合并数", () => {
    const snapshot = collectJournalSignals({
      list: () => [
        hit({
          id: "a", content: "偏好结论先行", createdAt: "2026-11-03T01:00:00.000Z",
          category: "lesson", confidence: "verified", tags: ["偏好", "写作"],
        }),
        hit({
          id: "b", content: "偏好结构化表格", createdAt: "2026-11-03T01:30:00.000Z",
          tags: ["偏好", "写作"],
        }),
        hit({
          id: "c", content: "项目叫锥光", createdAt: "2026-11-03T01:40:00.000Z",
          tags: ["项目"],
        }),
      ],
      timezone: () => TIMEZONE,
      now: () => now,
    });
    expect(snapshot.signals).toHaveLength(2);
    expect(snapshot.signals[0]!.id).toBe("memory:a");
    expect(snapshot.signals[0]!.merged).toBe(1);
    expect(snapshot.signalCount).toBe(3);
  });

  it("权重：经验 > 事实、verified 加分、inferred 扣分、越新越高", () => {
    const window = dayWindow("2026-11-03", TIMEZONE);
    const early = new Date("2026-11-03T00:10:00.000Z");
    const late = new Date("2026-11-03T06:00:00.000Z");
    const lesson = memorySignalWeight({ category: "lesson", confidence: "verified", strength: 1 }, early, window);
    const fact = memorySignalWeight({ category: "fact", confidence: "observed", strength: 1 }, early, window);
    const inferred = memorySignalWeight({ category: "fact", confidence: "inferred", strength: 0.4 }, early, window);
    const fresh = memorySignalWeight({ category: "fact", confidence: "observed", strength: 1 }, late, window);
    expect(lesson).toBeGreaterThan(fact);
    expect(fact).toBeGreaterThan(inferred);
    expect(fresh).toBeGreaterThan(fact);
  });

  it("指纹只看条目集合，不看顺序", () => {
    expect(fingerprintOf("2026-11-03", ["b", "a"])).toBe(fingerprintOf("2026-11-03", ["a", "b"]));
    expect(fingerprintOf("2026-11-03", ["a"])).not.toBe(fingerprintOf("2026-11-04", ["a"]));
  });
});

describe("composer", () => {
  const signals = collectJournalSignals({
    list: () => [
      hit({
        id: "m1", content: "交付前端方案一律给结构化表格", tags: ["偏好"],
        category: "lesson", confidence: "verified", createdAt: "2026-11-03T01:00:00.000Z",
      }),
      hit({
        id: "m2", content: "当前项目主线是锥光的记忆上下文", tags: ["项目"],
        createdAt: "2026-11-03T02:00:00.000Z",
      }),
    ],
    timezone: () => TIMEZONE,
    now: () => new Date("2026-11-03T03:00:00.000Z"),
  }).signals;

  it("prompt 带上条目 id，并指引走提交工具而不是正文 JSON", () => {
    const prompt = buildJournalPrompt("2026-11-03", signals);
    expect(prompt).toContain("id=memory:m1");
    expect(prompt).toContain("id=memory:m2");
    expect(prompt).toContain("2026-11-03");
    expect(prompt).toContain(JOURNAL_SUBMIT_TOOL_NAME);
    expect(prompt).not.toContain("只输出 JSON");
  });

  it("编造的 sourceIds 被丢弃；有据可依的要点保留", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "记下两条偏好",
      summary: "你今天交代了表格偏好，还提到项目主线是锥光。",
      bullets: [
        { text: "前端方案给结构化表格", sourceIds: ["memory:m1"] },
        { text: "编出来的要点", sourceIds: ["memory:not-exist"] },
      ],
      actions: [
        { label: "编的", kind: "ask-agent", targetId: "memory:nope" },
        { label: "聊聊偏好", kind: "ask-agent", targetId: "memory:m1" },
        { label: "开文件", kind: "open-file", targetId: "memory:m1" },
      ],
    }), signals);

    expect(composition).not.toBeNull();
    expect(composition!.bullets).toHaveLength(1);
    expect(composition!.bullets[0]!.sourceIds).toEqual(["memory:m1"]);
    // 一期只放开 ask-agent，open-file 一律不认。
    expect(composition!.actions).toHaveLength(1);
    expect(composition!.actions[0]!.kind).toBe("ask-agent");
  });

  it("容忍代码块围栏与前后废话", () => {
    const composition = parseJournalComposition(
      "好的，这是结果：\n```json\n{\"headline\":\"今天记下两条\",\"summary\":\"你今天交代了两件事。\",\"bullets\":[{\"text\":\"表格偏好\",\"sourceIds\":[\"memory:m1\"]}],\"actions\":[]}\n```",
      signals,
    );
    expect(composition?.headline).toBe("今天记下两条");
  });

  it("要点全被丢掉时返回 null（交给模板兜底）", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "空的",
      summary: "没有依据的话。",
      bullets: [{ text: "编的", sourceIds: ["memory:ghost"] }],
      actions: [],
    }), signals);
    expect(composition).toBeNull();
  });

  it("模板兜底只陈述事实，不编动作", () => {
    const composition = templateComposition("2026-11-03", signals);
    expect(composition.headline).toContain("2");
    expect(composition.bullets).toHaveLength(2);
    expect(composition.actions).toEqual([]);
  });

  it("prompt 要求总结+建议（advice 字段与口吻约束）", () => {
    const prompt = buildJournalPrompt("2026-11-03", signals);
    expect(prompt).toContain("advice");
    expect(prompt).toContain("可执行建议");
    expect(prompt).toContain("总结今天工作状态与内容的变化");
  });

  it("提交 schema：sourceIds/targetId 的 enum 只含当次证据 id；上限与解析层一致", () => {
    const schema = buildSubmitToolSchema(signals);
    const bulletItems = (schema.properties as Record<string, any>).bullets.items as Record<string, any>;
    const sourceEnum = bulletItems.properties.sourceIds.items.enum;
    expect(sourceEnum).toEqual(["memory:m1", "memory:m2"]);
    expect((schema.properties as Record<string, any>).bullets.maxItems).toBe(3);

    const actionItems = (schema.properties as Record<string, any>).actions.items as Record<string, any>;
    expect(actionItems.properties.targetId.enum).toEqual(["memory:m1", "memory:m2"]);
    expect(actionItems.properties.kind.enum).toEqual(["ask-agent"]);

    // 换一组证据，enum 跟着换——schema 是按次编译的。
    const other = buildSubmitToolSchema([{ ...signals[0]!, id: "memory:zzz" }]);
    const otherEnum = ((other.properties as Record<string, any>).bullets.items as Record<string, any>)
      .properties.sourceIds.items.enum;
    expect(otherEnum).toEqual(["memory:zzz"]);
  });

  it("提交通道：begin 换 schema、捕获首次提交、take 复位", () => {
    const submit = createJournalSubmitTool();
    submit.begin(signals);
    expect(submit.tool.parameters).toMatchObject({
      properties: expect.any(Object),
    });
    expect(submit.take()).toBeUndefined();

    // 模拟 pi 的工具执行：params 即模型回填的结构化参数。
    void submit.tool.execute({} as never, {
      headline: "记下两条偏好",
      summary: "你今天交代了两件事。",
      bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }],
    });
    expect(submit.take()).toMatchObject({ headline: "记下两条偏好" });

    // 重复提交只记第一次；begin 后复位。
    void submit.tool.execute({} as never, { headline: "第二次" });
    expect((submit.take() as Record<string, unknown>).headline).toBe("记下两条偏好");
    submit.begin(signals);
    expect(submit.take()).toBeUndefined();
  });

  it("advice：清洗为最多 2 条、超长截断、空值丢弃", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "记下两条偏好",
      summary: "你今天交代了表格偏好，还提到项目主线。",
      bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }],
      advice: ["下次起草直接用结构化表格", "", null, "这条会超长".repeat(20), "第三条会被条数上限丢掉"],
      actions: [],
    }), signals);
    expect(composition!.advice).toHaveLength(2);
    expect(composition!.advice![0]).toBe("下次起草直接用结构化表格");
    expect(composition!.advice![1]!.endsWith("…")).toBe(true);
    expect(composition!.advice![1]!.length).toBeLessThanOrEqual(48);
  });

  it("模板兜底给出确定性建议：有经验 → 起草时用上；全是事实 → 固化偏好", () => {
    const withLesson = templateComposition("2026-11-03", signals); // m1 是 lesson
    expect(withLesson.advice?.[0]).toContain("起草");

    // hit 默认 category=fact：3 条事实 → 建议固化偏好。
    const factsComposition = templateComposition("2026-11-03", collectJournalSignals({
      list: () => [
        hit({ id: "f1", content: "项目主线是锥光", createdAt: "2026-11-03T01:00:00.000Z" }),
        hit({ id: "f2", content: "deadline 在周五", createdAt: "2026-11-03T01:30:00.000Z" }),
        hit({ id: "f3", content: "评审人有两位", createdAt: "2026-11-03T02:00:00.000Z" }),
      ],
      timezone: () => TIMEZONE,
      now: () => new Date("2026-11-03T03:00:00.000Z"),
    }).signals);
    expect(factsComposition.advice?.[0]).toContain("偏好");
  });
});

describe("runJournalSubmit（提交型提炼）", () => {
  /** 极简 runtime 桩：记录 prompt，按脚本触发工具回调与正文。 */
  function stubRuntime(script: {
    callTool?: boolean;
    toolParams?: unknown;
    content?: string;
    fail?: Error;
    promptSink?: (prompt: string) => void;
  }): AgentRuntime {
    const events = new EventQueueStub();
    return {
      id: "stub",
      getCapabilities: async () => ({ streaming: false, reasoning: false, tools: true, steering: false, resume: false }),
      start: async (input: { prompt: string }) => {
        script.promptSink?.(input.prompt);
        // 异步执行脚本，模拟真实 runtime 的事件流。
        queueMicrotask(() => {
          if (script.fail) {
            events.fail(script.fail);
            return;
          }
          if (script.callTool) {
            events.emitToolCall();
          }
          events.complete(script.content ?? "");
        });
        return events.run();
      },
      resume: async () => { throw new Error("no resume"); },
      sendInput: async () => {},
      cancel: async () => {},
      deleteSession: async () => {},
      dispose: async () => {},
    } as unknown as AgentRuntime;
  }

  class EventQueueStub {
    private handlers: Array<() => void> = [];
    run(): RuntimeRun {
      return { runId: "r", runtimeSessionRef: "s", events: this.stream() } as RuntimeRun;
    }
    private stream() {
      const queue = this;
      return (async function* () {
        yield { type: "run.started", payload: {} };
        for await (const item of queue.drain()) yield item;
      })();
    }
    private items: Array<{ type: string; payload: Record<string, unknown> }> = [];
    private failed: Error | null = null;
    emitToolCall() {
      // 触发提交工具的 execute：真实链路里由 pi 调用，这里手动驱动。
      this.items.push({ type: "message.completed", payload: { role: "assistant", content: "" } });
    }
    complete(content: string) {
      this.items.push({ type: "message.completed", payload: { role: "assistant", content } });
    }
    fail(error: Error) {
      this.failed = error;
    }
    private async *drain() {
      // 简化：一次性吐完。失败时吐 run.failed。
      if (this.failed) {
        yield { type: "run.failed", payload: { message: this.failed.message } };
        return;
      }
      for (const item of this.items) yield item;
      yield { type: "run.completed", payload: {} };
    }
  }

  const twoSignals = collectJournalSignals({
    list: () => [
      hit({ id: "m1", content: "交付前端方案一律给结构化表格", tags: ["偏好"], category: "lesson", confidence: "verified", createdAt: "2026-11-03T01:00:00.000Z" }),
      hit({ id: "m2", content: "当前项目主线是锥光的记忆上下文", tags: ["项目"], createdAt: "2026-11-03T02:00:00.000Z" }),
    ],
    timezone: () => TIMEZONE,
    now: () => new Date("2026-11-03T03:00:00.000Z"),
  }).signals;

  it("工具参数提交：结构化对象直接成稿", async () => {
    const submit = createJournalSubmitTool();
    let prompt = "";
    const runtime = stubRuntime({ promptSink: (p) => { prompt = p; } });
    // 直接驱动：stub 的 start 里不真调 execute，这里手动模拟 pi 行为——
    // 在 runJournalSubmit 之前不能调（begin 会复位），所以用事件钩子。
    const realBegin = submit.begin.bind(submit);
    submit.begin = (signals) => {
      realBegin(signals);
      // run 启动后（schema 已换）触发工具调用。
      queueMicrotask(() => {
        void submit.tool.execute({} as never, {
          headline: "记下两条偏好",
          summary: "你今天交代了表格偏好，还提到项目主线是锥光。",
          bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }, { text: "项目主线", sourceIds: ["memory:m2"] }],
          advice: ["下次起草直接用结构化表格"],
          actions: [{ label: "聊聊偏好", kind: "ask-agent", targetId: "memory:m1" }],
        });
      });
    };
    const outcome = await runJournalSubmit(runtime, submit, { date: "2026-11-03", signals: twoSignals });
    expect(prompt).toContain(JOURNAL_SUBMIT_TOOL_NAME);
    expect(outcome).not.toBeNull();
    expect(outcome!.composition.headline).toBe("记下两条偏好");
    expect(outcome!.composition.bullets).toHaveLength(2);
    expect(outcome!.composition.actions![0]!.targetId).toBe("memory:m1");
  });

  it("没调工具、正文是 JSON → 文本降级路径成稿", async () => {
    const submit = createJournalSubmitTool();
    const runtime = stubRuntime({
      content: "前置废话\n" + JSON.stringify({
        headline: "今天记下两条",
        summary: "你今天交代了两件事。",
        bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }],
      }),
    });
    const outcome = await runJournalSubmit(runtime, submit, { date: "2026-11-03", signals: twoSignals });
    expect(outcome?.composition.headline).toBe("今天记下两条");
  });

  it("没调工具、正文也不是 JSON → null（模板兜底）", async () => {
    const submit = createJournalSubmitTool();
    const runtime = stubRuntime({ content: "我今天就直接说说：没什么好总结的。" });
    const outcome = await runJournalSubmit(runtime, submit, { date: "2026-11-03", signals: twoSignals });
    expect(outcome).toBeNull();
  });

  it("run 失败但已捕获提交 → 抢救成稿（后续失败不作废已交稿）", async () => {
    const submit = createJournalSubmitTool();
    const runtime = stubRuntime({ fail: new Error("tool limit exceeded") });
    const realBegin = submit.begin.bind(submit);
    submit.begin = (signals) => {
      realBegin(signals);
      queueMicrotask(() => {
        void submit.tool.execute({} as never, {
          headline: "抢救的稿",
          summary: "你今天交代了两件事。",
          bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }],
        });
      });
    };
    const outcome = await runJournalSubmit(runtime, submit, { date: "2026-11-03", signals: twoSignals });
    expect(outcome?.composition.headline).toBe("抢救的稿");
  });

  it("run 失败且无提交 → 错误上抛（composeJournal 分类）", async () => {
    const submit = createJournalSubmitTool();
    const runtime = stubRuntime({ fail: new Error("upstream 500") });
    await expect(
      runJournalSubmit(runtime, submit, { date: "2026-11-03", signals: twoSignals }),
    ).rejects.toThrow("upstream 500");
  });
});

describe("composeJournal（提交型编排 + 兜底）", () => {
  const twoSignals = [
    {
      id: "memory:m1", kind: "memory" as const, at: "2026-11-03T01:00:00.000Z",
      title: "交付前端方案一律给结构化表格", excerpt: "交付前端方案一律给结构化表格",
      weight: 0.9, merged: 0, category: "lesson" as const, confidence: "verified" as const,
    },
  ];

  it("提交成功 → 用提交稿并标注模型", async () => {
    const result = await composeJournal(
      { date: "2026-11-03", signals: twoSignals },
      {
        submit: async () => ({
          composition: {
            headline: "记下偏好", summary: "你今天交代了表格偏好。",
            bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }], actions: [],
          },
          model: "journal-submit",
        }),
      },
    );
    expect(result.model).toBe("journal-submit");
    expect(result.composition.headline).toBe("记下偏好");
  });

  it("submit 返回 null（没调工具/校验不过）→ 模板兜底、model=null", async () => {
    const result = await composeJournal(
      { date: "2026-11-03", signals: twoSignals },
      { submit: async () => null },
    );
    expect(result.model).toBeNull();
    expect(result.composition.bullets.length).toBeGreaterThan(0);
    expect(result.composition.actions).toEqual([]);
  });

  it("submit 抛错 → 模板兜底；档位未就绪只记 warn 不算失败", async () => {
    const events: string[] = [];
    const unavailable = { code: "memory_model_unavailable" };
    const result = await composeJournal(
      { date: "2026-11-03", signals: twoSignals },
      {
        submit: async () => { throw unavailable; },
        isModelUnavailable: () => true,
        logger: (level) => { events.push(level); },
      },
    );
    expect(result.model).toBeNull();
    expect(events).toEqual(["warn"]);
  });

  it("没有信号 → 直接模板（不调用 submit）", async () => {
    let called = 0;
    const result = await composeJournal(
      { date: "2026-11-03", signals: [] },
      { submit: async () => { called += 1; return null; } },
    );
    expect(called).toBe(0);
    expect(result.model).toBeNull();
  });
});

describe("JournalService", () => {
  let dataDir: string;
  let database: DatabaseClient;
  let composeCalls: number;
  let signals: MemoryHit[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "nxcore-journal-"));
    database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    composeCalls = 0;
    signals = [];
  });

  afterEach(() => {
    database.sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function service(now = new Date("2026-11-03T03:00:00.000Z")) {
    return new JournalService({
      db: database.db,
      list: () => signals,
      compose: async (input) => {
        composeCalls += 1;
        return {
          composition: templateComposition(input.date, input.signals),
          model: "fake-model",
        };
      },
      timezone: () => TIMEZONE,
      now: () => now,
    });
  }

  it("没有信号时只记指纹，不写条目", async () => {
    const journal = service();
    const result = await journal.generate("memory");
    expect(result.generated).toBe(false);
    expect(result.skipped).toBe("no-signals");
    expect(result.view.entry).toBeNull();
    expect(result.view.status).toBe("pending");
    expect(composeCalls).toBe(0);
    expect(database.db.select().from(journalEntries).all()).toHaveLength(0);
  });

  it("有信号写一版；指纹未变不重写；force 才再写一版", async () => {
    signals = [hit({ id: "m1", content: "今天记下的事", createdAt: "2026-11-03T02:30:00.000Z" })];
    const journal = service();

    const first = await journal.generate("memory");
    expect(first.generated).toBe(true);
    expect(first.view.entry?.version).toBe(1);
    expect(first.view.entry?.model).toBe("fake-model");
    expect(first.view.signalCount).toBe(1);

    const again = await journal.generate("memory");
    expect(again.generated).toBe(false);
    expect(again.skipped).toBe("unchanged");
    expect(composeCalls).toBe(1);

    const forced = await journal.generate("manual", { force: true });
    expect(forced.generated).toBe(true);
    expect(forced.view.entry?.version).toBe(2);
    expect(composeCalls).toBe(2);
  });

  it("新证据来了指纹就变，自动写新版（同一天多版）", async () => {
    const journal = service();
    signals = [hit({ id: "m1", content: "第一条", createdAt: "2026-11-03T02:00:00.000Z" })];
    await journal.generate("memory");

    signals = [
      ...signals,
      hit({ id: "m2", content: "第二条", createdAt: "2026-11-03T02:50:00.000Z" }),
    ];
    const result = await journal.generate("memory");
    expect(result.generated).toBe(true);
    expect(result.view.entry?.version).toBe(2);
    expect(result.view.signalCount).toBe(2);
  });

  it("写稿抛错时记失败态，且不覆盖已有版本", async () => {
    signals = [hit({ id: "m1", content: "第一条", createdAt: "2026-11-03T02:00:00.000Z" })];
    const journal = new JournalService({
      db: database.db,
      list: () => signals,
      compose: async () => {
        throw new Error("boom");
      },
      timezone: () => TIMEZONE,
      now: () => new Date("2026-11-03T03:00:00.000Z"),
    });

    const result = await journal.generate("boot");
    expect(result.skipped).toBe("failed");
    expect(result.view.status).toBe("failed");
    expect(result.view.lastError).toContain("boom");
    expect(result.view.entry).toBeNull();
  });
});

describe("JournalScheduler", () => {
  function stubService(overrides: { versions?: number } = {}) {
    const generate = vi.fn(async () => ({
      view: {
        date: "2026-11-03",
        entry: { version: overrides.versions ?? 0 } as never,
        status: "ready" as const,
        signalCount: 1,
        lastError: null,
      },
      generated: true,
      skipped: null,
    }));
    return {
      generate,
      today: () => ({
        date: "2026-11-03",
        // 上限判定读的是「当天已有第几版」，所以 today 必须如实反映版本数。
        entry: (overrides.versions ?? 0) > 0 ? ({ version: overrides.versions } as never) : null,
        status: "pending" as const,
        signalCount: 0,
        lastError: null,
      }),
    };
  }

  it("去抖：连续信号只算一次", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService();
      const scheduler = new JournalScheduler({ service: service as never, debounceMs: 45_000 });
      scheduler.noteSignal("memory");
      vi.advanceTimersByTime(20_000);
      scheduler.noteSignal("memory");
      vi.advanceTimersByTime(44_000);
      expect(service.generate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(service.generate).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("最小间隔：间隔内不动手，到点补一次", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService();
      const scheduler = new JournalScheduler({
        service: service as never,
        debounceMs: 0,
        minIntervalMs: 5 * 60_000,
      });
      await scheduler.requestRun("boot");
      expect(service.generate).toHaveBeenCalledTimes(1);

      await scheduler.requestRun("memory");
      expect(service.generate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(service.generate).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("每日上限：超过上限不再自动生成，手动仍可", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService({ versions: 24 });
      const scheduler = new JournalScheduler({ service: service as never, minIntervalMs: 0, dailyCap: 24 });
      const result = await scheduler.requestRun("memory");
      expect(result.generated).toBe(false);
      expect(service.generate).not.toHaveBeenCalled();

      await scheduler.requestRun("manual", { force: true });
      expect(service.generate).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
