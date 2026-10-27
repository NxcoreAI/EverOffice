import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { documentRoutes } from "../src/modules/documents/routes.js";
import type { DocumentService } from "../src/modules/documents/service.js";

/** 路由只消费注入的派发函数：用假 DocumentService + 假派发器跑 HTTP 契约。 */
async function createHarness(
  dispatch: (taskInput: Record<string, unknown>) => Promise<string>,
): Promise<FastifyInstance> {
  const service = { broker: new DocumentEventBroker() } as unknown as DocumentService;
  const app = Fastify();
  await app.register(documentRoutes(service, undefined, null, dispatch));
  return app;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("POST /v1/documents/selection-rewrite（Phase 2i-2）", () => {
  it("派发 rewrite task 并返回 invocationId（可选字段按需透传、roomId 不出现）", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const app = await createHarness(async (taskInput) => {
      dispatched.push(taskInput);
      return "inv-1";
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/selection-rewrite",
      payload: {
        documentId: "doc-1",
        documentName: "季度汇报",
        selectedText: " 这段文字要改写 ",
        instruction: "  更简洁  ",
        contextBefore: "前文",
        contextAfter: "后文",
        blockType: "paragraph",
        responseLanguage: "zh-CN",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ invocationId: "inv-1" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      selectedText: " 这段文字要改写 ",
      instruction: "更简洁",
      contextBefore: "前文",
      contextAfter: "后文",
      blockType: "paragraph",
      documentId: "doc-1",
      documentName: "季度汇报",
      responseLanguage: "zh-CN",
    });
    expect(dispatched[0]).not.toHaveProperty("roomId");
  });

  it("selectedText 只有空白 → 400，且不派发", async () => {
    const dispatch = vi.fn(async () => "inv-2");
    const app = await createHarness(dispatch);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/selection-rewrite",
      payload: { selectedText: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "selection_required" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("并发限额 → 503；其他派发失败 → 500", async () => {
    let failure = "subagent_concurrency_limit";
    const app = await createHarness(async () => {
      throw new Error(failure);
    });
    apps.push(app);

    const limited = await app.inject({
      method: "POST",
      url: "/v1/documents/selection-rewrite",
      payload: { selectedText: "改写我" },
    });
    expect(limited.statusCode).toBe(503);
    expect(limited.json()).toMatchObject({ error: "subagent_concurrency_limit" });

    failure = "subagent_global_concurrency_limit";
    const globallyLimited = await app.inject({
      method: "POST",
      url: "/v1/documents/selection-rewrite",
      payload: { selectedText: "改写我" },
    });
    expect(globallyLimited.statusCode).toBe(503);

    failure = "doc_writer_dispatch_failed";
    const failed = await app.inject({
      method: "POST",
      url: "/v1/documents/selection-rewrite",
      payload: { selectedText: "改写我" },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: "doc_writer_dispatch_failed" });
  });
});