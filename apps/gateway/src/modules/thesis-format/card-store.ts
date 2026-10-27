/**
 * 论文格式卡存取（thesis_format_cards 表）。一张卡 = 一份模版：
 * (room_id, source_name) 唯一，重传同名模版即覆盖；排版按卡 id 取用。
 *
 * Room 已删除：room_id 是 NOT NULL 的历史列，本阶段不改 schema，统一把它当
 * scope 键用——工作区作用域写 `WORKSPACE_DOCUMENT_CHANNEL` 哨兵，旧的行按
 * 原 roomId scope 仍能读到（读路径按 scope 精确匹配）。
 */

import { and, desc, eq } from "drizzle-orm";
import { thesisFormatCards } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { ThesisFormatCard } from "./types.js";

export interface ThesisFormatCardRow {
  id: string;
  card: ThesisFormatCard;
  sourceName: string;
  sourceFileEntryId: string | null;
  updatedAt: Date;
}

function toRow(row: typeof thesisFormatCards.$inferSelect): ThesisFormatCardRow {
  return {
    id: row.id,
    card: row.formatCard as unknown as ThesisFormatCard,
    sourceName: row.sourceName,
    sourceFileEntryId: row.sourceFileEntryId,
    updatedAt: row.updatedAt,
  };
}

export class ThesisFormatCardStore {
  constructor(private readonly db: GatewayDatabase) {}

  /** scope（工作区哨兵或旧 roomId）下的全部格式卡，新的在前。 */
  listInScope(scope: string): ThesisFormatCardRow[] {
    return this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, scope))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .all()
      .map(toRow);
  }

  byIdInScope(scope: string, cardId: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.roomId, scope)))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  /** scope 下最新一张卡（reformat 未指明 cardId 时的缺省）。 */
  latestInScope(scope: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, scope))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  removeInScope(scope: string, cardId: string): boolean {
    const result = this.db.delete(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.roomId, scope)))
      .run();
    return result.changes > 0;
  }

  /** 按 (scope, sourceName) 覆盖写：scope 落在 room_id 列。 */
  upsertInScope(input: { scope: string; card: ThesisFormatCard; sourceFileEntryId: string | null; sourceName: string }): ThesisFormatCardRow {
    const now = new Date();
    this.db.insert(thesisFormatCards)
      .values({
        id: crypto.randomUUID(),
        roomId: input.scope,
        formatCard: input.card as unknown as Record<string, unknown>,
        sourceFileEntryId: input.sourceFileEntryId,
        sourceName: input.sourceName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [thesisFormatCards.roomId, thesisFormatCards.sourceName],
        set: {
          formatCard: input.card as unknown as Record<string, unknown>,
          sourceFileEntryId: input.sourceFileEntryId,
          updatedAt: now,
        },
      })
      .run();
    const row = this.db.select().from(thesisFormatCards)
      .where(and(eq(thesisFormatCards.roomId, input.scope), eq(thesisFormatCards.sourceName, input.sourceName)))
      .limit(1)
      .get();
    if (!row) throw new Error("thesis_format_card_upsert_failed");
    return toRow(row);
  }

  // ── 旧 roomId 语义别名（Room 已删除，roomId 即 scope；保留兼容旧调用） ──

  /** @deprecated 用 listInScope(scope)。 */
  list(roomId: string): ThesisFormatCardRow[] {
    return this.listInScope(roomId);
  }

  /** @deprecated 用 byIdInScope(scope, cardId)。 */
  byId(roomId: string, cardId: string): ThesisFormatCardRow | null {
    return this.byIdInScope(roomId, cardId);
  }

  /** @deprecated 用 latestInScope(scope)。 */
  latest(roomId: string): ThesisFormatCardRow | null {
    return this.latestInScope(roomId);
  }

  /** @deprecated 用 removeInScope(scope, cardId)。 */
  remove(roomId: string, cardId: string): boolean {
    return this.removeInScope(roomId, cardId);
  }

  /** @deprecated 用 upsertInScope({ scope, ... })。 */
  upsert(input: { roomId: string; card: ThesisFormatCard; sourceFileEntryId: string | null; sourceName: string }): ThesisFormatCardRow {
    const { roomId, ...rest } = input;
    return this.upsertInScope({ scope: roomId, ...rest });
  }
}
