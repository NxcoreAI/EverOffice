import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRelaySessionStore } from "../src/modules/ai-relay/session.js";
import { SlidesStyleImageGenerator } from "../src/modules/slides-style/image-gen.js";
import type { FilesService } from "../src/modules/files/service.js";

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => {
      const item = (body as { data?: Array<{ b64_json?: string }> }).data?.[0];
      return Buffer.from(item?.b64_json ?? "", "base64");
    },
  } as unknown as Response;
}

function setupStore(active: boolean): AiRelaySessionStore {
  const store = new AiRelaySessionStore();
  if (active) {
    store.set({
      baseUrl: "https://ai.example.com",
      token: "tok",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proxyOrigin: "http://127.0.0.1:1",
    });
  }
  return store;
}

function setupFiles() {
  const imports: Array<{ sourceKey: string; originalName: string; buffer: Buffer; mime?: string }> = [];
  const files = {
    importFile: vi.fn(async (input: { sourceKey: string; originalName: string; buffer: Buffer; mime?: string }) => {
      imports.push(input);
      return { fileEntryId: `entry-${String(imports.length)}`, contentHash: `hash-${String(imports.length)}` };
    }),
  };
  return { files: files as unknown as FilesService, imports };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlidesStyleImageGenerator", () => {
  it("generates candidates in parallel and imports each with idempotent source keys", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      // 第一张走 b64、第二张走 url 下载，两条路径都覆盖。
      if (url.endsWith("/images/generations")) {
        return fakeResponse({ data: [{ b64_json: Buffer.from("png-bytes-1").toString("base64") }] });
      }
      return fakeResponse({ data: [{ b64_json: Buffer.from("png-bytes-2").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    const results = await generator.generateOverviewImages({ prompt: "深色科技风 PPT 样张", count: 2, idempotencyKey: "run-1" });

    expect(results).toHaveLength(2);
    expect(calls[0]).toBe("https://ai.example.com/v1/images/generations");
    expect(imports).toHaveLength(2);
    expect(imports[0]?.sourceKey).toBe("slides-style:run-1:0");
    expect(imports[1]?.sourceKey).toBe("slides-style:run-1:1");
    expect(imports.every((item) => item.mime === "image/png")).toBe(true);
  });

  it("names jpeg results by magic bytes", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const fetchImpl = vi.fn(async () => fakeResponse({ data: [{ b64_json: jpegHeader.toString("base64") }] }));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    await generator.generateOverviewImages({ prompt: "p", count: 1, idempotencyKey: "k" });

    expect(imports[0]?.mime).toBe("image/jpeg");
    expect(imports[0]?.originalName.endsWith(".jpg")).toBe(true);
  });

  it("rejects when the relay session is absent", async () => {
    const store = setupStore(false);
    const { files } = setupFiles();
    const generator = new SlidesStyleImageGenerator(store, files, vi.fn() as unknown as typeof fetch);
    await expect(generator.generateOverviewImages({ prompt: "p", count: 1, idempotencyKey: "k" }))
      .rejects.toThrow(/中转会话不可用/);
  });

  it("surfaces generation HTTP failures", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    const fetchImpl = vi.fn(async () => fakeResponse({ error: "boom" }, false, 504));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);
    await expect(generator.generateOverviewImages({ prompt: "p", count: 1, idempotencyKey: "k" }))
      .rejects.toThrow(/HTTP 504/);
  });

  it("clamps candidate count into 1..4", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    const fetchImpl = vi.fn(async () => fakeResponse({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);
    await generator.generateOverviewImages({ prompt: "p", count: 99, idempotencyKey: "k" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
