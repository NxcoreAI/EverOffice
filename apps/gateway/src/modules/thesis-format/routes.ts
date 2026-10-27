import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import multipart from "@fastify/multipart";
import { Type } from "@sinclair/typebox";
import type { ThesisFormatService } from "./service.js";

const RoomParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
});

const CardParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  cardId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ParseBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const ReformatOptions = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("blend")])),
  keepLogo: Type.Optional(Type.Boolean()),
  keepHeaderFooter: Type.Optional(Type.Boolean()),
  headingMapping: Type.Optional(Type.Object({
    chapter: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
    section: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
    subsection: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const ReformatBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
  cardId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  /** 工作台规则面板：模式/固定元素/标题层级映射（全部可缺省）。 */
  options: Type.Optional(ReformatOptions),
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
 */
export function thesisFormatRoutes(service: ThesisFormatService): FastifyPluginAsyncTypebox {
  return async (app) => {
    await app.register(multipart, {
      attachFieldsToBody: false,
      limits: { fileSize: 80 * 1024 * 1024, files: 1 },
    });

    app.get("/v1/thesis-format/rooms/:roomId/cards", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        response: {
          200: Type.Array(CardDto),
        },
      },
    }, async (request) => {
      return service.cardStore().list(request.params.roomId).map((row) => ({
        id: row.id,
        sourceName: row.sourceName,
        sourceFileEntryId: row.sourceFileEntryId,
        updatedAt: row.updatedAt.toISOString(),
        card: row.card,
      }));
    });

    app.delete("/v1/thesis-format/rooms/:roomId/cards/:cardId", {
      schema: {
        tags: ["thesis-format"],
        params: CardParams,
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
            factGaps: Type.Array(Type.String()),
          }),
          400: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.parseFromLibrary(request.params.roomId, request.body.fileEntryId);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps });
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
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card, factGaps: result.factGaps });
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
          request.body.options as Parameters<typeof service.reformat>[3],
        );
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "thesis_reformat_failed";
        const code = message === "thesis_format_card_not_found" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    });

    /**
     * 任务化排版：立即返回 jobId（长任务不占客户端请求槽，避免 5 分钟被中间层掐断）。
     * 客户端用 GET /v1/thesis-format/jobs/:jobId 轮询阶段与进度。
     */
    app.post("/v1/thesis-format/rooms/:roomId/reformat-jobs", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        body: ReformatBody,
        response: {
          200: Type.Object({ jobId: Type.String(), phase: Type.String() }),
          400: Type.Object({ error: Type.String() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const job = service.startReformatJob(
          request.params.roomId,
          request.body.fileEntryId,
          request.body.cardId,
          request.body.options as Parameters<typeof service.reformat>[3],
        );
        return reply.send({ jobId: job.id, phase: job.phase });
      } catch (error) {
        const message = error instanceof Error ? error.message : "thesis_reformat_failed";
        const code = message === "thesis_format_card_not_found" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    });

    app.get("/v1/thesis-format/jobs/:jobId", {
      schema: {
        tags: ["thesis-format"],
        params: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 80 }) }),
        response: {
          200: Type.Object({
            id: Type.String(),
            status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
            phase: Type.String(),
            progress: Type.Number(),
            startedAt: Type.String(),
            finishedAt: Type.Optional(Type.String()),
            result: Type.Optional(Type.Unknown()),
            error: Type.Optional(Type.String()),
          }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      const job = service.reformatJob(request.params.jobId);
      if (!job) return reply.code(404).send({ error: "thesis_job_not_found" });
      return reply.send(job);
    });
  };
}
