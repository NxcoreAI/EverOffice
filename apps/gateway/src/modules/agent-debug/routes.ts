import type {
  AgentDebugAgent,
  AgentDebugRunEvents,
  AgentDebugSnapshot,
  AgentStatusSnapshot,
} from "@nxcore/agent-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentResolver } from "../agent/resolver.js";
import type { AgentDebugTraceStore } from "./trace-store.js";

const SnapshotQuery = Type.Object({
  runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
});

const RunParams = Type.Object({
  runId: Type.String({ minLength: 1, maxLength: 200 }),
});

const RunEventsQuery = Type.Object({
  afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000 })),
});

const ERROR_RUN_STATUSES = new Set(["failed", "interrupted", "timed_out"]);

/** main gateway: AgentStatusService.snapshot() → 调试页 Agent 目录。 */
export function debugAgentsFromStatusSnapshot(snapshot: AgentStatusSnapshot): AgentDebugAgent[] {
  return snapshot.agents.map((agent) => ({
    id: agent.agentId,
    name: agent.name,
    description: agent.description,
    kind: agent.kind,
    state: agent.state,
    activeRunCount: agent.activeRunCount,
    lastRunAt: agent.lastRun?.completedAt ?? agent.lastRun?.startedAt ?? agent.updatedAt ?? null,
  }));
}

/** cursor-completion gateway（无 status service）：从 resolver 定义 + activity 推导。 */
export function debugAgentsFromResolver(resolver: AgentResolver): AgentDebugAgent[] {
  return resolver.list().map((definition) => {
    const activity = resolver.getActivity(definition.id);
    const lastRun = activity.lastRun;
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      state: activity.activeRuns.length > 0
        ? "running"
        : lastRun && ERROR_RUN_STATUSES.has(lastRun.status) ? "error" : "idle",
      activeRunCount: activity.activeRuns.length,
      lastRunAt: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
    } satisfies AgentDebugAgent;
  });
}

/** 以调用方 catalog 为准，追加 store 观测到但不在 catalog 里的 Agent（本机 CLI Agent）。 */
export function mergeDebugAgents(
  catalog: AgentDebugAgent[],
  observed: AgentDebugAgent[],
): AgentDebugAgent[] {
  const merged = [...catalog];
  const ids = new Set(catalog.map((agent) => agent.id));
  for (const agent of observed) {
    if (ids.has(agent.id)) continue;
    ids.add(agent.id);
    merged.push(agent);
  }
  return merged;
}

/**
 * Agent 调试页只读 HTTP API。
 *
 * - `catalog` 由调用方注入（主网关走 AgentStatusService，补全网关走 resolver）；
 * - 缓冲里观测到的本机 Agent 会自动合并进 `agents`（按 id 去重）；
 * - 增量事件默认返回 `seq > afterSeq`，尾部仍在增长的合并 delta 事件会额外
 *   重复返回一条（客户端按 seq upsert）。
 */
export function agentDebugRoutes(
  store: AgentDebugTraceStore,
  catalog: () => AgentDebugAgent[],
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent-debug/snapshot",
      { schema: { tags: ["agent-debug"], querystring: SnapshotQuery } },
      async (request): Promise<AgentDebugSnapshot> => {
        const runs = request.query.runs ?? 150;
        return {
          generatedAt: new Date().toISOString(),
          agents: mergeDebugAgents(catalog(), store.listObservedAgents()),
          runs: store.listRuns(runs),
          droppedRuns: store.droppedRuns,
        };
      },
    );

    app.get(
      "/v1/agent-debug/runs/:runId/events",
      { schema: { tags: ["agent-debug"], params: RunParams, querystring: RunEventsQuery } },
      async (request, reply): Promise<AgentDebugRunEvents | undefined> => {
        const run = store.getRun(request.params.runId);
        if (!run) {
          return reply.code(404).send({ error: "not_found", message: "Agent debug run not found" });
        }
        const page = store.listEvents(
          request.params.runId,
          request.query.afterSeq ?? 0,
          request.query.limit ?? 1_000,
        );
        if (!page) {
          return reply.code(404).send({ error: "not_found", message: "Agent debug run not found" });
        }
        return { run, events: page.events, latestSeq: page.latestSeq };
      },
    );
  };
}
