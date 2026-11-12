import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 云文档 ↔ 工作空间绑定索引（JSON，不落库、不做 DB migration）。
 *
 * 用户明确选择「每个工作空间一个 JSON 文件」而不是给 documents 表加 workspaceId 列：
 * 文稿内容/版本仍在 SQLite 里，绑定关系只是 dataDir 下的旁挂索引，删除/重建索引
 * 不会伤到文稿本体。布局：
 *
 *   <dataDir>/documents-workspaces/<encodeURIComponent(workspaceId)>.json
 *   { "version": 1, "workspaceId": "ws-xxx", "documents": ["<documentId>", ...] }
 *
 * 纪律（与 workspace-layout/markers.ts 一致）：
 * - 原子写（同目录 tmp + rename），不允许半截 JSON 落盘；
 * - 单会员：bind 会先把 id 从其它 workspace 文件里移除，再写入目标文件；
 * - 读取宽容：缺失目录/损坏 JSON/非法形状一律跳过，不让索引故障拖垮文稿库；
 * - 缓存：进程内单实例持有内存镜像（网关是唯一写者），启动时惰性加载一次。
 *
 * 旧数据（本索引上线前创建的文稿）没有绑定；网关启动时由
 * `migrateLegacyUnbound` 统一归入 `default` 工作空间。
 */

/** 索引目录名（<gateway dataDir> 下）。 */
export const DOCUMENT_WORKSPACES_DIRNAME = "documents-workspaces";

/** 旧数据（未绑定文稿）迁移去向；工作台缺省工作空间的稳定 id 也是它。 */
export const DEFAULT_DOCUMENT_WORKSPACE_ID = "default";

/** 单文件形状（version 只增不改语义；更高版本按同形状尽力读取）。 */
export interface DocumentWorkspaceIndexFile {
  version: number;
  workspaceId: string;
  documents: string[];
}

function normalizeWorkspaceId(workspaceId: string | null | undefined): string {
  return typeof workspaceId === "string" ? workspaceId.trim() : "";
}

export class DocumentWorkspaceIndex {
  private readonly directory: string;
  /** workspaceId → documentId 集合（进程内权威镜像）。 */
  private readonly workspaces = new Map<string, Set<string>>();
  private loaded = false;

  constructor(private readonly dataDir: string) {
    this.directory = join(dataDir, DOCUMENT_WORKSPACES_DIRNAME);
  }

  /** 绑定：单会员（先移出其它工作空间，再写入目标工作空间）。空 workspaceId = 解绑。 */
  bind(documentId: string, workspaceId: string): void {
    const id = typeof documentId === "string" ? documentId.trim() : "";
    if (!id) return;
    const target = normalizeWorkspaceId(workspaceId);
    if (!target) {
      this.unbind(id);
      return;
    }
    this.ensureLoaded();
    const changed: string[] = [];
    let alreadyBound = false;
    for (const [workspace, ids] of this.workspaces) {
      if (workspace === target) {
        if (ids.has(id)) alreadyBound = true;
        continue;
      }
      if (ids.delete(id)) changed.push(workspace);
    }
    if (!alreadyBound) this.setOf(target).add(id);
    if (changed.length === 0 && alreadyBound) return;
    for (const workspace of changed) this.persist(workspace);
    this.persist(target);
  }

  /** 解绑：从所有工作空间文件移除该文稿（回收站保留绑定，仅永久删除调用）。 */
  unbind(documentId: string): void {
    const id = typeof documentId === "string" ? documentId.trim() : "";
    if (!id) return;
    this.ensureLoaded();
    const changed: string[] = [];
    for (const [workspace, ids] of this.workspaces) {
      if (ids.delete(id)) changed.push(workspace);
    }
    for (const workspace of changed) this.persist(workspace);
  }

  /** 某工作空间的文稿 id 集合（返回副本，调用方不可改内存镜像）。 */
  listIds(workspaceId: string | null | undefined): Set<string> {
    this.ensureLoaded();
    const workspace = normalizeWorkspaceId(workspaceId);
    if (!workspace) return new Set();
    return new Set(this.workspaces.get(workspace) ?? []);
  }

  /** 文稿归属的工作空间；null = 旧版未绑定（网关启动迁移后应只剩 default）。 */
  workspaceOf(documentId: string): string | null {
    const id = typeof documentId === "string" ? documentId.trim() : "";
    if (!id) return null;
    this.ensureLoaded();
    for (const [workspace, ids] of this.workspaces) {
      if (ids.has(id)) return workspace;
    }
    return null;
  }

  /**
   * 启动迁移：把「当前库里存在、但索引里没有归属」的旧文稿统一绑到 default。
   * 返回本次迁入的文稿数（幂等：第二次启动返回 0）。
   */
  migrateLegacyUnbound(
    documentIds: readonly string[],
    defaultWorkspaceId: string = DEFAULT_DOCUMENT_WORKSPACE_ID,
  ): number {
    this.ensureLoaded();
    const target = normalizeWorkspaceId(defaultWorkspaceId) || DEFAULT_DOCUMENT_WORKSPACE_ID;
    const bound = new Set<string>();
    for (const ids of this.workspaces.values()) {
      for (const id of ids) bound.add(id);
    }
    const pending: string[] = [];
    const seen = new Set<string>();
    for (const raw of documentIds) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (!id || seen.has(id) || bound.has(id)) continue;
      seen.add(id);
      pending.push(id);
    }
    if (pending.length === 0) return 0;
    const targetSet = this.setOf(target);
    for (const id of pending) targetSet.add(id);
    this.persist(target);
    return pending.length;
  }

  /** 索引目录（测试/排障用）。 */
  get indexPath(): string {
    return this.directory;
  }

  private setOf(workspaceId: string): Set<string> {
    let ids = this.workspaces.get(workspaceId);
    if (!ids) {
      ids = new Set();
      this.workspaces.set(workspaceId, ids);
    }
    return ids;
  }

  private pathFor(workspaceId: string): string {
    // encodeURIComponent 不会转义 "."，而 ".." 会逃出索引目录；点号一并编码。
    const safe = encodeURIComponent(workspaceId).replace(/\./g, "%2E");
    return join(this.directory, `${safe}.json`);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      mkdirSync(this.directory, { recursive: true });
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const workspaceFromName = decodeWorkspaceFileName(name);
      const file = this.readIndexFile(join(this.directory, name));
      if (!file) continue;
      const workspaceId = normalizeWorkspaceId(file.workspaceId) || workspaceFromName;
      if (!workspaceId) continue;
      const ids = this.setOf(workspaceId);
      for (const raw of file.documents) {
        const id = typeof raw === "string" ? raw.trim() : "";
        // 单会员兜底：重复/跨文件脏数据按「先读到者为准」，不再重复归属。
        if (id) ids.add(id);
      }
    }
    // 跨文件重复 id 归一到第一个（按文件名排序）出现的工作空间。
    const assigned = new Set<string>();
    for (const workspace of [...this.workspaces.keys()].sort()) {
      const ids = this.workspaces.get(workspace)!;
      for (const id of ids) {
        if (assigned.has(id)) {
          ids.delete(id);
        } else {
          assigned.add(id);
        }
      }
    }
  }

  /** 宽容读取：缺失/损坏/形状非法一律返回 null（跳过该文件）。 */
  private readIndexFile(path: string): DocumentWorkspaceIndexFile | null {
    let text: string;
    try {
      if (!existsSync(path)) return null;
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const shape = parsed as Record<string, unknown>;
    if (!Array.isArray(shape.documents)) return null;
    return {
      version: typeof shape.version === "number" ? shape.version : 1,
      workspaceId: typeof shape.workspaceId === "string" ? shape.workspaceId : "",
      documents: shape.documents.filter((value): value is string => typeof value === "string"),
    };
  }

  /** 原子写：tmp + rename；空集合直接删文件（不留空壳）。 */
  private persist(workspaceId: string): void {
    const ids = this.workspaces.get(workspaceId);
    const target = this.pathFor(workspaceId);
    if (!ids || ids.size === 0) {
      this.workspaces.delete(workspaceId);
      try {
        unlinkSync(target);
      } catch {
        // 文件本就不存在（或删除失败）：下次写入会补上，不影响内存镜像。
      }
      return;
    }
    const payload: DocumentWorkspaceIndexFile = {
      version: 1,
      workspaceId,
      documents: [...ids].sort(),
    };
    try {
      mkdirSync(this.directory, { recursive: true });
    } catch {
      return;
    }
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // 临时文件清理失败不影响主流程。
      }
      throw error;
    }
  }
}

function decodeWorkspaceFileName(name: string): string {
  try {
    return decodeURIComponent(name.slice(0, -".json".length));
  } catch {
    return "";
  }
}
