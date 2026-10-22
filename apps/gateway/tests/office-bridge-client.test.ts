import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";

interface Recorded {
  url?: string | undefined;
  authorization?: string | undefined;
  body?: Record<string, unknown> | undefined;
}

/** 本地 stub：记录请求并按状态回 JSON（桌面 office-bridge 端点契约的最小替身）。 */
async function startStub(status = 200, data: Record<string, unknown> = {}) {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      recorded.push({
        url: request.url,
        authorization: String(request.headers.authorization ?? ""),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { data } : { message: "boom" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new OfficeBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, token: "test-token" });
  return {
    recorded,
    client,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("OfficeBridgeClient", () => {
  it("generate 透传 deferDone（pptx 骨架入库阶段不广播 done）", async () => {
    const stub = await startStub(200, { fileEntryId: "file-1", originalName: "deck.pptx" });
    try {
      const result = await stub.client.generate({
        title: "季度汇报",
        format: "pptx",
        pages: ["{}"],
        roomId: "room-1",
        fileName: null,
        idempotencyKey: "idem-1",
        deferDone: true,
      });
      expect(result.fileEntryId).toBe("file-1");
      expect(stub.recorded[0]?.url).toBe("/v1/office-generate");
      expect(stub.recorded[0]?.authorization).toBe("Bearer test-token");
      expect(stub.recorded[0]?.body).toMatchObject({ format: "pptx", deferDone: true });
    } finally {
      await stub.close();
    }
  });

  it("completeDeck 调 /v1/office-complete 并带上真完成载荷", async () => {
    const stub = await startStub(200, { ok: true });
    try {
      const result = await stub.client.completeDeck({
        fileId: "file-1",
        title: "季度汇报",
        originalName: "季度汇报.pptx",
        roomId: "room-1",
        completed: false,
        appliedPages: 2,
        totalPages: 3,
        failedPages: [2],
      });
      expect(result).toEqual({ ok: true });
      expect(stub.recorded[0]?.url).toBe("/v1/office-complete");
      expect(stub.recorded[0]?.authorization).toBe("Bearer test-token");
      expect(stub.recorded[0]?.body).toMatchObject({
        fileId: "file-1",
        completed: false,
        appliedPages: 2,
        totalPages: 3,
        failedPages: [2],
      });
    } finally {
      await stub.close();
    }
  });

  it("completeDeck 非 200 抛错（调用方 try/catch 不阻塞产物）", async () => {
    const stub = await startStub(502);
    try {
      await expect(stub.client.completeDeck({
        fileId: "file-1",
        title: "季度汇报",
        completed: true,
        appliedPages: 3,
        totalPages: 3,
      })).rejects.toThrow("boom");
    } finally {
      await stub.close();
    }
  });
});
