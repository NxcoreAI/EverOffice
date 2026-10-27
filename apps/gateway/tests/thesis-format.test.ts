import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { ThesisFormatCardStore } from "../src/modules/thesis-format/card-store.js";
import { thesisFormatRoutes } from "../src/modules/thesis-format/routes.js";
import type { ThesisFormatService } from "../src/modules/thesis-format/service.js";
import { validateThesisFormatCard } from "../src/modules/thesis-format/validate.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const logger = { info: () => undefined, warn: () => undefined };

/** 仓库 agents/ 目录的 thesis-formatter 包必须能被注册器完整加载（守卫 agent.yaml/schema 改坏）。 */
describe("thesis-formatter agent bundle", () => {
  it("loads from the repository agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-agents-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const registry = new SubagentRegistry(database.db, {
        enabled: true,
        definitionsDir: resolve(join(process.cwd(), "..", "..", "agents")),
        runtimeDir: join(root, "runtime"),
        defaultTimeoutMs: 30_000,
        maxConcurrent: 4,
      }, { search: { url: "https://mcp.example.test", headers: { Authorization: "test-secret" } } }, logger);
      await registry.initialize();
      const definition = registry.get("thesis-formatter");
      expect(definition).toBeTruthy();
      expect(definition?.revision.inputSchema).toBeTruthy();
      expect(definition?.revision.outputSchema).toBeTruthy();
      expect(definition?.revision.policy.allowedCallers).toContain("internal-workflow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ThesisFormatCardStore (multi-card)", () => {
  it("upserts per (scope, sourceName), lists, resolves by id and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-cards-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.zip");
      const a1 = store.upsertInScope({ scope: WORKSPACE_DOCUMENT_CHANNEL, card: card(), sourceFileEntryId: null, sourceName: "A.docx" });
      const b1 = store.upsertInScope({ scope: WORKSPACE_DOCUMENT_CHANNEL, card: card(), sourceFileEntryId: null, sourceName: "B.docx" });
      const a2 = store.upsertInScope({ scope: WORKSPACE_DOCUMENT_CHANNEL, card: card(), sourceFileEntryId: "entry-1", sourceName: "A.docx" });
      expect(a2.id).toBe(a1.id);
      expect(store.listInScope(WORKSPACE_DOCUMENT_CHANNEL)).toHaveLength(2);
      expect(store.latestInScope(WORKSPACE_DOCUMENT_CHANNEL)?.id).toBe(a2.id);
      expect(store.byIdInScope(WORKSPACE_DOCUMENT_CHANNEL, b1.id)?.sourceName).toBe("B.docx");
      expect(store.removeInScope(WORKSPACE_DOCUMENT_CHANNEL, b1.id)).toBe(true);
      expect(store.removeInScope(WORKSPACE_DOCUMENT_CHANNEL, b1.id)).toBe(false);
      expect(store.listInScope(WORKSPACE_DOCUMENT_CHANNEL)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Room 已删除：工作区 scope 与旧 roomId scope 互不串卡（旧 roomId 行走兼容别名仍可读）", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-cards-scope-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.zip");
      const workspaceCard = store.upsertInScope({ scope: WORKSPACE_DOCUMENT_CHANNEL, card: card(), sourceFileEntryId: null, sourceName: "工作区.docx" });
      const legacyCard = store.upsert({ roomId: "room-legacy", card: card(), sourceFileEntryId: null, sourceName: "旧房间.docx" });
      expect(store.listInScope(WORKSPACE_DOCUMENT_CHANNEL).map((row) => row.id)).toEqual([workspaceCard.id]);
      expect(store.list("room-legacy").map((row) => row.id)).toEqual([legacyCard.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** 路由只消费注入的 service：用假实现跑 HTTP 契约（scope 归一 / 旧路径兼容）。 */
function routeHarness() {
  const calls: Array<{ method: string; scope: string }> = [];
  const card = validateThesisFormatCard({}, "模版.docx");
  const service = {
    cardStore: () => ({
      listInScope: (scope: string) => {
        calls.push({ method: "list", scope });
        return [];
      },
    }),
    parseFromLibrary: async (scope: string, fileEntryId: string) => {
      calls.push({ method: "parse", scope });
      return { cardId: `card-${fileEntryId}`, sourceName: "模版.docx", card };
    },
    parseFromUpload: async (scope: string, _bytes: Buffer, name: string) => {
      calls.push({ method: "upload", scope });
      return { cardId: "card-upload", sourceName: name, card };
    },
    removeCard: (scope: string, cardId: string) => {
      calls.push({ method: "remove", scope });
      return cardId === "card-1";
    },
    reformat: async (scope: string) => {
      calls.push({ method: "reformat", scope });
      return { fileEntryId: "fe-1", originalName: "论文-排版版.docx" };
    },
  } as unknown as ThesisFormatService;
  return { calls, service };
}

describe("thesis-format 路由（工作区作用域 + 旧 Room 兼容）", () => {
  it("工作区入口把 scope 归一为 WORKSPACE_DOCUMENT_CHANNEL；旧 /rooms/:roomId 路径把 roomId 当 scope", async () => {
    const { calls, service } = routeHarness();
    const app = Fastify();
    try {
      await app.register(thesisFormatRoutes(service));

      const list = await app.inject({ method: "GET", url: "/v1/thesis-format/cards" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);

      const remove = await app.inject({ method: "DELETE", url: "/v1/thesis-format/cards/card-1" });
      expect(remove.statusCode).toBe(200);
      expect(remove.json()).toEqual({ removed: true });

      const removeMissing = await app.inject({ method: "DELETE", url: "/v1/thesis-format/cards/card-missing" });
      expect(removeMissing.statusCode).toBe(404);

      const parse = await app.inject({
        method: "POST",
        url: "/v1/thesis-format/parse",
        payload: { fileEntryId: "entry-1" },
      });
      expect(parse.statusCode).toBe(200);
      expect(parse.json()).toMatchObject({ cardId: "card-entry-1", sourceName: "模版.docx" });

      const reformat = await app.inject({
        method: "POST",
        url: "/v1/thesis-format/reformat",
        payload: { fileEntryId: "entry-1" },
      });
      expect(reformat.statusCode).toBe(200);
      expect(reformat.json()).toEqual({ fileEntryId: "fe-1", originalName: "论文-排版版.docx" });

      // 旧路径：roomId 直接作为 scope（兼容旧数据），不映射到工作区。
      const legacy = await app.inject({ method: "GET", url: "/v1/thesis-format/rooms/room-legacy/cards" });
      expect(legacy.statusCode).toBe(200);
      expect(calls.map((call) => call.scope)).toEqual([
        WORKSPACE_DOCUMENT_CHANNEL,
        WORKSPACE_DOCUMENT_CHANNEL,
        WORKSPACE_DOCUMENT_CHANNEL,
        WORKSPACE_DOCUMENT_CHANNEL,
        WORKSPACE_DOCUMENT_CHANNEL,
        "room-legacy",
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("validateThesisFormatCard", () => {
  it("fills Chinese thesis defaults for an empty card", () => {
    const card = validateThesisFormatCard({}, "模版.zip");
    expect(card.page.marginTopMm).toBe(25);
    expect(card.base.font.eastAsia).toBe("宋体");
    expect(card.base.font.size).toBe(12);
    expect(card.base.paragraph.lineSpacingMultiple).toBe(1.25);
    expect(card.footer.frontMatterFormat).toBe("roman");
    expect(card.parts.map((part) => part.type)).toEqual([
      "cover", "commitment", "abstract_zh", "abstract_en", "toc",
      "chapter", "appendix", "references", "acknowledgement", "achievements",
    ]);
  });

  it("resolves Chinese size names to pt and keeps explicit values", () => {
    const card = validateThesisFormatCard({
      headings: [{ level: 1, font: { eastAsia: "黑体", ascii: "Times New Roman", size: "小二", bold: true } }],
      page: { marginTopMm: 30 },
    }, "模版.docx");
    expect(card.headings[0]?.font.size).toBe(18);
    expect(card.page.marginTopMm).toBe(30);
  });

  it("rejects invalid size values", () => {
    expect(() => validateThesisFormatCard({ base: { font: { size: "十七号" } } }, "模版.docx"))
      .toThrow(/字号非法/);
  });
});
