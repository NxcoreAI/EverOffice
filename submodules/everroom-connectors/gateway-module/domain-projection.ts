import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  ConnectorJsonRecord,
  NormalizedAddress,
  NormalizedCalendarChange,
  NormalizedCalendarEvent,
  NormalizedMail,
  NormalizedMailChange,
} from "@nxcore/connector-contract";
import type { GatewayDatabase } from "./host-types.js";
import {
  connectorCalendarEvents,
  connectorEmails,
} from "../../../apps/gateway/src/infrastructure/database/schema.js";

/**
 * 域投影（connector-platform-refactor-plan 阶段一）：Nango 拉取路径的
 * NormalizedMail / NormalizedCalendarEvent 落主库 connector_* 域表——
 * 与 CLI 推送路径（connectors/service.ts upsertDomainRecord）同一套
 * 唯一键与幂等语义，"多引擎、一投影"。Room 读侧从此单轨查域表，
 * 不再回退解析 route_decisions.sourceMarkdown。
 *
 * 注意（M2 收敛点）：contentHash 的 stableJson 算法与 service.ts 内部
 * 实现一致；CLI 路径的 Record<string,unknown> 校验式投影暂不复用本模块
 * （输入形态不同），阶段二拆迁时统一。
 */
type ProjectionDatabase = Pick<GatewayDatabase, "select" | "insert" | "update" | "delete">;

export type DomainProjectionOutcome = "inserted" | "updated" | "unchanged" | "deleted" | "noop" | "skipped";
/** 投影结果：outcome + 域行 id（供后续 ingest 归属使用）。 */
export interface DomainProjectionResult { outcome: DomainProjectionOutcome; id: string | null; }

/**
 * id-only 空壳邮件（Graph delta 偶发只回 id：无主题/正文/收发时间）。
 * 这种行入库后 sentAt 为空，日记按 syncedAt 兜底取时间，全部滑进当天窗口。
 */
export function isEmptyMailShell(message: NormalizedMail): boolean {
  return !message.subject?.trim()
    && !message.textBody?.trim()
    && !message.htmlBody?.trim()
    && !message.sentAt
    && !message.receivedAt;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function domainContentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function dateOf(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** HTML 兜底转纯文本：Nango 归一化通常已给 textBody，缺省时从 htmlBody 剥离。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function senderOf(addresses: NormalizedAddress[] | undefined): { senderName: string | null; senderAddress: string | null } {
  const from = addresses?.find((item) => item.role === "from") ?? addresses?.find((item) => item.role === "sender");
  return {
    senderName: from?.displayName?.trim() || null,
    senderAddress: from?.address?.trim() || null,
  };
}

function recipientsOf(addresses: NormalizedAddress[] | undefined): Array<{ name?: string; address: string }> {
  return (addresses ?? [])
    .filter((item) => ["to", "cc", "bcc"].includes(item.role) && item.address?.trim())
    .map((item) => ({
      ...(item.displayName?.trim() ? { name: item.displayName.trim() } : {}),
      address: item.address.trim(),
    }));
}

export class ConnectorDomainProjection {
  constructor(
    private readonly db: ProjectionDatabase,
    /** 域表唯一键成员；与 CLI 路径 currentOwnerId() 同源（默认 "local-user"）。 */
    private readonly ownerId: string,
  ) {}

  projectMail(provider: string, connectionId: string, change: NormalizedMailChange, syncedAt = new Date()): DomainProjectionResult {
    if (change.kind === "tombstone") return this.softDelete(connectorEmails, provider, connectionId, change.providerMessageId, syncedAt);
    const message: NormalizedMail = change.message;
    if (isEmptyMailShell(message)) return { outcome: "skipped", id: null };
    const receivedAt = dateOf(message.receivedAt ?? message.sentAt);
    const bodyText = message.textBody?.trim() || (message.htmlBody ? htmlToText(message.htmlBody) : "");
    const { senderName, senderAddress } = senderOf(message.addresses);
    const normalized = {
      ownerId: this.ownerId,
      service: provider,
      connectionName: connectionId,
      sourceRecordId: message.providerMessageId,
      sourceUpdatedAt: dateOf(message.sentAt ?? message.receivedAt),
      schemaVersion: 1,
      promptVersion: 0,
      extensionPayload: null,
      messageId: message.providerMessageId,
      threadId: message.providerThreadId ?? null,
      senderName,
      senderAddress,
      recipients: recipientsOf(message.addresses),
      subject: message.subject?.trim() || "（无主题）",
      sentAt: dateOf(message.sentAt ?? message.receivedAt),
      bodyText,
      labels: message.memberships ?? [],
      hasAttachments: (message.attachments?.length ?? 0) > 0,
    };
    return this.upsert(connectorEmails, normalized, syncedAt);
  }

  projectCalendar(provider: string, connectionId: string, change: NormalizedCalendarChange, syncedAt = new Date()): DomainProjectionResult {
    if (change.kind === "tombstone") return this.softDelete(connectorCalendarEvents, provider, connectionId, change.providerEventId, syncedAt);
    const event: NormalizedCalendarEvent = change.event;
    const normalized = {
      ownerId: this.ownerId,
      service: provider,
      connectionName: connectionId,
      sourceRecordId: event.providerEventId,
      sourceUpdatedAt: dateOf(event.startsAt),
      schemaVersion: 1,
      promptVersion: 0,
      extensionPayload: null,
      eventId: event.providerEventId,
      title: event.title?.trim() || "（无标题）",
      description: event.description?.trim() || "",
      organizer: event.organizer?.address
        ? { ...(event.organizer.displayName ? { name: event.organizer.displayName } : {}), address: event.organizer.address }
        : null,
      attendees: (event.attendees ?? [])
        .filter((item) => item.address)
        .map((item) => ({
          ...(item.displayName ? { name: item.displayName } : {}),
          address: item.address,
        })),
      startAt: dateOf(event.startsAt),
      endAt: dateOf(event.endsAt),
      // ICS/归一化层声明了全天语义时透传；Gmail/Graph 折算 T00:00:00Z 的存量路径缺省 false。
      allDay: event.allDay === true,
      status: event.status ?? null,
      location: event.location ?? null,
    };
    return this.upsert(connectorCalendarEvents, normalized, syncedAt);
  }

  private upsert(
    table: typeof connectorEmails | typeof connectorCalendarEvents,
    normalized: Record<string, unknown>,
    syncedAt: Date,
  ): DomainProjectionResult {
    const existing = this.db.select({ id: table.id, contentHash: table.contentHash, deletedAt: table.deletedAt })
      .from(table)
      .where(and(
        eq(table.ownerId, normalized.ownerId as string),
        eq(table.service, normalized.service as string),
        eq(table.connectionName, normalized.connectionName as string),
        eq(table.sourceRecordId, normalized.sourceRecordId as string),
      ))
      .get();
    const hash = domainContentHash(normalized);
    // 内容未变化的记录跳过写入：否则每次同步/回填都把 syncedAt 刷成当前时刻，
    // 无 sentAt 的记录经日记的 syncedAt 兜底全部滑进"今天"的窗口（日记 agent 被撑爆的根因）。
    if (existing && existing.contentHash === hash && !existing.deletedAt) {
      return { outcome: "unchanged", id: existing.id };
    }
    const values = { ...normalized, id: existing?.id ?? randomUUID(), syncedAt, contentHash: hash, deletedAt: null };
    this.db.insert(table).values(values as never).onConflictDoUpdate({
      target: [table.ownerId, table.service, table.connectionName, table.sourceRecordId],
      set: values as never,
    }).run();
    return {
      outcome: !existing ? "inserted" : "updated",
      id: values.id as string,
    };
  }

  private softDelete(
    table: typeof connectorEmails | typeof connectorCalendarEvents,
    provider: string,
    connectionId: string,
    sourceRecordId: string,
    syncedAt: Date,
  ): DomainProjectionResult {
    const existing = this.db.select({ id: table.id, deletedAt: table.deletedAt })
      .from(table)
      .where(and(
        eq(table.ownerId, this.ownerId),
        eq(table.service, provider),
        eq(table.connectionName, connectionId),
        eq(table.sourceRecordId, sourceRecordId),
      ))
      .get();
    if (!existing || existing.deletedAt) return { outcome: "noop", id: existing?.id ?? null };
    this.db.update(table).set({ deletedAt: syncedAt }).where(eq(table.id, existing.id)).run();
    return { outcome: "deleted", id: existing.id };
  }
}

/**
 * 解析 ingest 侧的 connector sourceId ref：`connector:{provider}:{connectionId}:{kind}:{recordId}`。
 * document 分支无 kind 段（`connector:{provider}:{connectionId}:{docId}`）。
 * recordId 内若含 ":" 一并收回到最后一段（slice(4).join）——身份协议解析只此一处
 * （阶段四将整体退役为域行 id）。
 */
export interface ConnectorSourceRef {
  provider: string;
  connectionId: string;
  kind: "mail" | "calendar" | "document";
  recordId: string;
}

export function parseConnectorSourceRef(sourceId: string): ConnectorSourceRef | null {
  if (!sourceId.startsWith("connector:")) return null;
  const parts = sourceId.split(":");
  if (parts.length < 4) return null;
  const [, provider, connectionId, third] = parts;
  if (!provider || !connectionId) return null;
  if (third === "mail" || third === "calendar") {
    const recordId = parts.slice(4).join(":");
    return recordId ? { provider, connectionId, kind: third, recordId } : null;
  }
  // document：无 kind 段，third 起即 recordId。
  return third ? { provider, connectionId, kind: "document", recordId: parts.slice(3).join(":") } : null;
}


/** 回填数据源（ConnectorRepository 的窄接口，便于测试替身）。 */
export interface DomainBackfillSource {
  listConnections(): Array<{ id: string; provider: string }>;
  records(connectionId: string, recordType: "mail" | "calendar", opts?: { limit?: number; offset?: number }): ConnectorJsonRecord[];
}

export interface DomainBackfillSummary {
  connections: number;
  mail: number;
  calendar: number;
  failures: number;
}

/**
 * 存量回填：直读 connectors.sqlite 的 connector_records（payload 即归一化 JSON），
 * 过与实时同步**同一个**投影函数落主库域表。幂等：唯一键 upsert，
 * 重复执行产出 "unchanged"，可安全随启动重跑（阶段一不依赖 SQL 迁移——
 * 主库域表 schema 早已存在）。
 */
export function backfillDomainProjection(
  db: ProjectionDatabase,
  source: DomainBackfillSource,
  ownerId: string,
): DomainBackfillSummary {
  const projection = new ConnectorDomainProjection(db, ownerId);
  const summary: DomainBackfillSummary = { connections: 0, mail: 0, calendar: 0, failures: 0 };
  const pageSize = 500;
  for (const connection of source.listConnections()) {
    summary.connections += 1;
    for (const recordType of ["mail", "calendar"] as const) {
      for (let offset = 0; ; offset += pageSize) {
        let page: ConnectorJsonRecord[];
        try {
          page = source.records(connection.id, recordType, { limit: pageSize, offset });
        } catch {
          summary.failures += 1;
          break;
        }
        for (const record of page) {
          try {
            const result = recordType === "mail"
              ? projection.projectMail(record.provider, record.connectionId ?? connection.id, { kind: "upsert", message: record.data as NormalizedMail })
              : projection.projectCalendar(record.provider, record.connectionId ?? connection.id, { kind: "upsert", event: record.data as NormalizedCalendarEvent });
            // 只计 inserted/updated（"applied"口径）：幂等重跑时 unchanged 不增长，
            // 调用方可据此判断回填是否产生了新工作。
            if (result.outcome === "inserted" || result.outcome === "updated") summary[recordType] += 1;
          } catch {
            summary.failures += 1;
          }
        }
        if (page.length < pageSize) break;
      }
    }
  }
  return summary;
}
