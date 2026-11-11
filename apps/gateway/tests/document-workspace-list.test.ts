import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { documentRoutes } from "../src/modules/documents/routes.js";
import { DocumentService } from "../src/modules/documents/service.js";
import { DocumentWorkspaceIndex } from "../src/modules/documents/workspace-index.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function contentJson(text: string): TiptapJsonContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

interface Harness {
  service: DocumentService;
  index: DocumentWorkspaceIndex;
  db: ReturnType<typeof createDatabase>["db"];
  dataDir: string;
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-workspaces-list-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  disposables.push(() => database.sqlite.close());
  const index = new DocumentWorkspaceIndex(dataDir);
  const service = new DocumentService(
    database.db,
    new DocumentEventBroker(),
    undefined,
    undefined,
    undefined,
    undefined,
    index,
  );
  return { service, index, db: database.db, dataDir };
}

async function importDocument(harness: Harness, id: string, title: string) {
  return harness.service.import({
    id,
    roomId: null,
    title,
    contentJson: contentJson(title),
    origin: "native",
  });
}

describe("DocumentService 按工作空间列出云文档（JSON 索引绑定）", () => {
  it("按 workspaceId 过滤：只返回绑定该工作空间的文稿，DTO 带上 workspaceId", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    await importDocument(harness, "doc-b", "B 空间文稿");
    await importDocument(harness, "doc-legacy", "旧未绑定文稿");

    harness.service.bindDocumentWorkspace("doc-a", "ws-a");
    harness.service.bindDocumentWorkspace("doc-b", "ws-b");

    expect(harness.service.list(false, undefined, "ws-a").map((document) => document.id))
      .toEqual(["doc-a"]);
    expect(harness.service.list(false, undefined, "ws-b").map((document) => document.id))
      .toEqual(["doc-b"]);
    expect(harness.service.list(false, undefined, "ws-a")[0]).toMatchObject({
      id: "doc-a",
      workspaceId: "ws-a",
    });

    // 不传 workspaceId = 全部文稿（内部调用/旧桌面兼容），但仍带归属信息。
    const all = harness.service.list();
    expect(all.map((document) => document.id).sort()).toEqual(["doc-a", "doc-b", "doc-legacy"]);
    expect(all.find((document) => document.id === "doc-b")?.workspaceId).toBe("ws-b");
    // 旧未绑定文稿 workspaceId 为 null（契约里 null = legacy unbound）。
    expect(all.find((document) => document.id === "doc-legacy")?.workspaceId).toBeNull();

    // get() 也带归属（事件 payload 复用同一映射）。
    expect(harness.service.get("doc-a")).toMatchObject({ id: "doc-a", workspaceId: "ws-a" });
    expect(harness.service.get("doc-legacy")?.workspaceId).toBeNull();
  });

  it("default 工作空间包含旧版未绑定文稿，但不包含其它工作空间的文稿", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    await importDocument(harness, "doc-legacy", "旧未绑定文稿");
    harness.service.bindDocumentWorkspace("doc-a", "ws-a");

    expect(harness.service.list(false, undefined, "default").map((document) => document.id))
      .toEqual(["doc-legacy"]);
    // 绑定到 ws-a 的文稿不会出现在 default。
    expect(harness.service.list(false, undefined, "default").map((document) => document.id))
      .not.toContain("doc-a");
  });

  it("进回收站保留绑定（可恢复回原工作空间），永久删除才解绑", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    harness.service.bindDocumentWorkspace("doc-a", "ws-a");

    await harness.service.delete("doc-a");
    // 回收站里仍按原工作空间可见（恢复后不用重新绑定）。
    expect(harness.service.list(true, undefined, "ws-a").map((document) => document.id))
      .toEqual(["doc-a"]);
    expect(harness.service.list(true)[0]).toMatchObject({ id: "doc-a", workspaceId: "ws-a" });
    expect(harness.index.workspaceOf("doc-a")).toBe("ws-a");

    await harness.service.deletePermanently("doc-a");
    expect(harness.index.workspaceOf("doc-a")).toBeNull();
    expect(harness.service.list(true, undefined, "ws-a")).toEqual([]);
  });

  it("清空回收站同样解绑", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    harness.service.bindDocumentWorkspace("doc-a", "ws-a");
    await harness.service.delete("doc-a");

    await harness.service.emptyTrash();

    expect(harness.index.workspaceOf("doc-a")).toBeNull();
    expect(harness.service.list(true, undefined, "ws-a")).toEqual([]);
  });

  it("bindDocumentWorkspace(null/空串) = 解绑；换绑保持单会员", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    await importDocument(harness, "doc-b", "B 空间文稿");

    harness.service.bindDocumentWorkspace("doc-a", "ws-a");
    harness.service.bindDocumentWorkspace("doc-b", "ws-a");
    expect(harness.service.list(false, undefined, "ws-a").map((document) => document.id))
      .toEqual(["doc-a", "doc-b"]);

    harness.service.bindDocumentWorkspace("doc-b", "ws-b");
    expect(harness.service.list(false, undefined, "ws-a").map((document) => document.id))
      .toEqual(["doc-a"]);
    expect(harness.service.list(false, undefined, "ws-b").map((document) => document.id))
      .toEqual(["doc-b"]);

    harness.service.bindDocumentWorkspace("doc-a", null);
    expect(harness.service.list(false, undefined, "ws-a")).toEqual([]);
    expect(harness.index.workspaceOf("doc-a")).toBeNull();
  });

  it("启动迁移：未绑定旧文稿归入 default，幂等", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-legacy-1", "旧文稿 1");
    await importDocument(harness, "doc-legacy-2", "旧文稿 2");
    // 模拟网关重启：同一 dataDir/DB，新索引实例 + 启动迁移入口（create-server 同一方法）。
    const restartedIndex = new DocumentWorkspaceIndex(harness.dataDir);
    const restartedService = new DocumentService(
      harness.db,
      harness.service.broker,
      undefined,
      undefined,
      undefined,
      undefined,
      restartedIndex,
    );
    expect(restartedService.migrateLegacyDocumentWorkspaces()).toBe(2);
    expect(restartedService.list(false, undefined, "default").map((document) => document.id))
      .toEqual(["doc-legacy-1", "doc-legacy-2"]);
    expect(restartedService.migrateLegacyDocumentWorkspaces()).toBe(0);
  });
});

describe("GET /v1/documents?workspaceId=（HTTP 契约）", () => {
  it("按工作空间过滤；default 含旧版未绑定文稿；省略参数返回全部", async () => {
    const harness = await createHarness();
    await importDocument(harness, "doc-a", "A 空间文稿");
    await importDocument(harness, "doc-b", "B 空间文稿");
    await importDocument(harness, "doc-legacy", "旧未绑定文稿");
    harness.service.bindDocumentWorkspace("doc-a", "ws-a");
    harness.service.bindDocumentWorkspace("doc-b", "ws-b");

    const app = Fastify();
    await app.register(documentRoutes(harness.service));
    disposables.push(() => app.close());

    const scopedA = await app.inject({ method: "GET", url: "/v1/documents?workspaceId=ws-a" });
    expect(scopedA.statusCode).toBe(200);
    expect((scopedA.json() as Array<{ id: string }>).map((document) => document.id)).toEqual(["doc-a"]);

    const scopedDefault = await app.inject({ method: "GET", url: "/v1/documents?workspaceId=default" });
    expect((scopedDefault.json() as Array<{ id: string }>).map((document) => document.id))
      .toEqual(["doc-legacy"]);

    const all = await app.inject({ method: "GET", url: "/v1/documents" });
    expect((all.json() as Array<{ id: string }>).map((document) => document.id).sort())
      .toEqual(["doc-a", "doc-b", "doc-legacy"]);

    const trashed = await app.inject({ method: "GET", url: "/v1/documents?trashed=true&workspaceId=ws-a" });
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json()).toEqual([]);
  });
});
