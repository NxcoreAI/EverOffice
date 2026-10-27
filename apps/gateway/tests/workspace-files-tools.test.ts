import { describe, expect, it } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import {
  createWorkspaceFileCatalog,
  createWorkspaceFilesPiTools,
  type WorkspaceFileSource,
} from "../src/modules/agent/workspace-files-tools.js";
import { createWorkspaceImageMaterialSearch } from "../src/modules/subagents/workspace-materials.js";

const UPDATED_AT = "2026-10-27T06:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

interface Row {
  id: string;
  originalName: string;
  sharedTitle: string;
  relativePath: string | null;
  bytes: number;
  dataType: string | null;
  contentHash: string;
}

function sourceOf(rows: Row[]): WorkspaceFileSource {
  return {
    listCatalog: () => ({
      items: rows.map((row) => ({ ...row, updatedAt: UPDATED_AT })),
    }),
    catalogStoragePathOf: (fileEntryId) => `/data/files/${fileEntryId}`,
  };
}

const rows: Row[] = [
  {
    id: "img-1",
    originalName: "Cyplore_April26_Highres-25.jpg",
    sharedTitle: "Cyplore-25.jpg",
    relativePath: "八、补充材料/产品图/Cyplore_April26_Highres-25.jpg",
    bytes: 2048,
    dataType: "image",
    contentHash: HASH_A,
  },
  {
    id: "img-2",
    originalName: "现场照片.jpg",
    sharedTitle: "现场照片.jpg",
    relativePath: "产品图/现场照片.jpg",
    bytes: 4096,
    dataType: "image",
    contentHash: HASH_B,
  },
  // 同名同内容重复登记：素材检索应按引用去重。
  {
    id: "img-2-copy",
    originalName: "现场照片.jpg",
    sharedTitle: "现场照片.jpg",
    relativePath: "产品图/现场照片.jpg",
    bytes: 4096,
    dataType: "image",
    contentHash: HASH_B,
  },
  {
    id: "doc-1",
    originalName: "锥光 BP-1020.md",
    sharedTitle: "锥光 BP-1020",
    relativePath: "资料/锥光 BP-1020.md",
    bytes: 512,
    dataType: "document",
    contentHash: HASH_C,
  },
];

const input: StartRuntimeRunInput = {
  runId: "run-workspace-files",
  sessionId: "session-workspace-files",
  runtimeSessionRef: null,
  prompt: "",
  pageLabel: "Agent",
  roomId: null,
};

describe("workspace file catalog", () => {
  it("lists workspace images with a material ref and absolute path", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));

    const images = catalog.list({ kind: "image" });
    expect(images.map((entry) => entry.name)).toEqual(["Cyplore-25.jpg", "现场照片.jpg", "现场照片.jpg"]);
    expect(images[0]).toMatchObject({
      fileEntryId: "img-1",
      kind: "image",
      type: "image",
      bytes: 2048,
      updatedAt: UPDATED_AT,
      relativePath: "八、补充材料/产品图/Cyplore_April26_Highres-25.jpg",
      absolutePath: "/data/files/img-1",
      materialRef: `everroom-material://${HASH_A}`,
    });
  });

  it("filters by kind, query (name / display name / relative path), and limit", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));

    expect(catalog.list({ kind: "document" }).map((entry) => entry.name)).toEqual(["锥光 BP-1020"]);
    // 中文 2 字窗口命中相对路径里的「产品图」。
    expect(catalog.list({ kind: "image", query: "产品图" }).map((entry) => entry.fileEntryId))
      .toEqual(["img-1", "img-2", "img-2-copy"]);
    expect(catalog.list({ query: "Cyplore" }).map((entry) => entry.fileEntryId)).toEqual(["img-1"]);
    expect(catalog.list({ query: "BP-1020" }).map((entry) => entry.fileEntryId)).toEqual(["doc-1"]);
    expect(catalog.list({ kind: "image", limit: 1 })).toHaveLength(1);
    expect(catalog.list({ query: "不存在的名字" })).toEqual([]);
  });
});

describe("workspace_files_list tool", () => {
  it("returns the catalog as JSON content and rejects when the catalog is not ready", async () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));
    const [tool] = createWorkspaceFilesPiTools(() => catalog);
    expect(tool).toBeDefined();

    const result = await tool!.execute(input, { kind: "image", query: "产品" });
    const payload = JSON.parse(result.content) as {
      files: Array<{ fileEntryId: string; materialRef: string | null }>;
      total: number;
    };
    expect(payload.total).toBe(3);
    expect(payload.files[0]).toMatchObject({ fileEntryId: "img-1", materialRef: `everroom-material://${HASH_A}` });

    const [unavailable] = createWorkspaceFilesPiTools(() => null);
    await expect(unavailable!.execute(input, {})).rejects.toThrow("workspace_files_list 暂不可用");
  });
});

describe("workspace image material search", () => {
  it("returns deduped everroom-material hits for matching workspace images", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));
    const search = createWorkspaceImageMaterialSearch(() => catalog);

    const hits = search("现场", 6);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ref: `everroom-material://${HASH_B}`,
      kind: "photo",
      desc: "产品图/现场照片.jpg",
    });
    expect(search("现场", 6)).toEqual(hits);
    expect(search("", 3)).toEqual([]);
    expect(createWorkspaceImageMaterialSearch(() => null)("现场", 3)).toEqual([]);
  });
});
