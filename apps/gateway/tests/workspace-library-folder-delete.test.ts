import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { SpaceLibraryWriter } from "../src/modules/workspace-layout/library.js";
import { WorkspaceLayoutService } from "../src/modules/workspace-layout/service.js";

/**
 * 资料页「删除文件夹」（虚拟目录按前缀批量删除）验收：
 * - 段边界：删 `docs/api` 不碰 `docs/apiary/**`；
 * - 递归：子文件夹内文件一并删除，磁盘文件进空间回收站（可恢复）；
 * - 空目录树移除、非空目录（含未入库文件）保留；
 * - 非法路径（根/..）直接拒绝。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function spaceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-folder-delete-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const layout = new WorkspaceLayoutService({ dataDir });
  const writer = new SpaceLibraryWriter(database.db, dataDir, layout);
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  files.setSpaceLibrary(writer);

  const spaceId = "ws-folder-delete";
  const provisioned = layout.provision({ spaceId, name: "Folder delete test", rootMode: "managed" });
  database.db.insert(agentWorkspaces).values({
    id: spaceId,
    name: "Folder delete test",
    description: null,
    goals: [],
    path: provisioned.paths.root,
    slug: provisioned.marker.slug,
    rootMode: "managed",
    layoutVersion: 2,
    kind: "custom",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastOpenedAt: new Date(),
  }).run();

  return { ...database, files, spaceId, root: provisioned.paths.root };
}

/** 导入一份文件并把 relativePath 直接改到指定子目录（导入固定平铺，目录靠移动模拟）。 */
async function importAt(
  test: Awaited<ReturnType<typeof spaceForTest>>,
  name: string,
  relativePath: string,
  contents = "# x",
) {
  const imported = await test.files.importFile({
    sourceKind: "manual-upload",
    sourceKey: `upload:${name}`,
    originalName: name,
    workspaceId: test.spaceId,
    buffer: Buffer.from(contents, "utf8"),
  });
  const current = await test.files.catalogEntry(imported.fileEntryId);
  const from = join(test.root, current!.relativePath!);
  const to = join(test.root, relativePath);
  await mkdir(join(to, ".."), { recursive: true });
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
  const { eq } = await import("drizzle-orm");
  const { fileEntries } = await import("../src/infrastructure/database/schema.js");
  test.db.update(fileEntries).set({ relativePath })
    .where(eq(fileEntries.id, imported.fileEntryId)).run();
  return imported.fileEntryId;
}

describe("delete folder by prefix (资料页删除文件夹)", () => {
  it("deletes every entry under the folder, trashes disk files, and removes empty dirs", async () => {
    const test = await spaceForTest();
    await importAt(test, "spec.md", "docs/api/spec.md");
    await importAt(test, "guide.md", "docs/api/deep/guide.md");
    await importAt(test, "notes.md", "docs/notes.md");
    await importAt(test, "root.md", "root.md");

    const result = await test.files.deleteFolderByPrefix(test.spaceId, "docs/api");

    expect(result).toEqual({ deleted: 2, failed: 0, removedEmptyDirs: true });
    // 磁盘：目录树移除，回收站收到两份文件，其他文件原位不动。
    expect(existsSync(join(test.root, "docs", "api"))).toBe(false);
    expect(existsSync(join(test.root, "docs", "notes.md"))).toBe(true);
    expect(existsSync(join(test.root, "root.md"))).toBe(true);
    // DB：前缀内条目消失，范围外保留。
    const remaining = test.files.listCatalog(50, 0, { workspaceId: test.spaceId });
    expect(remaining.items.map((item) => item.relativePath).sort())
      .toEqual(["docs/notes.md", "root.md"]);
    // 回收站里能找回（可恢复语义）。
    const trash = join(test.root, ".everoffice", "trash");
    expect(existsSync(trash)).toBe(true);
  });

  it("respects segment boundaries: docs/api must not swallow docs/apiary", async () => {
    const test = await spaceForTest();
    await importAt(test, "spec.md", "docs/api/spec.md");
    await importAt(test, "plan.md", "docs/apiary/plan.md");

    const result = await test.files.deleteFolderByPrefix(test.spaceId, "docs/api");

    expect(result.deleted).toBe(1);
    expect(existsSync(join(test.root, "docs", "apiary", "plan.md"))).toBe(true);
    expect(existsSync(join(test.root, "docs", "api"))).toBe(false);
    const remaining = test.files.listCatalog(50, 0, { workspaceId: test.spaceId });
    expect(remaining.items.map((item) => item.relativePath)).toEqual(["docs/apiary/plan.md"]);
  });

  it("keeps the directory when it still has unknown (non-indexed) files", async () => {
    const test = await spaceForTest();
    await importAt(test, "spec.md", "docs/spec.md");
    // 用户自己放进目录、未入库的文件：删除文件夹后必须留在原地。
    await writeFile(join(test.root, "docs", "user-own.txt"), "keep me", "utf8");

    const result = await test.files.deleteFolderByPrefix(test.spaceId, "docs");

    expect(result.deleted).toBe(1);
    expect(result.removedEmptyDirs).toBe(false);
    expect(existsSync(join(test.root, "docs", "user-own.txt"))).toBe(true);
    expect(existsSync(join(test.root, "docs", "spec.md"))).toBe(false);
  });

  it("deleting an empty folder (no indexed entries) is a no-op that removes the dir", async () => {
    const test = await spaceForTest();
    await mkdir(join(test.root, "empty-dir", "nested"), { recursive: true });

    const result = await test.files.deleteFolderByPrefix(test.spaceId, "empty-dir");

    expect(result).toEqual({ deleted: 0, failed: 0, removedEmptyDirs: true });
    expect(existsSync(join(test.root, "empty-dir"))).toBe(false);
  });

  it("rejects root and traversal paths", async () => {
    const test = await spaceForTest();
    await importAt(test, "root.md", "root.md");
    await importAt(test, "spec.md", "docs/spec.md");

    // 根目录不可整删（service 层归一化为空 → 无条目命中）。
    expect((await test.files.deleteFolderByPrefix(test.spaceId, "/")).deleted).toBe(0);
    expect((await test.files.deleteFolderByPrefix(test.spaceId, "..")).deleted).toBe(0);
    // 一切原样。
    expect(test.files.listCatalog(50, 0, { workspaceId: test.spaceId }).total).toBe(2);
    expect(existsSync(join(test.root, "docs", "spec.md"))).toBe(true);
  });

  it("only touches entries in the given workspace", async () => {
    const test = await spaceForTest();
    await importAt(test, "spec.md", "docs/spec.md");
    // 另一个空间里同前缀的文件不受影响：直接把条目挪到别的 workspace。
    const { eq } = await import("drizzle-orm");
    const { fileEntries } = await import("../src/infrastructure/database/schema.js");
    const row = test.db.select().from(fileEntries)
      .where(eq(fileEntries.relativePath, "docs/spec.md")).get()!;
    test.db.update(fileEntries).set({ workspaceId: "ws-other" })
      .where(eq(fileEntries.id, row.id)).run();

    const result = await test.files.deleteFolderByPrefix(test.spaceId, "docs");

    expect(result.deleted).toBe(0);
    expect(existsSync(join(test.root, "docs", "spec.md"))).toBe(true);
  });
});
