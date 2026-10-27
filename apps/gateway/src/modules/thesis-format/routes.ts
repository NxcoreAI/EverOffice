import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import multipart from "@fastify/multipart";
import { Type } from "@sinclair/typebox";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import type { ThesisFormatService } from "./service.js";

/** 工作区作用域：论文格式卡按工作区读写（Room 已删除，scope 写入 room_id 历史列）。 */
const WORKSPACE_SCOPE = WORKSPACE_DOCUMENT_CHANNEL;

const RoomParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
});

const LegacyCardParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  cardId: Type.String({ minLength: 1, maxLength: 64 }),
});

const CardParams = Type.Object({
  cardId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ParseBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const ReformatBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
  cardId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

const CardDto = Type.Object({
  id: Type.String(),
  sourceName: Type.String(),
  sourceFileEntryId: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
  card: Type.Unknown(),
});

/**
 * 论文格式管线路由：模版解析（库内文件 / multipart 直传，zip 不进文件库）、
 * 格式卡列表/删除与一键装订。装订是长任务（子代理映射 + 桌面渲染 + 入库），HTTP 同步等待。
 *
 * 工作区作用域为默认入口（Room 已删除）：`/v1/thesis-format/{cards,parse,parse-upload,reformat}`。
 * 旧 `/v1/thesis-format/rooms/:roomId/...` 保留兼容，roomId 直接当 scope 用（旧数据仍可读）。
 */
export function thesisFormatRoutes(service: ThesisFormatService): FastifyPluginAsyncTypebox {
  return async (app) => {
    await app.register(multipart, {
      attachFieldsToBody: false,
      limits: { fileSize: 80 * 1024 * 1024, files: 1 },
    });

    const listCards = (scope: string) => service.cardStore().listInScope(scope).map((row) => ({
      id: row.id,
      sourceName: row.sourceName,
      sourceFileEntryId: row.sourceFileEntryId,
      updatedAt: row.updatedAt.toISOString(),
      card: row.card,
    }));

    // ── 工作区作用域（新入口） ──

    app.get("/v1/thesis-format/cards", {
      schema: {
        tags: ["thesis-format"],
        response: {
          200: Type.Array(CardDto),
        },
      },
    }, async () => {
      return listCards(WORKSPACE_SCOPE);
    });

    app.delete("/v1/thesis-format/cards/:cardId", {
      schema: {
        tags: ["thesis-format"],
        params: CardParams,
        response: {
          200: Type.Object({ removed: Type.Boolean() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      const removed = service.removeCard(WORKSPACE_SCOPE, request.params.cardId);
      if (!removed) return reply.code(404).send({ error: "thesis_format_card_not_found" });
      return { removed: true };
    });

    app.post("/v1/thesis-format/parse", {
      schema: {
        tags: ["thesis-format"],
        body: ParseBody,
        response: {
          200: Type.Object({
            cardId: Type.String(),
            sourceName: Type.String(),
            card: Type.Unknown(),
          }),
          400: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.parseFromLibrary(WORKSPACE_SCOPE, request.body.fileEntryId);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/parse-upload", {
      schema: { tags: ["thesis-format"] },
      bodyLimit: 80 * 1024 * 1024,
    }, async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "file_part_required" });
      const name = file.filename || "模版.zip";
      const bytes = await file.toBuffer();
      if (bytes.length === 0) return reply.code(400).send({ error: "file_empty" });
      try {
        const result = await service.parseFromUpload(WORKSPACE_SCOPE, bytes, name);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/reformat", {
      schema: {
        tags: ["thesis-format"],
        body: ReformatBody,
        response: {
          200: Type.Object({
            fileEntryId: Type.String(),
            originalName: Type.String(),
          }),
          400: Type.Object({ error: Type.String() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.reformat(
          WORKSPACE_SCOPE,
          request.body.fileEntryId,
          request.body.cardId,
        );
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "thesis_reformat_failed";
        const code = message === "thesis_format_card_not_found" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    });

    // ── 旧 Room 路径（兼容保留）：roomId 直接作为 scope，旧数据按原 roomId 读 ──

    app.get("/v1/thesis-format/rooms/:roomId/cards", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        response: {
          200: Type.Array(CardDto),
        },
      },
    }, async (request) => {
      return listCards(request.params.roomId);
    });

    app.delete("/v1/thesis-format/rooms/:roomId/cards/:cardId", {
      schema: {
        tags: ["thesis-format"],
        params: LegacyCardParams,
        response: {
          200: Type.Object({ removed: Type.Boolean() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      const removed = service.removeCard(request.params.roomId, request.params.cardId);
      if (!removed) return reply.code(404).send({ error: "thesis_format_card_not_found" });
      return { removed: true };
    });

    app.post("/v1/thesis-format/rooms/:roomId/parse", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        body: ParseBody,
        response: {
          200: Type.Object({
            cardId: Type.String(),
            sourceName: Type.String(),
            card: Type.Unknown(),
          }),
          400: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.parseFromLibrary(request.params.roomId, request.body.fileEntryId);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/rooms/:roomId/parse-upload", {
      schema: { tags: ["thesis-format"], params: RoomParams },
      bodyLimit: 80 * 1024 * 1024,
    }, async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "file_part_required" });
      const name = file.filename || "模版.zip";
      const bytes = await file.toBuffer();
      if (bytes.length === 0) return reply.code(400).send({ error: "file_empty" });
      try {
        const result = await service.parseFromUpload(request.params.roomId, bytes, name);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/rooms/:roomId/reformat", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        body: ReformatBody,
        response: {
          200: Type.Object({
            fileEntryId: Type.String(),
            originalName: Type.String(),
          }),
          400: Type.Object({ error: Type.String() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.reformat(
          request.params.roomId,
          request.body.fileEntryId,
          request.body.cardId,
        );
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "thesis_reformat_failed";
        const code = message === "thesis_format_card_not_found" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    });
  };
}
