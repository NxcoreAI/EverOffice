import type {
  WorkspaceActivity,
  WorkspaceActivityPage,
  WorkspaceActivityQuery,
  WorkspaceActivitySegment,
} from "@nxcore/agent-contract";
import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentEvents,
  agentMessages,
  agentRuns,
  agentSessions,
  agentWorkspaces,
  fileEntries,
  workspacePlanItemEvents,
  workspacePlanItems,
} from "../../infrastructure/database/schema.js";

/**
 * 工作空间「概览 · 动态」的派生读模型。
 *
 * 为什么是派生而不是一张 feed 表（`docs/design/product-data-map.zh-CN.md` §9、
 * `docs/workspace-overview-activity-plan.zh-CN.md` §5.1）：历史本来就在库里——
 * `agent_runs`（开始/结束时刻）、`file_entries`（产物与材料）、
 * `workspace_plan_item_events`（计划事件流，见 `schema.ts` 里那张表的注释）。
 * 再存一份 feed 必然与真实状态漂移，且改名/删除要双写。
 *
 * 契约（`WorkspaceActivity`）里文案是**分段**的：引用段只带 id，名字由渲染层实时解析，
 * 所以工作/文件改名后历史动态自动跟随。中文动词在服务层拼（渲染层只渲染）。
 */

export type WorkspaceActivityErrorCode = "workspace_not_found";

export class WorkspaceActivityError extends Error {
  readonly code: WorkspaceActivityErrorCode;

  constructor(code: WorkspaceActivityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WorkspaceActivityError";
    this.code = code;
  }
}

export interface WorkspaceActivityServiceOptions {
  db: GatewayDatabase;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 每个来源单次最多扫这么多行（runs 一次出两条事件，所以给 3 倍余量）。 */
const SCAN_FACTOR = 3;
const MAX_SCAN = 200;

/** 产物口径：与桌面 `artifactKind.ts`、产物页保持一致（agent-generated / artifact-imported）。 */
const ARTIFACT_SOURCE_KINDS = new Set(["agent-generated", "artifact-imported"]);

interface Candidate {
  activity: WorkspaceActivity;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** 时间倒序；同一毫秒按 id 倒序，保证游标稳定（不会漏也不会重）。 */
function compareDesc(left: Candidate, right: Candidate): number {
  const a = left.activity;
  const b = right.activity;
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 游标语义：严格早于 (beforeAt, beforeId)；beforeId 缺省时退化为纯时间比较。 */
function isStrictlyBefore(activity: WorkspaceActivity, beforeAt: string, beforeId: string | null): boolean {
  if (activity.at !== beforeAt) return activity.at < beforeAt;
  return beforeId !== null && activity.id < beforeId;
}

/**
 * 同 id 只留一条：取 `at` 最新的那条（同 `at` 时保留先出现的，结果确定）。
 * 事件 id 是稳定语义键，同一条语义可以有多个物理事件（审批卡重发等）。
 */
function dedupeLatestById(candidates: Candidate[]): Candidate[] {
  const latest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = latest.get(candidate.activity.id);
    if (!existing || candidate.activity.at > existing.activity.at) {
      latest.set(candidate.activity.id, candidate);
    }
  }
  return [...latest.values()];
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function workSegment(sessionId: string, text: string): WorkspaceActivitySegment[] {
  return [{ text }, { sessionId }];
}

/** brief 的长度上限：单行省略展示，超长截断（渲染层还有 CSS line-clamp 兜底）。 */
const BRIEF_MAX_CHARS = 120;

/**
 * 从 assistant 回复正文里提取「做了什么」的第一句。
 *
 * AI 回复常以 markdown 结构开头（`## 处理完成` 这类章节标题、列表记号、粗体），
 * 剥掉记号后的**标题残骸**（如「处理完成」「结果」）仍是噪声——首行若是纯标题，
 * 跳过它取下一段正文。判定标准：标题行很短（≤10 字）且下一行还有内容。
 * 没有任何正文时返回 null（渲染层不显示次级行，不会出现空行）。
 */
function briefOfAssistantReply(content: string | null | undefined): string | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const rawLine of lines) {
    const wasHeading = /^#{1,6}\s+/.test(rawLine);
    const line = rawLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (line) cleaned.push(wasHeading && line.length <= 10 ? "" : line);
  }
  const first = cleaned.find((line) => line);
  if (!first) return null;
  return first.length > BRIEF_MAX_CHARS ? `${first.slice(0, BRIEF_MAX_CHARS)}…` : first;
}

/** 结束 - 开始（秒，向上取整避免 0 秒）；缺任一时刻或倒挂返回 null。 */
function durationSeconds(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const seconds = Math.ceil((completedAt.getTime() - startedAt.getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

export class WorkspaceActivityService {
  private readonly db: GatewayDatabase;

  constructor(options: WorkspaceActivityServiceOptions) {
    this.db = options.db;
  }

  list(workspaceId: string, query: WorkspaceActivityQuery = {}): WorkspaceActivityPage {
    this.assertWorkspace(workspaceId);

    const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const scanLimit = Math.min(Math.max(limit * SCAN_FACTOR, 60), MAX_SCAN);
    const beforeAt = query.beforeAt?.trim() ? query.beforeAt.trim() : null;
    const beforeId = query.beforeId?.trim() ? query.beforeId.trim() : null;
    const parsedBefore = beforeAt ? new Date(beforeAt) : null;
    // 游标时间解析不了就只靠内存里的字符串比较（ISO 串可直接比），绝不因此丢整页。
    const beforeDate = parsedBefore && Number.isFinite(parsedBefore.getTime()) ? parsedBefore : null;

    const candidates = dedupeLatestById([
      ...this.runActivities(workspaceId, beforeDate, scanLimit),
      ...this.sessionActivities(workspaceId, beforeDate, scanLimit),
      ...this.fileActivities(workspaceId, beforeDate, scanLimit),
      ...this.planActivities(workspaceId, beforeDate, scanLimit),
      ...this.approvalActivities(workspaceId, beforeDate, scanLimit),
    ].filter((item) => (!beforeAt || isStrictlyBefore(item.activity, beforeAt, beforeId))))
      .sort(compareDesc);

    const items = candidates.slice(0, limit).map((item) => item.activity);
    const hasMore = candidates.length > items.length;
    const last = items[items.length - 1];
    return {
      items,
      // 有下一页才给游标：让前端不必判断「最后一页拿到的游标其实没数据」。
      nextBeforeAt: hasMore && last ? last.at : null,
      nextBeforeId: hasMore && last ? last.id : null,
    };
  }

  private assertWorkspace(workspaceId: string): void {
    const found = this.db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, workspaceId))
      .all();
    if (found.length === 0) throw new WorkspaceActivityError("workspace_not_found");
  }

  /**
   * **按会话聚合**：一个工作（会话）= 一行动态，不管跑过多少次 run。
   *
   * 演进史（信息密度）：
   * 1. 开始/结束各一行 → 一次 run 占两个时间轴位置，每行只有一句裸动词；
   * 2. 一次 run 一行 → 同一工作反复发消息时刷屏「结束了工作 X」× N，还是重复；
   * 3. 现在：同会话的 N 次 run 折叠为一行，`at` 取最近一次 run 的结束时刻（运行中取开始），
   *    `runCount` 带执行次数，`durationSec` 为累计耗时。verbs 按「现在还在跑吗」选。
   *
   * brief 不再复述用户 prompt（用户自己知道发了什么，回显毫无信息量），改为提取该会话
   * 最新一条 **assistant 回复** 的首行——AI 做完事的总结，回答的是「做了什么」。
   */
  private runActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [eq(agentSessions.workspaceId, workspaceId)];
    if (before) {
      // 用 <= 而不是 <：同一毫秒里可能有好几条，精确的「严格更早」由游标在内存里做。
      // 聚合行的 at = 最近一次 run 的 coalesce(completed, started, created)。
      filters.push(or(
        lte(agentRuns.completedAt, before),
        lte(agentRuns.startedAt, before),
        lte(agentRuns.createdAt, before),
      )!);
    }

    const rows = this.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        sessionId: agentRuns.sessionId,
        error: agentRuns.error,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .where(and(...filters))
      .orderBy(desc(sql`coalesce(${agentRuns.completedAt}, ${agentRuns.startedAt}, ${agentRuns.createdAt})`))
      .limit(scanLimit)
      .all();

    // 按会话分组（rows 已按时间倒序：每组第一条就是该会话最近一次 run）。
    const bySession = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = bySession.get(row.sessionId);
      if (bucket) bucket.push(row);
      else bySession.set(row.sessionId, [row]);
    }

    const out: Candidate[] = [];
    for (const [sessionId, runs] of bySession) {
      const latest = runs[0]!;
      const running = runs.some((run) => run.status === "accepted" || run.status === "running");
      const failed = !running && latest.status === "failed";
      const completedAt = toIso(latest.completedAt);
      const startedAt = toIso(latest.startedAt);

      // 累计耗时 = 每次已完成 run 的 (结束-开始) 之和；正在跑的不计（还没有结束时刻）。
      let durationSec = 0;
      let hasDuration = false;
      let latestError: string | null = null;
      for (const run of runs) {
        const seconds = durationSeconds(run.startedAt, run.completedAt);
        if (seconds !== null) {
          durationSec += seconds;
          hasDuration = true;
        }
        if (run.status === "failed" && run.error) latestError = run.error;
      }

      const brief = this.assistantBriefOf(sessionId);
      out.push({
        activity: {
          // id 用会话（工作）：聚合行的稳定键。旧行的 `run:<runId>` id 不再产生。
          id: `work:${sessionId}`,
          kind: running ? "work-run" : "work-done",
          actor: "agent",
          at: completedAt ?? startedAt ?? latest.createdAt.toISOString(),
          segments: workSegment(
            sessionId,
            running ? "正在执行 " : failed ? "执行失败 " : "完成了工作 ",
          ),
          detail: {
            ...(brief ? { brief } : {}),
            ...(hasDuration ? { durationSec } : {}),
            ...(failed && latestError ? { error: latestError } : {}),
            ...(runs.length > 1 ? { runCount: runs.length } : {}),
          },
          source: { table: "agent_runs", rowId: latest.id },
        },
      });
    }
    return out;
  }

  /**
   * 会话最新一条 assistant 回复的首行（“做了什么”的 AI 总结）。
   *
   * `displayContent` 是批注消息的气泡正文，普通消息为 null 回退 content——
   * 与聊天界面的展示口径一致（见 `toMessage`）。没有任何 assistant 正文时返回 null。
   */
  private assistantBriefOf(sessionId: string): string | null {
    const rows = this.db
      .select({ displayContent: agentMessages.displayContent, content: agentMessages.content })
      .from(agentMessages)
      .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.role, "assistant")))
      .orderBy(desc(agentMessages.createdAt))
      .limit(3)
      .all();
    for (const row of rows) {
      const brief = briefOfAssistantReply(row.displayContent ?? row.content);
      if (brief) return brief;
    }
    return null;
  }

  /** 从没跑过 run 的会话 = 「新建了工作」（跑过的会话已被上面两行覆盖，不重复出）。 */
  private sessionActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(agentSessions.workspaceId, workspaceId),
      sql`not exists (select 1 from ${agentRuns} where ${agentRuns.sessionId} = ${agentSessions.id})`,
    ];
    if (before) filters.push(lte(agentSessions.createdAt, before));

    const rows = this.db
      .select({ id: agentSessions.id, createdAt: agentSessions.createdAt })
      .from(agentSessions)
      .where(and(...filters))
      .orderBy(desc(agentSessions.createdAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => ({
      activity: {
        id: `session:${row.id}`,
        kind: "work-created" as const,
        actor: "user" as const,
        at: row.createdAt.toISOString(),
        segments: workSegment(row.id, "新建了工作 "),
        source: { table: "agent_sessions" as const, rowId: row.id },
      },
    }));
  }

  /** 文件库条目：产物 → output，其余 → material（与产物页同一口径）。 */
  private fileActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(fileEntries.workspaceId, workspaceId),
      isNull(fileEntries.deletedAt),
      ne(fileEntries.state, "deleted"),
    ];
    if (before) filters.push(lte(fileEntries.updatedAt, before));

    const rows = this.db
      .select({
        id: fileEntries.id,
        sourceKind: fileEntries.sourceKind,
        updatedAt: fileEntries.updatedAt,
      })
      .from(fileEntries)
      .where(and(...filters))
      .orderBy(desc(fileEntries.updatedAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => {
      const artifact = ARTIFACT_SOURCE_KINDS.has(row.sourceKind);
      return {
        activity: {
          id: `file:${row.id}`,
          kind: (artifact ? "output" : "material") as WorkspaceActivity["kind"],
          actor: (artifact ? "agent" : "user") as WorkspaceActivity["actor"],
          at: row.updatedAt.toISOString(),
          segments: [
            { text: artifact ? "生成了 " : "添加了材料 " },
            { fileId: row.id },
          ],
          source: { table: "file_entries" as const, rowId: row.id },
        },
      };
    });
  }

  /** 计划事件流：摘要由 plan 模块写就，这里只补上「哪条任务」的引用段。 */
  private planActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [eq(workspacePlanItems.workspaceId, workspaceId)];
    if (before) filters.push(lte(workspacePlanItemEvents.createdAt, before));

    const rows = this.db
      .select({
        id: workspacePlanItemEvents.id,
        summary: workspacePlanItemEvents.summary,
        actorKind: workspacePlanItemEvents.actorKind,
        itemId: workspacePlanItemEvents.itemId,
        createdAt: workspacePlanItemEvents.createdAt,
      })
      .from(workspacePlanItemEvents)
      .innerJoin(workspacePlanItems, eq(workspacePlanItemEvents.itemId, workspacePlanItems.id))
      .where(and(...filters))
      .orderBy(desc(workspacePlanItemEvents.createdAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => ({
      activity: {
        id: `plan:${row.id}`,
        kind: "plan" as const,
        actor: row.actorKind,
        at: row.createdAt.toISOString(),
        segments: [{ planItemId: row.itemId }, { text: ` ${row.summary}` }],
        source: { table: "workspace_plan_item_events" as const, rowId: row.id },
      },
    }));
  }

  /**
   * 「等你确认」＝ 活状态，不是历史：本空间**仍在跑的 run** 里，有 `approval.requested`
   * 但还没有对应 `approval.resolved` 的那些审批卡（对话里那张等你点的卡片）。
   *
   * 所以这条不进任何 feed 表：卡片一被处理，`approval.resolved` 落地，行自动消失；
   * 点击引用回到该会话（卡片就在对话里）。id 用 `approval.<approvalId>`：同一张卡
   * 反复请求也只出一行。
   */
  private approvalActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(agentSessions.workspaceId, workspaceId),
      inArray(agentEvents.type, ["approval.requested", "approval.resolved"]),
      // run 结束（完成/失败/取消/中断）后卡片就不再有效，历史里不留「等你确认」。
      inArray(agentRuns.status, ["accepted", "running"]),
    ];
    if (before) filters.push(lte(agentEvents.createdAt, before));

    const rows = this.db
      .select({
        id: agentEvents.id,
        sessionId: agentEvents.sessionId,
        runId: agentEvents.runId,
        type: agentEvents.type,
        payload: agentEvents.payload,
        createdAt: agentEvents.createdAt,
      })
      .from(agentEvents)
      .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
      .innerJoin(agentSessions, eq(agentEvents.sessionId, agentSessions.id))
      .where(and(...filters))
      .orderBy(desc(agentEvents.createdAt))
      .limit(scanLimit)
      .all();

    const resolved = new Set<string>();
    for (const row of rows) {
      if (row.type !== "approval.resolved") continue;
      const approvalId = readPayloadString(row.payload, "approvalId");
      if (approvalId) resolved.add(`${row.runId}:${approvalId}`);
    }

    const out: Candidate[] = [];
    for (const row of rows) {
      if (row.type !== "approval.requested") continue;
      const approvalId = readPayloadString(row.payload, "approvalId");
      if (!approvalId || resolved.has(`${row.runId}:${approvalId}`)) continue;
      const toolName = readPayloadString(row.payload, "toolName");
      out.push({
        activity: {
          // 同一张卡多次请求（重试）只出一行，位置按最新一次请求算。
          id: `approval:${row.runId}:${approvalId}`,
          kind: "work-review",
          actor: "agent",
          at: row.createdAt.toISOString(),
          segments: [
            { text: "等你确认 " },
            { sessionId: row.sessionId },
            ...(toolName ? [{ text: ` · ${toolName}` }] : []),
          ],
          source: { table: "agent_events", rowId: row.id },
        },
      });
    }
    return out;
  }

}
