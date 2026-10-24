import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { agentDocumentMarkdown } from "./agent-markdown.js";
import { documentBodyContent } from "./content-model.js";
import { DocumentServiceError, type DocumentService } from "./service.js";
import type { DocumentIndexBackfillReadTrigger } from "./index-backfill/read-trigger.js";
const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const JsonDocument = Type.Object({ type: Type.Literal("doc") }, { additionalProperties: true });
const BlockReference = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  documentId: Type.String({ minLength: 1, maxLength: 128 }), blockId: Type.String({ minLength: 1, maxLength: 128 }),
});
function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

/**
 * 划词改写的派发器（由 create-server 注入 `doc-writer` 的 rewrite task）：
 * documents 模块不依赖 subagents，只约定「拿任务入参、立即返回 invocationId」。
 */
export type SelectionRewriteDispatch = (taskInput: Record<string, unknown>) => Promise<string>;

export function documentRoutes(
  service: DocumentService,
  summaryRuntime?: () => import("@nxcore/agent-runtime").AgentRuntime | null,
  indexBackfillReadTrigger?: DocumentIndexBackfillReadTrigger | null,
  dispatchSelectionRewrite?: SelectionRewriteDispatch | null,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    // 工作区级文稿库（Phase 2i 起不再有 Room 分区，roomId 查询参数已删除）。
    app.get(
      "/v1/documents",
      {
        schema: {
          tags: ["documents"],
          querystring: Type.Object({
            trashed: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
            origin: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("import")])),
          }),
        },
      },
      async (request) => service.list(
        request.query.trashed === "true",
        request.query.origin,
      ),
    );

    app.get(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        const document = service.get(request.params.id);
        if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
        indexBackfillReadTrigger?.trigger(document);
        return document;
      },
    );

    // 文档正文的 Markdown 序列化（与 external-projections 写回 Vault 用同一个序列化器，
    // 保证「编辑器保存 → 写回笔记文件 → 文件同步回文档」内容一致、不产生额外版本抖动）。
    app.get(
      "/v1/documents/:id/markdown",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          response: {
            200: Type.Object({ documentId: Type.String(), markdown: Type.String() }),
            404: Type.Object({ error: Type.String(), message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const document = service.get(request.params.id);
        if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
        return {
          documentId: document.id,
          markdown: agentDocumentMarkdown.serialize(documentBodyContent(document.contentJson)),
        };
      },
    );

    app.get(
      "/v1/documents/:id/blocks",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          const document = service.get(request.params.id);
          if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
          indexBackfillReadTrigger?.trigger(document);
          return {
            documentId: document.id,
            roomId: document.roomId,
            version: document.version,
            blocks: service.listBlocks(document.id),
          };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/backlinks",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            blockId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return {
            documentId: request.params.id,
            blockId: request.query.blockId ?? null,
            backlinks: service.listBlockBacklinks(request.params.id, request.query.blockId),
          };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            beforeVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return service.listVersions(request.params.id, request.query);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions/:version/change-summary",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.versionChangeSummary(request.params.id, request.params.version, summaryRuntime?.() ?? null);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions/:version",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          const snapshot = service.getVersionSnapshot(request.params.id, request.params.version);
          return snapshot ?? reply.code(404).send({ error: "VERSION_NOT_FOUND", message: "Document version not found" });
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/diff",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            toVersion: Type.Integer({ minimum: 1 }),
            fromVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          const result = service.diff(
            request.params.id,
            request.query.fromVersion ?? null,
            request.query.toVersion,
          );
          return result ?? reply.code(404).send({ error: "VERSION_NOT_FOUND", message: "Document version not found" });
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/history/backfill/retry",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          service.retryYjsHistoryBackfill(request.params.id);
          return { queued: true, documentId: request.params.id };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/versions/:version/restore",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
          body: Type.Object({ baseVersion: Type.Integer({ minimum: 0 }) }),
        },
      },
      async (request, reply) => {
        try {
          return await service.restoreVersion(
            request.params.id,
            request.params.version,
            request.body.baseVersion,
          );
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-blocks/resolve",
      {
        schema: {
          tags: ["documents"],
          body: Type.Object({
            sourceRoomId: Type.String({ minLength: 1, maxLength: 128 }),
            references: Type.Array(BlockReference, { maxItems: 200 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return { resolutions: service.resolveBlockReferences(request.body) };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/trash",
      {
        schema: {
          tags: ["documents"],
          // 清空整个工作区回收站（Phase 2i 起 Room 过滤维度已删除）。
        },
      },
      async (_request, reply) => {
        await service.emptyTrash();
        return reply.code(204).send();
      },
    );

    app.post(
      "/v1/documents/import",
      {
        schema: {
          tags: ["documents"],
          body: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            // 省略 = 工作区级文稿（不归属任何 Room，P0-2）。
            roomId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
            title: Type.String({ minLength: 1, maxLength: 120 }),
            contentJson: JsonDocument,
            origin: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("import")])),
          }),
        },
      },
      async (request, reply) =>
        reply.code(201).send(await service.import({ ...request.body, roomId: request.body.roomId ?? null })),
    );

    // 划词改写：编辑器选中文本 → 派发 doc-writer 的 rewrite task，立即返回 invocationId，
    // 渲染层再轮询 GET /v1/subagent-invocations/:id 取替换文本（同步流由客户端轮询模拟）。
    // Phase 2i-2：原 POST /v1/context-rooms/selection-rewrite 随 context-rooms 模块删除，
    // 路径迁到 documents；roomId 不再出现在入参里（文稿一律工作区级）。
    app.post(
      "/v1/documents/selection-rewrite",
      {
        schema: {
          tags: ["documents"],
          body: Type.Object({
            documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            documentName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            selectedText: Type.String({ minLength: 1, maxLength: 20_000 }),
            instruction: Type.Optional(Type.String({ maxLength: 2_000 })),
            contextBefore: Type.Optional(Type.String({ maxLength: 4_000 })),
            contextAfter: Type.Optional(Type.String({ maxLength: 4_000 })),
            blockType: Type.Optional(Type.String({ maxLength: 64 })),
            responseLanguage: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        if (!dispatchSelectionRewrite) {
          return reply.code(503).send({ error: "doc_writer_not_configured" });
        }
        const body = request.body;
        if (!body.selectedText.trim()) {
          return reply.code(400).send({ error: "selection_required" });
        }
        // 框架无排队（方案 §5.1）：并发限额是可诊断的硬错误，直接冒 500 会在桌面端
        // 变成笼统的 internal gateway error，这里显式透出错误码。
        let invocationId: string;
        try {
          invocationId = await dispatchSelectionRewrite({
            selectedText: body.selectedText,
            ...(body.instruction?.trim() ? { instruction: body.instruction.trim() } : {}),
            ...(body.contextBefore?.trim() ? { contextBefore: body.contextBefore } : {}),
            ...(body.contextAfter?.trim() ? { contextAfter: body.contextAfter } : {}),
            ...(body.blockType?.trim() ? { blockType: body.blockType } : {}),
            ...(body.documentId ? { documentId: body.documentId } : {}),
            ...(body.documentName ? { documentName: body.documentName } : {}),
            ...(body.responseLanguage ? { responseLanguage: body.responseLanguage } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          request.log.warn({ err: message }, "selection rewrite dispatch rejected");
          const retryable = message === "subagent_concurrency_limit"
            || message === "subagent_global_concurrency_limit";
          return reply.code(retryable ? 503 : 500).send({ error: message });
        }
        return { invocationId };
      },
    );

    app.put(
      "/v1/documents/:id",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 0 }),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            contentJson: JsonDocument,
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.save(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send(errorPayload(error));
          }
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          await service.delete(request.params.id);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/restore",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          return await service.restore(request.params.id);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/:id/permanent",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          await service.deletePermanently(request.params.id);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    // 文档事件 WS：路径段沿用旧 Room 频道 id（桌面 document-gateway-bridge 以
    // WORKSPACE_DOCUMENT_CHANNEL 订阅），Phase 2i 起它就是工作区频道本身。
    app.get(
      "/v1/documents/rooms/:id/stream",
      { websocket: true, schema: { tags: ["documents"], params: IdParams } },
      (socket, request) => {
        const unsubscribe = service.broker.subscribe(request.params.id, socket);
        socket.send(JSON.stringify({ type: "document.ready", protocol: 1, roomId: request.params.id }));
        socket.once("close", unsubscribe);
      },
    );
  };
}
