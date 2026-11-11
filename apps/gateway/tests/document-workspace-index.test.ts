import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_WORKSPACES_DIRNAME,
  DocumentWorkspaceIndex,
} from "../src/modules/documents/workspace-index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-workspaces-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function indexFileOf(dataDir: string, workspaceId: string): string {
  return join(dataDir, DOCUMENT_WORKSPACES_DIRNAME, `${encodeURIComponent(workspaceId)}.json`);
}

function readIndexFile(dataDir: string, workspaceId: string): {
  version: number;
  workspaceId: string;
  documents: string[];
} {
  return JSON.parse(readFileSync(indexFileOf(dataDir, workspaceId), "utf8")) as {
    version: number;
    workspaceId: string;
    documents: string[];
  };
}

describe("DocumentWorkspaceIndex（云文档 ↔ 工作空间 JSON 索引）", () => {
  it("bind 落盘单会员：重复绑定同一工作空间幂等，换绑会从旧工作空间移除", async () => {
    const dataDir = await createDataDir();
    const index = new DocumentWorkspaceIndex(dataDir);

    index.bind("doc-a", "ws-1");
    expect(index.listIds("ws-1")).toEqual(new Set(["doc-a"]));
    expect(index.workspaceOf("doc-a")).toBe("ws-1");
    expect(readIndexFile(dataDir, "ws-1")).toEqual({
      version: 1,
      workspaceId: "ws-1",
      documents: ["doc-a"],
    });

    // 幂等：再次绑定同一工作空间不重复写入。
    index.bind("doc-a", "ws-1");
    expect(index.listIds("ws-1")).toEqual(new Set(["doc-a"]));

    // 换绑：先移出旧工作空间，再写目标工作空间（单会员）。
    index.bind("doc-a", "ws-2");
    expect(index.listIds("ws-1")).toEqual(new Set());
    expect(index.listIds("ws-2")).toEqual(new Set(["doc-a"]));
    expect(index.workspaceOf("doc-a")).toBe("ws-2");
    // 空集合不留空壳文件。
    expect(existsSync(indexFileOf(dataDir, "ws-1"))).toBe(false);
    expect(readIndexFile(dataDir, "ws-2")).toEqual({
      version: 1,
      workspaceId: "ws-2",
      documents: ["doc-a"],
    });
  });

  it("同一工作空间多文稿排序稳定，unbind 逐个移除并在空集合时删文件", async () => {
    const dataDir = await createDataDir();
    const index = new DocumentWorkspaceIndex(dataDir);

    index.bind("doc-c", "ws-1");
    index.bind("doc-a", "ws-1");
    index.bind("doc-b", "ws-1");
    expect(index.listIds("ws-1")).toEqual(new Set(["doc-a", "doc-b", "doc-c"]));
    expect(readIndexFile(dataDir, "ws-1").documents).toEqual(["doc-a", "doc-b", "doc-c"]);

    index.unbind("doc-b");
    expect(index.listIds("ws-1")).toEqual(new Set(["doc-a", "doc-c"]));
    expect(index.workspaceOf("doc-b")).toBeNull();
    expect(readIndexFile(dataDir, "ws-1").documents).toEqual(["doc-a", "doc-c"]);

    index.unbind("doc-x");
    expect(index.workspaceOf("doc-x")).toBeNull();

    index.unbind("doc-a");
    index.unbind("doc-c");
    expect(index.listIds("ws-1")).toEqual(new Set());
    expect(existsSync(indexFileOf(dataDir, "ws-1"))).toBe(false);
  });

  it("migrateLegacyUnbound 只迁未绑定文稿到 default，幂等且不抢已绑定归属", async () => {
    const dataDir = await createDataDir();
    const index = new DocumentWorkspaceIndex(dataDir);

    index.bind("doc-bound", "ws-2");
    const migrated = index.migrateLegacyUnbound(["doc-bound", "doc-legacy-1", "doc-legacy-2"]);
    expect(migrated).toBe(2);
    expect(index.listIds("default")).toEqual(new Set(["doc-legacy-1", "doc-legacy-2"]));
    expect(index.workspaceOf("doc-legacy-1")).toBe("default");
    expect(index.workspaceOf("doc-bound")).toBe("ws-2");
    expect(readIndexFile(dataDir, "default")).toEqual({
      version: 1,
      workspaceId: "default",
      documents: ["doc-legacy-1", "doc-legacy-2"],
    });

    // 幂等：第二次迁移不再计入，已绑定文稿归属不变。
    expect(index.migrateLegacyUnbound(["doc-bound", "doc-legacy-1", "doc-legacy-2"])).toBe(0);
    expect(index.migrateLegacyUnbound([])).toBe(0);
  });

  it("索引持久化：新实例从磁盘恢复绑定（模拟网关重启）", async () => {
    const dataDir = await createDataDir();
    const first = new DocumentWorkspaceIndex(dataDir);
    first.bind("doc-a", "ws-1");
    first.bind("doc-b", "ws-2");

    const second = new DocumentWorkspaceIndex(dataDir);
    expect(second.workspaceOf("doc-a")).toBe("ws-1");
    expect(second.workspaceOf("doc-b")).toBe("ws-2");
    expect(second.listIds("ws-1")).toEqual(new Set(["doc-a"]));
    expect(second.listIds("ws-2")).toEqual(new Set(["doc-b"]));
    expect(second.migrateLegacyUnbound(["doc-a", "doc-b"])).toBe(0);
  });

  it("损坏 / 缺失 / 形状非法的 JSON 文件被跳过（不抛错、不误绑）", async () => {
    const dataDir = await createDataDir();
    const directory = join(dataDir, DOCUMENT_WORKSPACES_DIRNAME);
    await mkdir(directory, { recursive: true });
    // 半截 JSON（模拟非原子写/手改损坏）。
    await writeFile(join(directory, "ws-broken.json"), "{ \"version\": 1, ", "utf8");
    // 合法 JSON 但形状非法（documents 不是数组）。
    await writeFile(join(directory, "ws-shape.json"), JSON.stringify({ version: 1, documents: "nope" }), "utf8");
    // 文件名不可解码（% 非法）但内容是合法 JSON：以 payload 的 workspaceId 为准。
    await writeFile(
      join(directory, "bad%-name.json"),
      JSON.stringify({ version: 1, workspaceId: "ws-from-payload", documents: ["doc-ok"] }),
      "utf8",
    );

    const index = new DocumentWorkspaceIndex(dataDir);
    expect(index.workspaceOf("doc-ok")).toBe("ws-from-payload");
    expect(index.listIds("ws-broken")).toEqual(new Set());
    expect(index.listIds("ws-shape")).toEqual(new Set());
    // 损坏文件不参与迁移判定：doc-ok 已绑定，不会被误迁 default。
    expect(index.migrateLegacyUnbound(["doc-ok", "doc-unbound"])).toBe(1);
    expect(index.listIds("default")).toEqual(new Set(["doc-unbound"]));

    // 缺失目录：全新 dataDir 也能正常读取/写入。
    const emptyDataDir = await createDataDir();
    const fresh = new DocumentWorkspaceIndex(emptyDataDir);
    expect(fresh.listIds("ws-1")).toEqual(new Set());
    expect(fresh.workspaceOf("doc-a")).toBeNull();
    fresh.bind("doc-a", "ws-1");
    expect(fresh.workspaceOf("doc-a")).toBe("ws-1");
  });

  it("workspaceId 含特殊字符时用 encodeURIComponent 文件名，不影响其它工作空间", async () => {
    const dataDir = await createDataDir();
    const index = new DocumentWorkspaceIndex(dataDir);
    index.bind("doc-a", "ws/带 空格");
    index.bind("doc-b", "ws-2");
    expect(index.workspaceOf("doc-a")).toBe("ws/带 空格");
    expect(existsSync(indexFileOf(dataDir, "ws/带 空格"))).toBe(true);
    expect(index.workspaceOf("doc-b")).toBe("ws-2");

    // 重启后按文件名解码恢复。
    const reopened = new DocumentWorkspaceIndex(dataDir);
    expect(reopened.workspaceOf("doc-a")).toBe("ws/带 空格");
    expect(reopened.listIds("ws-2")).toEqual(new Set(["doc-b"]));
  });
});
