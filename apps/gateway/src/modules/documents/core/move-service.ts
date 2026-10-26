import type { MovedRoomDocument } from "@nxcore/agent-contract";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  contextRooms,
  documentRoomImports,
  documents,
  externalDocumentBindings,
  roomDocumentLinks,
} from "../../../infrastructure/database/schema.js";
import { DocumentServiceError } from "../errors.js";
import { toRoomDocument } from "./repository.js";

/**
 * Room 产物跨 Room 移动（restructure：产物放错房/主题更适合其它房）。
 *
 * 归属的唯一事实源是 room_doc_links：移动 = 删源房链接 + 建目标房链接。
 * 文档正文、版本、评论、块引用都跟文档 id 走，不做副本；这样原房清单立即
 * 少一条、目标房清单立即多一条，且文档 id 保持不变（深链/引用不失效）。
 *
 * 知识侧投影（room_source_memberships / room_entity_mentions /
 * room_entity_facts / route_decisions）与搜索索引由 knowledge 模块的
 * document.moved 钩子同步，本服务不直接写知识表。
 */
export class DocumentRoomMoveService {
  constructor(private readonly db: GatewayDatabase) {}

  move(documentId: string, fromRoomId: string, targetRoomId: string): MovedRoomDocument {
    const from = fromRoomId.trim();
    const to = targetRoomId.trim();
    if (!from || !to) throw new DocumentServiceError("INVALID_ROOM", "Room id is required", 400);
    if (from === to) {
      throw new DocumentServiceError("SAME_ROOM", "Document already belongs to this Room", 409);
    }
    this.requireActiveRoom(to);

    const moved = this.db.transaction((tx) => {
      const row = tx.select().from(documents).where(eq(documents.id, documentId)).get();
      if (!row) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (row.deletedAt) {
        throw new DocumentServiceError(
          "DOCUMENT_TRASHED",
          "Restore the document from trash before moving it",
          409,
        );
      }
      if (row.activeTransactionId) {
        throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
      }
      const sourceLink = tx.select().from(roomDocumentLinks)
        .where(and(eq(roomDocumentLinks.roomId, from), eq(roomDocumentLinks.documentId, documentId)))
        .get();
      if (!sourceLink) {
        throw new DocumentServiceError(
          "ROOM_MISMATCH",
          "Document does not belong to the source Room",
          409,
        );
      }

      const now = new Date();
      const targetLink = tx.select().from(roomDocumentLinks)
        .where(and(eq(roomDocumentLinks.roomId, to), eq(roomDocumentLinks.documentId, documentId)))
        .get();
      tx.delete(roomDocumentLinks)
        .where(and(eq(roomDocumentLinks.roomId, from), eq(roomDocumentLinks.documentId, documentId)))
        .run();
      if (targetLink) {
        // 目标房已有链接（多房归属）：源链接摘除即可，目标链接刷新为最近挂载。
        tx.update(roomDocumentLinks).set({ linkedAt: now })
          .where(and(eq(roomDocumentLinks.roomId, to), eq(roomDocumentLinks.documentId, documentId)))
          .run();
      } else {
        tx.insert(roomDocumentLinks).values({
          roomId: to,
          documentId,
          folderId: null,
          linkedAt: now,
        }).run();
      }
      // 导入台账 / 外部投影绑定跟随归属，避免「移动后仍按源房同步」。
      tx.update(documentRoomImports).set({ roomId: to })
        .where(and(eq(documentRoomImports.roomId, from), eq(documentRoomImports.documentId, documentId)))
        .run();
      tx.update(externalDocumentBindings).set({ roomId: to, updatedAt: now })
        .where(and(eq(externalDocumentBindings.roomId, from), eq(externalDocumentBindings.documentId, documentId)))
        .run();

      return {
        documentId,
        fromRoomId: from,
        toRoomId: to,
        title: row.title,
        document: toRoomDocument(row, to),
      } satisfies MovedRoomDocument;
    });
    return moved;
  }

  /**
   * 批量移动：先整批预检（文档存在、未入回收站、无进行中的 Agent 写入、
   * 确实属于源房、目标房有效），再逐文档独立事务搬运。预检把「一半成功一半
   * 失败」压缩到数据库异常的极小概率；真遇到异常时已完成的项保持移动结果
   * （事件已广播，两侧清单自洽），调用方按错误提示重试剩余项即可。
   */
  moveMany(documentIds: string[], fromRoomId: string, targetRoomId: string): MovedRoomDocument[] {
    const unique = [...new Set(documentIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) {
      throw new DocumentServiceError("INVALID_DOCUMENT_IDS", "Select at least one document", 400);
    }
    if (unique.length > 100) {
      throw new DocumentServiceError("TOO_MANY_DOCUMENTS", "Move at most 100 documents at once", 400);
    }
    const from = fromRoomId.trim();
    const to = targetRoomId.trim();
    if (!from || !to) throw new DocumentServiceError("INVALID_ROOM", "Room id is required", 400);
    if (from === to) {
      throw new DocumentServiceError("SAME_ROOM", "Document already belongs to this Room", 409);
    }
    this.requireActiveRoom(to);
    for (const documentId of unique) this.assertMovable(documentId, from);
    return unique.map((documentId) => this.move(documentId, from, to));
  }

  /** 预检（只读）：批量入口在写入前一次性暴露可预期错误。 */
  private assertMovable(documentId: string, fromRoomId: string): void {
    const row = this.db.select().from(documents).where(eq(documents.id, documentId)).get();
    if (!row) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    if (row.deletedAt) {
      throw new DocumentServiceError(
        "DOCUMENT_TRASHED",
        "Restore the document from trash before moving it",
        409,
      );
    }
    if (row.activeTransactionId) {
      throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
    }
    const sourceLink = this.db.select({ documentId: roomDocumentLinks.documentId })
      .from(roomDocumentLinks)
      .where(and(eq(roomDocumentLinks.roomId, fromRoomId), eq(roomDocumentLinks.documentId, documentId)))
      .get();
    if (!sourceLink) {
      throw new DocumentServiceError(
        "ROOM_MISMATCH",
        "Document does not belong to the source Room",
        409,
      );
    }
  }

  private requireActiveRoom(roomId: string): void {
    const room = this.db.select({
      id: contextRooms.id,
      lifecycle: contextRooms.lifecycle,
      deletedAt: contextRooms.deletedAt,
    }).from(contextRooms).where(eq(contextRooms.id, roomId)).get();
    if (!room || room.deletedAt || room.lifecycle !== "active") {
      throw new DocumentServiceError("TARGET_ROOM_NOT_FOUND", "Target Room not found", 404);
    }
  }
}
