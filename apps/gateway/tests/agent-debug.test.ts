import type {
  AgentDebugAgent,
  AgentDebugEvent,
  AgentDebugRun,
  AgentDebugRunEvents,
  AgentDebugSnapshot,
  LocalAgentInvocationTarget,
} from "@nxcore/agent-contract";
import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  RuntimeRun,
  StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auth } from "../src/server/auth.js";
import type { GatewayConfig, SubagentFrameworkConfig } from "../src/config.js";
import { AgentResolver } from "../src/modules/agent/resolver.js";
import { AgentDebugArchive } from "../src/modules/agent-debug/archive.js";
import {
  AgentDebugTraceStore,
  MAX_EVENTS_PER_RUN,
  MAX_EVENT_BYTES,
  MAX_RUNS,
} from "../src/modules/agent-debug/trace-store.js";
import { traceRuntime } from "../src/modules/agent-debug/instrument.js";
import {
  agentDebugRoutes,
  debugAgentsFromResolver,
  debugAgentsFromStatusSnapshot,
  mergeDebugAgents,
  type AgentDebugRoutesOptions,
} from "../src/modules/agent-debug/routes.js";
import { LocalAgentRuntimeRegistry } from "../src/modules/local-agents/runtime-registry.js";
import type { LoadedSubagentRevision } from "../src/modules/subagents/types.js";
import { SubagentRuntimeManager } from "../src/modules/subagents/runtime-manager.js";

/** 本机 CLI Agent（ACP）在单测里替换成 FakeAgentRuntime，只验证 trace 接线。 */
vi.mock("../src/modules/local-agents/acp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/local-agents/acp-runtime.js")>();
  return { ...actual, AcpAgentRuntime: FakeAgentRuntime };
});

const AUTH_TOKEN = "agent-debug-test-token-0123456789";
const DESCRIPTOR = { agentId: "main", agentName: "EverRoom", agentKind: "builtin" as const, description: "主 Agent" };

const stores: AgentDebugTraceStore[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function createStore(archive?: AgentDebugArchive): AgentDebugTraceStore {
  const store = new AgentDebugTraceStore(archive);
  stores.push(store);
  return store;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-debug-routes-"));
  tempDirs.push(dir);
  return dir;
}

function event(type: RuntimeEvent["type"], payload: unknown = {}): RuntimeEvent {
  return { type, payload };
}

function begin(store: AgentDebugTraceStore, runId: string, overrides: Partial<Parameters<AgentDebugTraceStore["beginRun"]>[0]> = {}): void {
  store.beginRun({
    runId,
    agentId: "main",
    agentName: "EverRoom",
    agentKind: "builtin",
    runtimeId: "pi:main",
    sessionId: "session-1",
    pageLabel: "Home",
    task: "hello",
    agentDescription: "主 Agent",
    ...overrides,
  });
}

function startInput(runId: string, overrides: Partial<StartRuntimeRunInput> = {}): StartRuntimeRunInput {
  return {
    runId,
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "hello",
    pageLabel: "Home",
    roomId: null,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const item of events) collected.push(item);
  return collected;
}

function scriptedRuntime(events: AsyncIterable<RuntimeEvent>, id = "scripted"): AgentRuntime {
  const start = async (input: StartRuntimeRunInput): Promise<RuntimeRun> => ({
    runId: input.runId,
    runtimeSessionRef: input.runtimeSessionRef ?? "stub-session",
    events,
  });
  return {
    id,
    getCapabilities: async () => ({ streaming: true, reasoning: true, tools: false, steering: false, resume: true }),
    start,
    resume: async (input: ResumeRuntimeRunInput) => start(input),
    sendInput: async () => undefined,
    cancel: async () => undefined,
    deleteSession: async () => undefined,
    dispose: async () => undefined,
  };
}

describe("AgentDebugTraceStore", () => {
  it("merges adjacent same-type deltas into one cumulative event with the same seq", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("reasoning.delta", { delta: "思考" }));
    store.recordEvent("run-1", event("reasoning.delta", { delta: "过程" }));
    store.recordEvent("run-1", event("message.delta", { delta: "你" }));
    store.recordEvent("run-1", event("message.delta", { delta: "好" }));

    const page = store.listEvents("run-1", 0)!;
    expect(page.events.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(page.events[0]).toMatchObject({ type: "reasoning.delta", payload: { delta: "思考过程" } });
    expect(page.events[1]).toMatchObject({ type: "message.delta", payload: { delta: "你好" } });
    expect(page.latestSeq).toBe(2);

    const run = store.getRun("run-1")!;
    expect(run.eventCount).toBe(2);
    expect(run.reasoningChars).toBe(4);
    expect(run.toolCallCount).toBe(0);
  });

  it("counts tool calls and stops merging when the delta type changes", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("reasoning.delta", { delta: "a" }));
    store.recordEvent("run-1", event("tool.started", { toolCallId: "t1", name: "read", args: {} }));
    store.recordEvent("run-1", event("tool.completed", { toolCallId: "t1", name: "read", result: {} }));
    store.recordEvent("run-1", event("reasoning.delta", { delta: "b" }));

    const run = store.getRun("run-1")!;
    expect(run.toolCallCount).toBe(1);
    expect(run.reasoningChars).toBe(2);
    expect(store.listEvents("run-1", 0)!.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
  });

  it("truncates oversized payloads and records the original serialized byte size", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("tool.completed", { text: "x".repeat(100_000) }));

    const [stored] = store.listEvents("run-1", 0)!.events;
    expect(stored?.truncatedBytes).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(typeof stored?.payload).toBe("string");
    expect((stored?.payload as string).length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  it("evicts oldest events beyond the per-run event cap and counts droppedEvents", () => {
    const store = createStore();
    begin(store, "run-1");
    for (let index = 0; index < MAX_EVENTS_PER_RUN + 5; index += 1) {
      store.recordEvent("run-1", event("context.updated", { index }));
    }

    const run = store.getRun("run-1")!;
    expect(run.eventCount).toBe(MAX_EVENTS_PER_RUN);
    expect(run.droppedEvents).toBe(5);
    expect(store.listEvents("run-1", 0, 1)!.events[0]?.seq).toBe(6);
    expect(store.listEvents("run-1", 0)!.latestSeq).toBe(MAX_EVENTS_PER_RUN + 5);
  });

  it("evicts oldest events when a single run exceeds its byte budget", () => {
    const store = createStore();
    begin(store, "run-1");
    for (let index = 0; index < 160; index += 1) {
      store.recordEvent("run-1", event("tool.updated", { index, text: "x".repeat(60_000) }));
    }

    const run = store.getRun("run-1")!;
    expect(run.droppedEvents).toBeGreaterThan(0);
    expect(run.eventCount).toBeLessThan(160);
  });

  it("caps total runs, evicting the oldest terminal run first", () => {
    const store = createStore();
    for (let index = 0; index < MAX_RUNS + 5; index += 1) {
      begin(store, `run-${index}`);
      store.finishRun(`run-${index}`, "completed");
    }

    expect(store.listRuns(1_000)).toHaveLength(MAX_RUNS);
    expect(store.droppedRuns).toBe(5);
    expect(store.getRun("run-0")).toBeNull();
    expect(store.getRun("run-4")).toBeNull();
    expect(store.getRun("run-5")).not.toBeNull();
    expect(store.getRun(`run-${MAX_RUNS + 4}`)).not.toBeNull();
  });

  it("lists running runs first, then terminal runs by startedAt desc", () => {
    const store = createStore();
    begin(store, "run-done");
    store.finishRun("run-done", "completed");
    begin(store, "run-running");
    begin(store, "run-running-local", { agentId: "codex:test", agentName: "Codex", agentKind: "local" });

    const runIds = store.listRuns(10).map(({ runId }) => runId);
    expect(runIds.at(-1)).toBe("run-done");
    expect(new Set(runIds.slice(0, 2))).toEqual(new Set(["run-running", "run-running-local"]));
  });

  it("writes terminal state once and keeps the first terminal status", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("run.completed"));
    const completedAt = store.getRun("run-1")!.completedAt;

    store.finishRun("run-1", "failed", "late failure");
    store.finishRun("run-1", "cancelled");
    const run = store.getRun("run-1")!;
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBe(completedAt);
    expect(run.errorMessage).toBeNull();
  });

  it("maps run.failed payload.message into errorMessage", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("run.failed", { message: "provider exploded" }));

    const run = store.getRun("run-1")!;
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toBe("provider exploded");
  });

  it("reopens a terminal run when resume reuses the same run id", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("run.interrupted"));
    expect(store.getRun("run-1")!.status).toBe("interrupted");

    // resume 复用 runId：保留事件，重新进入 running，后续终态仍可回写。
    begin(store, "run-1");
    const resumed = store.getRun("run-1")!;
    expect(resumed.status).toBe("running");
    expect(resumed.completedAt).toBeNull();
    expect(resumed.eventCount).toBe(1);

    store.recordEvent("run-1", event("run.completed"));
    expect(store.getRun("run-1")!.status).toBe("completed");
  });

  it("returns events after afterSeq and replays the growing tail delta event", () => {
    const store = createStore();
    begin(store, "run-1");
    store.recordEvent("run-1", event("message.delta", { delta: "a" }));
    store.recordEvent("run-1", event("message.delta", { delta: "b" }));
    store.recordEvent("run-1", event("tool.started", { toolCallId: "t1", name: "read", args: {} }));

    const first = store.listEvents("run-1", 0)!;
    expect(first.events.map(({ seq }) => seq)).toEqual([1, 2]);
    const incremental = store.listEvents("run-1", 1)!;
    expect(incremental.events.map(({ seq }) => seq)).toEqual([2]);
    expect(incremental.latestSeq).toBe(2);

    // 运行中的 delta 事件 seq 不变但内容继续增长：afterSeq 对齐后仍会带回尾部事件。
    store.recordEvent("run-1", event("message.delta", { delta: "c" }));
    const replayed = store.listEvents("run-1", 3)!;
    expect(replayed.events).toHaveLength(1);
    expect(replayed.events[0]).toMatchObject({ seq: 3, payload: { delta: "c" } });
    expect(replayed.latestSeq).toBe(3);
  });

  it("returns null for unknown runs and tolerates events for evicted runs", () => {
    const store = createStore();
    expect(store.getRun("missing")).toBeNull();
    expect(store.listEvents("missing", 0)).toBeNull();
    expect(() => store.recordEvent("missing", event("run.started"))).not.toThrow();
    expect(() => store.finishRun("missing", "failed")).not.toThrow();
  });

  it("reports agents observed in the buffer with running/error state", () => {
    const store = createStore();
    begin(store, "local-run-1", { agentId: "codex:/usr/bin/codex", agentName: "Codex", agentKind: "local", agentDescription: "CLI" });
    store.finishRun("local-run-1", "failed", "acp crashed");
    begin(store, "local-run-2", { agentId: "codex:/usr/bin/codex", agentName: "Codex", agentKind: "local" });

    const observed = store.listObservedAgents();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      id: "codex:/usr/bin/codex",
      name: "Codex",
      kind: "local",
      state: "running",
      activeRunCount: 1,
    });
    expect(observed[0]?.lastRunAt).not.toBeNull();
    expect(store.droppedRuns).toBe(0);
  });
});

describe("traceRuntime", () => {
  it("records a FakeAgentRuntime run end-to-end without changing the event stream", async () => {
    const store = createStore();
    const traced = traceRuntime(new FakeAgentRuntime(), store, DESCRIPTOR);
    const types: string[] = [];
    const events = await drain((await traced.start(startInput("run-fake"))).events);
    for (const item of events) types.push(item.type);

    const plain = await drain((await new FakeAgentRuntime().start(startInput("run-fake-plain"))).events);
    expect(types).toEqual(plain.map((item) => item.type));

    const run = store.getRun("run-fake")!;
    expect(run.status).toBe("completed");
    expect(run.agentId).toBe("main");
    expect(run.agentKind).toBe("builtin");
    expect(run.runtimeId).toBe("fake");
    expect(run.sessionId).toBe("session-1");
    expect(run.pageLabel).toBe("Home");
    expect(run.task).toBe("hello");
    expect(run.eventCount).toBeGreaterThan(0);
    expect(run.reasoningChars).toBeGreaterThan(0);

    const page = store.listEvents("run-fake", 0, 5_000)!;
    expect(page.events[0]?.type).toBe("run.started");
    expect(page.events.at(-1)?.type).toBe("run.completed");
    const deltas = page.events.filter(({ type }) => type === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(typeof (deltas[0]?.payload as { delta?: string }).delta).toBe("string");
  });

  it("records slides 逐页任务的页序（dispatch input 0 起 pageIndex → 调试页 1 起）", async () => {
    const store = createStore();
    const traced = traceRuntime(new FakeAgentRuntime(), store, {
      agentId: "slides-layouter",
      agentName: "Slides Layouter",
      agentKind: "developer",
    });
    await drain((await traced.start(startInput("run-slide-page", {
      runtimeMetadata: {
        subagentAgentId: "slides-layouter",
        subagentInput: { task: "layout", pageIndex: 2, totalPages: 12 },
      },
    }))).events);

    expect(store.getRun("run-slide-page")).toMatchObject({
      agentId: "slides-layouter",
      slidePageIndex: 3,
      slidePageCount: 12,
    });
  });

  it("非逐页 run 不写页序字段，非法 pageIndex 也被忽略", async () => {
    const store = createStore();
    const traced = traceRuntime(new FakeAgentRuntime(), store, DESCRIPTOR);
    await drain((await traced.start(startInput("run-no-page"))).events);
    await drain((await traced.start(startInput("run-bad-page", {
      runtimeMetadata: { subagentInput: { pageIndex: -1, totalPages: 12 } },
    }))).events);

    const plain = store.getRun("run-no-page")!;
    expect(plain.slidePageIndex).toBeUndefined();
    expect(plain.slidePageCount).toBeUndefined();
    const bad = store.getRun("run-bad-page")!;
    expect(bad.slidePageIndex).toBeUndefined();
    expect(bad.slidePageCount).toBeUndefined();
  });

  it("records terminal failure from an event stream error, keeps the exception and calls once", async () => {
    const store = createStore();
    const failing: AsyncIterable<RuntimeEvent> = {
      async *[Symbol.asyncIterator]() {
        yield event("run.started");
        throw new Error("stream exploded");
      },
    };
    const traced = traceRuntime(scriptedRuntime(failing), store, DESCRIPTOR);
    const run = await traced.start(startInput("run-error"));

    await expect(drain(run.events)).rejects.toThrow("stream exploded");
    const debugRun = store.getRun("run-error")!;
    expect(debugRun.status).toBe("failed");
    expect(debugRun.errorMessage).toBe("stream exploded");
  });

  it("marks a run failed when start() throws before any event", async () => {
    const store = createStore();
    const runtime = scriptedRuntime((async function* () {})());
    runtime.start = async () => {
      throw new Error("start exploded");
    };
    const traced = traceRuntime(runtime, store, DESCRIPTOR);

    await expect(traced.start(startInput("run-start-error"))).rejects.toThrow("start exploded");
    expect(store.getRun("run-start-error")).toMatchObject({
      status: "failed",
      errorMessage: "start exploded",
    });
  });

  it("finishes interrupted when the consumer stops iterating early", async () => {
    const store = createStore();
    const events: AsyncIterable<RuntimeEvent> = {
      async *[Symbol.asyncIterator]() {
        yield event("run.started");
        yield event("message.delta", { delta: "a" });
        yield event("message.delta", { delta: "b" });
      },
    };
    const traced = traceRuntime(scriptedRuntime(events), store, DESCRIPTOR);
    const run = await traced.start(startInput("run-broken"));

    for await (const _item of run.events) break;
    expect(store.getRun("run-broken")?.status).toBe("interrupted");
  });

  it("finishes interrupted when the stream ends without a terminal event", async () => {
    const store = createStore();
    const events: AsyncIterable<RuntimeEvent> = {
      async *[Symbol.asyncIterator]() {
        yield event("run.started");
      },
    };
    const traced = traceRuntime(scriptedRuntime(events), store, DESCRIPTOR);
    await drain((await traced.start(startInput("run-truncated"))).events);

    expect(store.getRun("run-truncated")?.status).toBe("interrupted");
  });

  it("wraps start and resume for the same run id without double recording", async () => {
    const store = createStore();
    const firstStore = createStore();
    const runtime = scriptedRuntime((async function* () {
      yield event("run.started");
      yield event("run.completed");
    })());
    const traced = traceRuntime(runtime, store, DESCRIPTOR);
    const again = traceRuntime(traced, firstStore, DESCRIPTOR);
    expect(again).toBe(traced);

    await drain((await traced.resume({ ...startInput("run-resume"), lastEventSeq: 0 })).events);
    expect(store.getRun("run-resume")?.status).toBe("completed");
    expect(firstStore.getRun("run-resume")).toBeNull();
  });
});

describe("agent debug wiring", () => {
  it("skips trace for developer definitions in AgentResolver, records builtin runs", async () => {
    const store = createStore();
    const resolver = new AgentResolver(store);
    resolver.register({
      id: "slides-planner",
      name: "Slides Planner",
      description: "子 Agent",
      configDirectory: "/tmp/slides-planner/config",
      kind: "developer",
    }, () => scriptedRuntime((async function* () {
      yield event("run.started");
      yield event("run.completed");
    })()));
    resolver.register({
      id: "main",
      name: "EverRoom",
      description: "主 Agent",
      configDirectory: "/tmp/main/config",
      kind: "builtin",
    }, () => new FakeAgentRuntime());

    await drain((await resolver.resolve("slides-planner").start(startInput("run-developer"))).events);
    expect(store.getRun("run-developer")).toBeNull();

    await drain((await resolver.resolve("main").start(startInput("run-builtin"))).events);
    expect(store.getRun("run-builtin")).toMatchObject({ agentId: "main", agentKind: "builtin" });
    await resolver.dispose();
  });

  it("traces dispatch-only subagent runtimes from SubagentRuntimeManager", async () => {
    const store = createStore();
    const manager = new SubagentRuntimeManager(
      { agentRuntime: "fake" } as GatewayConfig,
      {} as SubagentFrameworkConfig,
      undefined,
      store,
    );
    const revision = {
      id: "revision-1",
      manifest: {
        id: "slides-planner",
        name: "Slides Planner",
        description: "规划 PPT 结构",
      },
    } as unknown as LoadedSubagentRevision;
    const runtime = manager.acquire(revision);
    await drain((await runtime.start(startInput("run-subagent", { pageLabel: "Slides" }))).events);

    expect(store.getRun("run-subagent")).toMatchObject({
      agentId: "slides-planner",
      agentName: "Slides Planner",
      agentKind: "developer",
    });

    // 逐页 dispatch：orchestrator 放在 runtimeMetadata.subagentInput 的 0 起 pageIndex
    // 要穿透到调试 run（1 起页序），Agent 列表才能显示「负责哪一页」。
    await drain((await runtime.start(startInput("run-subagent-page", {
      pageLabel: "Slides",
      runtimeMetadata: { subagentAgentId: "slides-layouter", subagentInput: { pageIndex: 4, totalPages: 16 } },
    }))).events);
    expect(store.getRun("run-subagent-page")).toMatchObject({
      slidePageIndex: 5,
      slidePageCount: 16,
    });
    await manager.dispose();
  });

  it("traces local CLI agent runtimes from LocalAgentRuntimeRegistry", async () => {
    const store = createStore();
    const registry = new LocalAgentRuntimeRegistry(undefined, undefined, store);
    const target = {
      id: "codex:/usr/local/bin/codex",
      provider: "codex",
      displayName: "My Codex",
      executablePath: "/usr/local/bin/codex",
      workingDirectory: "/tmp/workspace",
      permissionProfile: "inspect",
      card: {
        name: "Codex",
        description: "本机 CLI",
        version: "1.0.0",
        supportedInterfaces: [],
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
      },
    } satisfies LocalAgentInvocationTarget;
    const runtime = registry.resolve(target);
    await drain((await runtime.start(startInput("run-local"))).events);

    expect(store.getRun("run-local")).toMatchObject({
      agentId: "codex:/usr/local/bin/codex",
      agentName: "My Codex",
      agentKind: "local",
    });
    await registry.dispose();
  });
});

describe("agent debug routes", () => {
  function catalog(): AgentDebugAgent[] {
    return [{
      id: "main",
      name: "EverRoom",
      description: "主 Agent",
      kind: "builtin",
      state: "idle",
      activeRunCount: 0,
      lastRunAt: null,
    }];
  }

  async function buildApp(store: AgentDebugTraceStore, options?: AgentDebugRoutesOptions) {
    const app = Fastify();
    await app.register(auth, { token: AUTH_TOKEN });
    await app.register(agentDebugRoutes(store, catalog, options));
    return app;
  }

  function archivedRun(runId: string, overrides: Partial<AgentDebugRun> = {}): AgentDebugRun {
    return {
      runId,
      agentId: "main",
      agentName: "EverRoom",
      agentKind: "builtin",
      runtimeId: "pi:main",
      sessionId: "session-history",
      pageLabel: "Home",
      task: "历史任务",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      eventCount: 3,
      droppedEvents: 0,
      toolCallCount: 0,
      reasoningChars: 0,
      lastEventAt: "2026-01-01T00:00:05.000Z",
      errorMessage: null,
      ...overrides,
    };
  }

  function archivedEvents(): AgentDebugEvent[] {
    return [
      { seq: 1, type: "run.started", occurredAt: "2026-01-01T00:00:00.000Z", payload: {} },
      { seq: 2, type: "message.delta", occurredAt: "2026-01-01T00:00:01.000Z", payload: { delta: "hi" } },
      { seq: 3, type: "run.completed", occurredAt: "2026-01-01T00:00:05.000Z", payload: {} },
    ];
  }

  async function seededArchive(): Promise<AgentDebugArchive> {
    const dir = await tempDir();
    // 固定 now 到归档时间之后一天，避免历史 run 被默认 7 天保留策略裁剪。
    const archive = new AgentDebugArchive({ dir, now: () => Date.parse("2026-01-02T00:00:00.000Z") });
    await archive.archiveRun(archivedRun("run-history"), archivedEvents());
    await archive.flush();
    return archive;
  }

  function headers(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  it("round-trips slide page fields through the disk archive", async () => {
    const dir = await tempDir();
    const archive = new AgentDebugArchive({ dir, now: () => Date.parse("2026-01-02T00:00:00.000Z") });
    await archive.archiveRun(archivedRun("run-archive-page", {
      agentId: "slides-layouter",
      agentName: "Slides Layouter",
      agentKind: "developer",
      slidePageIndex: 5,
      slidePageCount: 12,
    }), archivedEvents());
    await archive.flush();

    expect(archive.listRuns(10)[0]).toMatchObject({ slidePageIndex: 5, slidePageCount: 12 });
  });

  it("serves slide page fields on snapshot runs", async () => {
    const store = createStore();
    begin(store, "run-page", { slidePageIndex: 4, slidePageCount: 12 });
    const app = await buildApp(store);

    const body = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(body.runs.find(({ runId }) => runId === "run-page")).toMatchObject({
      slidePageIndex: 4,
      slidePageCount: 12,
    });
    await app.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp(createStore());
    const response = await app.inject({ method: "GET", url: "/v1/agent-debug/snapshot" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("serves snapshot with catalog agents merged with observed local agents", async () => {
    const store = createStore();
    begin(store, "run-main");
    store.recordEvent("run-main", event("run.completed"));
    begin(store, "run-local", { agentId: "codex:test", agentName: "Codex", agentKind: "local" });

    const app = await buildApp(store);
    const response = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot?runs=10",
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AgentDebugSnapshot;
    expect(body.agents.map(({ id }) => id)).toEqual(["main", "codex:test"]);
    expect(body.runs[0]).toMatchObject({ runId: "run-local", status: "running", agentKind: "local" });
    expect(body.runs.map(({ runId }) => runId)).toContain("run-main");
    expect(body.droppedRuns).toBe(0);
    await app.close();
  });

  it("deduplicates agents already present in the injected catalog", async () => {
    const store = createStore();
    begin(store, "run-main");
    const app = await buildApp(store);

    const body = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(body.agents.filter(({ id }) => id === "main")).toHaveLength(1);
    await app.close();
  });

  it("serves incremental run events and 404 for unknown runs", async () => {
    const store = createStore();
    begin(store, "run-main");
    store.recordEvent("run-main", event("run.started"));
    store.recordEvent("run-main", event("message.delta", { delta: "hi" }));
    store.recordEvent("run-main", event("run.completed"));

    const app = await buildApp(store);
    const full = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-main/events",
      headers: headers(),
    });
    expect(full.statusCode).toBe(200);
    const body = full.json() as AgentDebugRunEvents;
    expect(body.run).toMatchObject({ runId: "run-main", status: "completed" });
    expect(body.events.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(body.latestSeq).toBe(3);

    const incremental = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-main/events?afterSeq=1",
      headers: headers(),
    });
    expect((incremental.json() as AgentDebugRunEvents).events.map(({ seq }) => seq)).toEqual([2, 3]);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/missing/events",
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("supports archived=include|only|exclude with origin and archive info", async () => {
    const archive = await seededArchive();
    const store = createStore(archive);
    begin(store, "run-live");
    const app = await buildApp(store);

    const include = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(include.runs.map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-live", origin: "live" },
      { runId: "run-history", origin: "archive" },
    ]);
    expect(include.archive).toEqual(expect.objectContaining({
      enabled: true,
      retentionDays: 7,
      runCount: 1,
      oldestStartedAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(include.archive?.bytes).toBeGreaterThan(0);

    const only = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot?archived=only",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(only.runs.map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-history", origin: "archive" },
    ]);

    const exclude = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot?archived=exclude",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(exclude.runs.map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-live", origin: "live" },
    ]);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot?archived=bogus",
      headers: headers(),
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("serves archived run events with origin archive and keeps 404 for unknown runs", async () => {
    const archive = await seededArchive();
    const store = createStore(archive);
    const app = await buildApp(store);

    const full = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-history/events",
      headers: headers(),
    });
    expect(full.statusCode).toBe(200);
    const body = full.json() as AgentDebugRunEvents;
    expect(body.run).toMatchObject({ runId: "run-history", origin: "archive", status: "completed" });
    expect(body.events.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(body.latestSeq).toBe(3);

    const incremental = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-history/events?afterSeq=1&limit=1",
      headers: headers(),
    })).json() as AgentDebugRunEvents;
    expect(incremental.events.map(({ seq }) => seq)).toEqual([2]);
    expect(incremental.latestSeq).toBe(3);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/missing/events",
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("batch fills sessionTitle for live and archived runs in one lookup", async () => {
    const archive = await seededArchive();
    const store = createStore(archive);
    begin(store, "run-live", { sessionId: "session-live" });
    begin(store, "run-subagent", {
      sessionId: null,
      agentId: "slides-planner",
      agentName: "Slides Planner",
      agentKind: "developer",
    });
    const lookups: string[][] = [];
    const app = await buildApp(store, {
      sessionTitles: (sessionIds) => {
        lookups.push([...sessionIds]);
        return new Map([
          ["session-live", "本次对话"],
          ["session-history", "历史对话"],
        ]);
      },
    });

    const snapshot = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot",
      headers: headers(),
    })).json() as AgentDebugSnapshot;
    expect(lookups).toHaveLength(1);
    expect(new Set(lookups[0])).toEqual(new Set(["session-live", "session-history"]));
    const byRunId = new Map(snapshot.runs.map((run) => [run.runId, run]));
    expect(byRunId.get("run-live")?.sessionTitle).toBe("本次对话");
    expect(byRunId.get("run-history")?.sessionTitle).toBe("历史对话");
    expect(byRunId.get("run-subagent")?.sessionTitle).toBeNull();

    // events 路由同样补全会话标题（历史 run 来自归档）。
    const historyEvents = (await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-history/events",
      headers: headers(),
    })).json() as AgentDebugRunEvents;
    expect(historyEvents.run.sessionTitle).toBe("历史对话");
    await app.close();
  });

  it("validates query limits with typebox schemas", async () => {
    const app = await buildApp(createStore());
    const tooManyRuns = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/snapshot?runs=1000",
      headers: headers(),
    });
    expect(tooManyRuns.statusCode).toBe(400);

    const tooManyEvents = await app.inject({
      method: "GET",
      url: "/v1/agent-debug/runs/run-main/events?limit=6000",
      headers: headers(),
    });
    expect(tooManyEvents.statusCode).toBe(400);
    await app.close();
  });
});

describe("agent debug catalog helpers", () => {
  it("maps AgentStatusService snapshots and resolver definitions into debug agents", () => {
    const fromStatus = debugAgentsFromStatusSnapshot({
      generatedAt: "2026-01-01T00:00:00.000Z",
      summary: { total: 1, running: 0, idle: 1, error: 0 },
      agents: [{
        agentId: "main",
        name: "EverRoom",
        description: "主 Agent",
        kind: "builtin",
        state: "idle",
        activeRunCount: 0,
        workspace: { id: "agent://main", isolation: "dedicated", revisionId: null },
        currentRun: null,
        lastRun: {
          id: "run-1",
          task: "hello",
          pageLabel: "Home",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }],
    });
    expect(fromStatus).toEqual([{
      id: "main",
      name: "EverRoom",
      description: "主 Agent",
      kind: "builtin",
      state: "idle",
      activeRunCount: 0,
      lastRunAt: "2026-01-01T00:00:01.000Z",
    }]);

    const resolver = new AgentResolver();
    resolver.register({
      id: "cursor-completion",
      name: "Cursor Completion",
      description: "补全",
      configDirectory: "/tmp/cursor/config",
      kind: "builtin",
    }, () => new FakeAgentRuntime());
    expect(debugAgentsFromResolver(resolver)).toEqual([{
      id: "cursor-completion",
      name: "Cursor Completion",
      description: "补全",
      kind: "builtin",
      state: "idle",
      activeRunCount: 0,
      lastRunAt: null,
    }]);
  });

  it("merges observed agents without overriding the injected catalog", () => {
    const catalog = [{
      id: "main",
      name: "EverRoom（catalog）",
      description: "",
      kind: "builtin" as const,
      state: "idle" as const,
      activeRunCount: 0,
      lastRunAt: null,
    }];
    const merged = mergeDebugAgents(catalog, [
      { ...catalog[0]!, name: "EverRoom（observed）" },
      {
        id: "codex:test",
        name: "Codex",
        description: "",
        kind: "local",
        state: "running",
        activeRunCount: 1,
        lastRunAt: null,
      },
    ]);
    expect(merged.map(({ id }) => id)).toEqual(["main", "codex:test"]);
    expect(merged[0]?.name).toBe("EverRoom（catalog）");
  });
});
