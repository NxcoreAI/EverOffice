import { and, eq } from "drizzle-orm";
import type { ConnectorDocumentStore } from "@nxcore/connectors-module/document-store.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorEmails,
} from "../../infrastructure/database/schema.js";

export interface ConnectorPurgeCascadeDeps {
  db: GatewayDatabase;
  documentStore: ConnectorDocumentStore | null;
  ownerId: string;
  log: { info(bindings: unknown, msg: string): void; warn(bindings: unknown, msg: string): void };
}

export interface ConnectorPurgeCascadeSummary {
  mailRows: number;
  calendarRows: number;
}

/**
 * 连接删除级联（routes onPurge 注入）：清理该连接在 gateway.sqlite 的全部
 * 下游沉淀——域表行、ingest 台账、document-store 落盘文件。
 * connectors.sqlite 由调用后的 repository.purgeConnection 收尾。
 *
 * Phase 1：记忆文档与 knowledge Room/wiki 归属两步已随模块断耦合摘除。
 * 幂等：各步均可安全重试（重复删除为 no-op）；失败抛错时连接保留，
 * 路由 500，用户重试即可。
 *
 * LIKE 前缀安全前提：connectionId 为 repository 铸造的 UUID、provider 为
 * 注册表词表，均不含 % / _ 通配符。
 */
export async function purgeConnectorConnectionCascade(
  deps: ConnectorPurgeCascadeDeps,
  connection: { id: string; provider: string },
): Promise<ConnectorPurgeCascadeSummary> {
  const { db, documentStore, ownerId, log } = deps;

  const mailRows = db.select({ id: connectorEmails.id }).from(connectorEmails)
    .where(and(eq(connectorEmails.ownerId, ownerId), eq(connectorEmails.connectionName, connection.id)))
    .all();
  const calendarRows = db.select({ id: connectorCalendarEvents.id }).from(connectorCalendarEvents)
    .where(and(eq(connectorCalendarEvents.ownerId, ownerId), eq(connectorCalendarEvents.connectionName, connection.id)))
    .all();
  db.delete(connectorEmails)
    .where(and(eq(connectorEmails.ownerId, ownerId), eq(connectorEmails.connectionName, connection.id)))
    .run();
  db.delete(connectorCalendarEvents)
    .where(and(eq(connectorCalendarEvents.ownerId, ownerId), eq(connectorCalendarEvents.connectionName, connection.id)))
    .run();
  if (documentStore) await documentStore.purge(connection.provider, connection.id);

  const summary: ConnectorPurgeCascadeSummary = {
    mailRows: mailRows.length,
    calendarRows: calendarRows.length,
  };
  log.info({ module: "connector-purge-cascade", connectionId: connection.id, ...summary }, "connector connection downstream cascade purged");
  return summary;
}
