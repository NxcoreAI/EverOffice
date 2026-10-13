/**
 * 论文格式卡存取（thesis_format_cards 表）。一 Room 一卡：
 * 设新模版即整体覆盖；排版按钮凭卡存在与否亮灭。
 */

import { eq } from "drizzle-orm";
import { thesisFormatCards } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { ThesisFormatCard } from "./types.js";

export class ThesisFormatCardStore {
  constructor(private readonly db: GatewayDatabase) {}

  byRoom(roomId: string): ThesisFormatCard | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, roomId))
      .limit(1)
      .get();
    if (!row) return null;
    return row.formatCard as unknown as ThesisFormatCard;
  }

  meta(roomId: string): { sourceName: string; updatedAt: Date; sourceFileEntryId: string | null } | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, roomId))
      .limit(1)
      .get();
    if (!row) return null;
    return { sourceName: row.sourceName, updatedAt: row.updatedAt, sourceFileEntryId: row.sourceFileEntryId };
  }

  upsert(input: { roomId: string; card: ThesisFormatCard; sourceFileEntryId: string | null; sourceName: string }): void {
    const now = new Date();
    this.db.insert(thesisFormatCards)
      .values({
        roomId: input.roomId,
        formatCard: input.card as unknown as Record<string, unknown>,
        sourceFileEntryId: input.sourceFileEntryId,
        sourceName: input.sourceName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: thesisFormatCards.roomId,
        set: {
          formatCard: input.card as unknown as Record<string, unknown>,
          sourceFileEntryId: input.sourceFileEntryId,
          sourceName: input.sourceName,
          updatedAt: now,
        },
      })
      .run();
  }
}
