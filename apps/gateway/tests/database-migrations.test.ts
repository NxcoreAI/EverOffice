import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("database migrations", () => {
  it("creates the document outbox polling index", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-outbox-index-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));

    const indexes = database.sqlite.prepare("PRAGMA index_list(jobs)").all() as Array<{ name: string }>;
    database.sqlite.close();

    expect(indexes.map((index) => index.name)).toContain("jobs_type_status_created_idx");
  });

  it("reconciles the pre-merge Yjs migration branch with the canonical schema", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-yjs-branch-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const beforeMerge = createDatabase(databasePath, migrationsDir);
    const now = Date.now();
    const content = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "preserved" }] }],
    });
    beforeMerge.sqlite.prepare(
      "INSERT INTO documents (id, title, content_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("document-1", "Preserved", content, 1, "active", now, now);
    beforeMerge.sqlite.prepare(
      "INSERT INTO doc_versions (id, document_id, version, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("version-1", "document-1", 1, "Preserved", content, now);

    beforeMerge.sqlite.exec("DROP TABLE runtime_config_store");
    beforeMerge.sqlite.exec("DROP TABLE agent_schedules");
    beforeMerge.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(1787320000000);
    beforeMerge.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ).run("pre-merge-yjs-history", 1787577820465);
    beforeMerge.sqlite.close();

    const upgraded = createDatabase(databasePath, migrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const ingestColumns = upgraded.sqlite.prepare("PRAGMA table_info(ingest_events)")
      .all() as Array<{ name: string }>;
    const preserved = upgraded.sqlite.prepare(
      "SELECT title, content_json FROM doc_versions WHERE id = ?",
    ).get("version-1");
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "runtime_config_store",
      "agent_schedules",
      "document_yjs_checkpoints",
      "document_yjs_updates",
      "document_yjs_versions",
    ]));
    expect(ingestColumns.map(({ name }) => name)).toContain("reinstated_at");
    expect(preserved).toEqual({ title: "Preserved", content_json: content });
  });

  it("upgrades databases that applied the legacy reality 0002 migration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const legacyMigrationsDir = join(dataDir, "legacy-migrations");
    await mkdir(join(legacyMigrationsDir, "meta"), { recursive: true });

    await Promise.all([
      copyFile(join(currentMigrationsDir, "0000_lush_maverick.sql"), join(legacyMigrationsDir, "0000_lush_maverick.sql")),
      copyFile(join(currentMigrationsDir, "0001_motionless_captain_marvel.sql"), join(legacyMigrationsDir, "0001_motionless_captain_marvel.sql")),
      copyFile(join(currentMigrationsDir, "0003_opposite_beast.sql"), join(legacyMigrationsDir, "0002_broken_clint_barton.sql")),
      writeFile(join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          { idx: 0, version: "6", when: 1786714543323, tag: "0000_lush_maverick", breakpoints: true },
          { idx: 1, version: "6", when: 1786721919374, tag: "0001_motionless_captain_marvel", breakpoints: true },
          { idx: 2, version: "6", when: 1786780256138, tag: "0002_broken_clint_barton", breakpoints: true },
        ],
      })),
    ]);

    createDatabase(databasePath, legacyMigrationsDir).sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const blockColumns = upgraded.sqlite.prepare("PRAGMA table_info(document_blocks)")
      .all() as Array<{ name: string }>;
    const documentColumns = upgraded.sqlite.prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const versionColumns = upgraded.sqlite.prepare("PRAGMA table_info(doc_versions)")
      .all() as Array<{ name: string }>;
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "documents",
      "document_blocks",
      "document_block_references",
      "document_operations",
      "document_operation_items",
      "document_operation_commands",
      "document_operation_events",
      "pending_agent_intents",
      "document_yjs_checkpoints",
    ]));
    for (const removedTable of [
      "document_patches",
      "document_patch_hunks",
      "doc_transactions",
      "doc_ops",
    ]) {
      expect(tables.map(({ name }) => name)).not.toContain(removedTable);
    }
    expect(blockColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "document_id",
      "block_id",
      "root_block_id",
      "sibling_index",
      "depth",
      "indexed_version",
    ]));
    expect(blockColumns.map(({ name }) => name)).not.toContain("id");
    expect(documentColumns.map(({ name }) => name)).toContain("content_schema_version");
    expect(versionColumns.map(({ name }) => name)).toContain("title");
  });

  it("clears the document domain at cutover while preserving Rooms and Agent sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-block-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const legacyMigrationsDir = join(dataDir, "legacy-migrations");
    await mkdir(join(legacyMigrationsDir, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile(join(currentMigrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter((entry) => entry.idx <= 12);
    await Promise.all(legacyEntries.map((entry) => copyFile(
      join(currentMigrationsDir, `${entry.tag}.sql`),
      join(legacyMigrationsDir, `${entry.tag}.sql`),
    )));
    await writeFile(join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({
      ...journal,
      entries: legacyEntries,
    }));

    const canonical = {
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { id: "preserved-block" },
        content: [{ type: "text", text: "canonical content" }],
      }],
    };
    const legacy = createDatabase(databasePath, legacyMigrationsDir);
    const now = Date.now();
    legacy.sqlite.prepare(
      "INSERT INTO context_rooms (id, title, kind, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("room-1", "Preserved Room", "workspace", "{}", 0, now, now);
    legacy.sqlite.prepare(
      "INSERT INTO agent_sessions (id, room_id, page_label, runtime_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("session-1", "room-1", "rooms", "test", "idle", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO agent_runs (id, session_id, idempotency_key, status, prompt, last_event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", "session-1", "run-key", "completed", "prompt", 0, now);
    legacy.sqlite.prepare(
      "INSERT INTO documents (id, title, content_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("doc-migrated", "Migrated", JSON.stringify(canonical), 1, "active", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO room_doc_links (room_id, document_id, linked_at) VALUES (?, ?, ?)",
    ).run("room-1", "doc-migrated", now);
    legacy.sqlite.prepare(
      "INSERT INTO doc_versions (id, document_id, version, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("version-1", "doc-migrated", 1, "Migrated", JSON.stringify(canonical), now);
    legacy.sqlite.prepare(
      "INSERT INTO document_blocks (document_id, block_id, parent_block_id, root_block_id, type, sibling_index, ordinal, path, depth, text_preview, indexed_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("doc-migrated", "stale-block", null, "stale-block", "paragraph", 0, 0, "[0]", 0, "stale", 1);
    legacy.sqlite.prepare(
      "INSERT INTO document_operations (id, capability_id, capability_version, interaction_mode, presenter_key, room_id, document_id, document_title, agent_session_id, run_id, base_version, status, revision, summary, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("operation-1", "document.edit", 1, "atomic_review", "atomic-diff", "room-1", "doc-migrated", "Migrated", "session-1", "run-1", 1, "awaiting_review", 1, "Review", "{}", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO pending_agent_intents (id, session_id, source_run_id, original_prompt, target_capability, allowed_room_ids, allowed_document_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("intent-1", "session-1", "run-1", "Edit", "document.edit", '["room-1"]', '["doc-migrated"]', now + 60_000, now);
    legacy.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    expect(upgraded.sqlite.prepare("SELECT * FROM documents").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM doc_versions").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM document_blocks").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM document_operations").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM pending_agent_intents").all()).toEqual([]);
    // Phase 2i：migration 0085 已删掉全部 Room 表，升级后不应再存在。
    expect(upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('context_rooms', 'room_doc_links')",
    ).all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT id, room_id FROM agent_sessions").all()).toEqual([
      { id: "session-1", room_id: "room-1" },
    ]);
    upgraded.sqlite.close();
  });

  it("drops sync-era connector tables and keeps only tombstones", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-connector-migration-test-"));
    temporaryDirectories.push(dataDir);
    const db = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const tables = (db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'connector%'",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(tables).toContain("connector_tombstones");
    for (const dropped of [
      "connector_accounts",
      "connector_emails",
      "connector_records",
      "connector_documents",
      "connector_calendar_events",
      "connector_sync_jobs",
      "connector_markdown_artifacts",
      "connector_format_mappings",
    ]) {
      expect(tables).not.toContain(dropped);
    }
    db.sqlite.close();
  });

  it("repairs databases that ran the EverRoom dev branch before this branch (mixed history)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-mixed-dev-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");

    // 先得到一个正常迁移完的库，再把它改造成「跑过 dev 分支」的混合状态：
    // dev 的 0083_slides_generation_checkpoints（时间戳 1792771200000）被应用过，
    // 而本分支的 0083–0087（时间戳更早）被游标跳过，0092 也尚未记录。
    const seeded = createDatabase(databasePath, migrationsDir);
    seeded.sqlite.prepare(
      "INSERT INTO slides_generation_checkpoints (key, state, updated_at) VALUES ('kept', '{\"batches\":{}}', 1)",
    ).run();
    seeded.sqlite.exec("PRAGMA foreign_keys = OFF");
    const columns = seeded.sqlite.prepare("PRAGMA table_info(document_operations)").all() as Array<{
      name: string; type: string; notnull: number; pk: number;
    }>;
    const definitions = columns.map((column) => {
      const notNull = column.name === "room_id" ? 1 : column.notnull;
      return `\`${column.name}\` ${column.type}${notNull ? " NOT NULL" : ""}${column.pk ? " PRIMARY KEY" : ""}`;
    });
    seeded.sqlite.exec("DROP TABLE document_operations");
    seeded.sqlite.exec(`CREATE TABLE document_operations (${definitions.join(", ")})`);
    seeded.sqlite.exec("CREATE TABLE IF NOT EXISTS context_rooms (id text PRIMARY KEY NOT NULL)");
    seeded.sqlite.exec("DROP INDEX IF EXISTS file_entries_deleted_updated_idx");
    seeded.sqlite.exec("PRAGMA foreign_keys = ON");
    const skipWhens = [1792742457265, 1792746787000, 1792747500000, 1792748200000, 1792749000000, 1793500000000];
    for (const when of skipWhens) {
      seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(when);
    }
    // dev 的 0083 与本分支 0092 是同一份 SQL，只是编号/时间戳不同。
    const checkpointsSql = await readFile(join(migrationsDir, "0092_slides_generation_checkpoints.sql"), "utf8");
    seeded.sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      createHash("sha256").update(checkpointsSql).digest("hex"),
      1792771200000,
    );
    seeded.sqlite.close();

    // 第二次打开：修复逻辑应补跑被跳过的 0083–0087、把 0092 记为已应用。
    const repaired = createDatabase(databasePath, migrationsDir);
    const roomId = (repaired.sqlite.prepare("PRAGMA table_info(document_operations)").all() as Array<{
      name: string; notnull: number;
    }>).find((column) => column.name === "room_id");
    const indexNames = (repaired.sqlite.prepare("PRAGMA index_list(file_entries)").all() as Array<{ name: string }>)
      .map((index) => index.name);
    const contextRooms = repaired.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_rooms' LIMIT 1",
    ).get();
    const recorded = (when: number) => Boolean(repaired.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(when));
    const keptRow = repaired.sqlite.prepare(
      "SELECT state FROM slides_generation_checkpoints WHERE key = 'kept'",
    ).get() as { state: string } | undefined;

    expect(roomId?.notnull).toBe(0);
    expect(indexNames).toContain("file_entries_deleted_updated_idx");
    expect(contextRooms).toBeUndefined();
    for (const when of skipWhens) expect(recorded(when)).toBe(true);
    expect(keptRow?.state).toBe('{"batches":{}}');
    repaired.sqlite.close();
  });
});
