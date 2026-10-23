import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runSqliteMigrations } from "@nxcore/migration-kit";
import * as schema from "./schema.js";
import { gatewayDataMigrations } from "./data-migrations.js";
import { repairContextRoomSchema } from "./context-room-compatibility.js";

export interface DatabaseClient {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

interface MigrationJournalEntry {
  tag?: string;
  when?: number;
}

function readMigrationJournal(migrationsDir: string): MigrationJournalEntry[] {
  try {
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries?: MigrationJournalEntry[];
    };
    return journal.entries ?? [];
  } catch {
    return [];
  }
}

function recordMigration(
  sqlite: Database.Database,
  migrationsDir: string,
  entry: MigrationJournalEntry,
): void {
  if (!entry.tag || typeof entry.when !== "number") return;
  if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
  const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
}

function runAdditiveMigrationIdempotently(
  sqlite: Database.Database,
  migrationsDir: string,
  tag: string,
): void {
  const migrationPath = join(migrationsDir, `${tag}.sql`);
  if (!existsSync(migrationPath)) return;
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => hasObject("table", table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);

  const sql = readFileSync(migrationPath, "utf8");
  for (const raw of sql.split(/--> statement-breakpoint/g)) {
    const statement = raw.replace(/^--[^\n]*$/gm, "").trim();
    if (!statement) continue;
    const createTable = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createTable && hasObject("table", createTable)) continue;
    const createIndex = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createIndex && hasObject("index", createIndex)) continue;
    const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
    if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
    sqlite.exec(statement);
  }
}

/**
 * The connector branch shipped migrations 0010-0012 with later timestamps than
 * the main branch's document migrations. On an upgraded install Drizzle would
 * therefore skip the document/knowledge migrations and only retry 0015. Move
 * that legacy cursor back to the shared 0009 baseline so the canonical chain
 * can run once; the 0015 connector migration is idempotent for its old tables.
 */
function repairLegacyMigrationCursor(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations") || !hasTable("connector_accounts") || hasTable("document_block_references")) {
    return;
  }

  const entry = readMigrationJournal(migrationsDir).find((item) => item.tag === "0010_tricky_mongoose");
  const canonicalFirstMigrationAt = typeof entry?.when === "number" ? entry.when : null;
  if (canonicalFirstMigrationAt === null) return;

  const hasLegacyCursor = sqlite.prepare(
    "SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1",
  ).get(canonicalFirstMigrationAt);
  if (!hasLegacyCursor) return;
  sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(canonicalFirstMigrationAt);
}

/**
 * Development builds briefly shipped the connector configuration schema as
 * 0013 before it was rebased onto the canonical migration chain as 0016. If
 * that complete schema is already present, adopt it instead of replaying the
 * same CREATE TABLE / ALTER TABLE statements and losing the existing data.
 */
function adoptPreReleaseConnectorConfigMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;

  const entries = readMigrationJournal(migrationsDir);
  const previous = entries.find((item) => item.tag === "0015_low_overlord");
  const canonical = entries.find((item) => item.tag === "0016_dazzling_silver_samurai");
  if (typeof previous?.when !== "number" || typeof canonical?.when !== "number") return;

  const latest = sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined;
  if (typeof latest?.created_at !== "number"
    || latest.created_at < previous.when
    || latest.created_at >= canonical.when) return;

  for (const table of [
    "connector_prompt_profiles",
    "connector_sync_job_states",
    "connector_sync_job_versions",
  ]) {
    if (!hasTable(table)) return;
  }

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasTable(table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_accounts", ["display_name", "account_label", "credential_ref"])) return;
  if (!hasColumns("connector_sync_jobs", [
    "name", "prompt_profile_id", "prompt_override", "schedule_type", "timezone",
    "retry_policy", "priority", "status", "config_version",
  ])) return;
  if (!hasColumns("connector_sync_runs", [
    "job_version_id", "unchanged", "quarantined", "rendered_prompt_hash",
    "prompt_profile_version", "input_checkpoint", "output_checkpoint",
  ])) return;

  const migrationSql = readFileSync(join(migrationsDir, `${canonical.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(hash, canonical.when);
}

/**
 * The connector Markdown work briefly shipped as migrations 0017-0019 before
 * main claimed 0017. Those builds already have the complete schema, but their
 * later timestamps make Drizzle skip main's 0017 and replay canonical 0018.
 * Adopt both canonical migrations after verifying every legacy schema object.
 */
function adoptPreReleaseConnectorMarkdownMigrations(
  sqlite: Database.Database,
  migrationsDir: string,
): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  if (!hasObject("table", "__drizzle_migrations")) return;

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasObject("table", table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_markdown_artifacts", [
    "id", "owner_id", "service", "connection_name", "resource_type", "source_record_id",
    "ingest_source_id", "active_path", "source_content_hash", "markdown_content_hash",
    "renderer_version", "version", "status", "ingest_status", "last_error", "parsed_id",
    "ingest_event_id", "created_at", "updated_at", "deleted_at",
  ])) return;
  if (!hasColumns("connector_markdown_outbox", [
    "id", "owner_id", "resource_type", "ingest_source_id", "operation", "source_content_hash",
    "status", "attempts", "available_at", "lease_owner", "lease_until", "last_error",
    "created_at", "updated_at",
  ])) return;
  // 该函数只服务「早期 pre-release 连接器分支 + 统一理解引擎」的库：那批库在
  // migrate 之前就存在 ingest_events（0084 才删），用它的列形态当形态哨兵。
  // 已修到 0084 之后的库不会走到这里（0017/0018 早已记录在案）。
  if (!hasColumns("ingest_events", ["deleted_at"])) return;
  for (const index of [
    "connector_markdown_artifacts_source_idx",
    "connector_markdown_artifacts_ingest_source_idx",
    "connector_markdown_artifacts_status_idx",
    "connector_markdown_outbox_due_idx",
    "connector_markdown_outbox_source_idx",
  ]) {
    if (!hasObject("index", index)) return;
  }

  const entries = readMigrationJournal(migrationsDir);
  const canonicalEntries = [
    entries.find((item) => item.tag === "0017_sour_madame_web"),
    entries.find((item) => item.tag === "0018_charming_vampiro"),
  ];
  if (canonicalEntries.some((entry) => typeof entry?.when !== "number" || !entry.tag)) return;

  const insertMigration = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  sqlite.transaction(() => {
    sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
    for (const entry of canonicalEntries) {
      if (!entry?.tag || typeof entry.when !== "number") continue;
      const recorded = sqlite.prepare(
        "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
      ).get(entry.when);
      if (recorded) continue;
      const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = createHash("sha256").update(migrationSql).digest("hex");
      insertMigration.run(hash, entry.when);
    }
  })();
}

/** Adopt late development migrations when their complete schema was already
 * applied under a discarded migration cursor. This prevents duplicate ALTER
 * statements while still allowing partially upgraded databases to migrate. */
function adoptAlreadyAppliedLateMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;
  const hasColumn = (table: string, column: string) => hasTable(table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  const entries = readMigrationJournal(migrationsDir);
  let connectorTodosEnsured = false;
  // 0033_room_entity_facts / 0034_room_overviews_and_corrections 建的表已随 0084 删除
  // （room_overviews 由 canonical 链保证，早期库的形态修复见 context-room-compatibility），
  // 因此这里不再整体重放 0033-0035，只补仍然存活的 connector_todos。
  const ensureConnectorTodosMigration = () => {
    if (connectorTodosEnsured) return;
    connectorTodosEnsured = true;
    const tag = "0035_eager_hannibal_king";
    sqlite.transaction(() => {
      runAdditiveMigrationIdempotently(sqlite, migrationsDir, tag);
      const entry = entries.find((item) => item.tag === tag);
      if (entry) recordMigration(sqlite, migrationsDir, entry);
    })();
  };
  const record = (tag: string) => {
    const entry = entries.find((item) => item.tag === tag);
    if (!entry?.tag || typeof entry.when !== "number") return;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
    const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
  };

  // 0036/0037/0038（clipper_*）与 0043（room_local_actions）的探测随 0084 一并退役：
  // 这些表已删，重放对应迁移只会把空表建回来。
  if (hasTable("agent_session_participants")
    && hasColumn("agent_sessions", "active_agent_id")
    && hasColumn("agent_runs", "agent_id")
    && hasColumn("agent_runs", "invocation_mode")
    && hasColumn("agent_messages", "author_agent_id")) {
    ensureConnectorTodosMigration();
    record("0039_multi_agent_conversations");
  }
}

/** Repair installs whose migration cursor advanced across the diary/perception
 * branch without applying its schema (a transient merge produced this state). */
function repairIncompleteUnderstandingMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  if (!hasObject("table", "__drizzle_migrations")) return;
  const runMigrationStatements = (tag: string) => {
    const migrationPath = join(migrationsDir, `${tag}.sql`);
    if (!existsSync(migrationPath)) return;
    const sql = readFileSync(migrationPath, "utf8");
    for (const statement of sql.split(/--> statement-breakpoint/g).map((item) => item.trim()).filter(Boolean)) {
      const createObject = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/) ?? statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/);
      if (createObject && hasObject(statement.startsWith("CREATE TABLE") ? "table" : "index", createObject[1]!)) continue;
      const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
      if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
      const dropIndex = statement.match(/^DROP INDEX [`"]([^`"]+)[`"]/);
      if (dropIndex && !hasObject("index", dropIndex[1]!)) continue;
      // 重放的历史迁移里可能引用已被后续迁移删掉的表（如 0084 删掉的 ingest_events）：
      // 目标表不存在时该语句无意义，跳过而不是让补丁路径炸掉。
      const indexTarget = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"][^`"]+[`"] ON [`"]([^`"]+)[`"]/);
      const tableTarget = statement.match(/^(?:ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM) [`"]([^`"]+)[`"]/);
      const referenced = indexTarget?.[1] ?? tableTarget?.[1];
      if (referenced && !hasObject("table", referenced)) continue;
      sqlite.exec(statement);
    }
  };
  // 0018_living_secret_warriors 的日记/感知/视觉表已随 0084 删除，不能整条重放；
  // 这里只补它给 uploaded_files 加的四列。只在「游标已越过 0018 但列缺失」的库上
  // 补——否则会把列提前加到还没跑 0018 的旧库上，等 0018 真跑时 ADD COLUMN 撞车。
  const canonical0018 = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0018_living_secret_warriors");
  const appliedCursor = Number((sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined)?.created_at ?? 0);
  const cursorPassed0018 = typeof canonical0018?.when === "number" && appliedCursor >= canonical0018.when;
  if (cursorPassed0018 && hasObject("table", "uploaded_files")) {
    const uploadedFileColumns: Array<[string, string]> = [
      ["asset_kind", "text DEFAULT 'document' NOT NULL"],
      ["origin_channel", "text DEFAULT 'upload' NOT NULL"],
      ["visibility", "text DEFAULT 'private' NOT NULL"],
      ["captured_at", "integer"],
    ];
    for (const [column, definition] of uploadedFileColumns) {
      if (!hasColumn("uploaded_files", column)) {
        sqlite.exec(`ALTER TABLE \`uploaded_files\` ADD \`${column}\` ${definition}`);
      }
    }
  }
  if (!hasObject("table", "connector_markdown_artifacts")) runMigrationStatements("0018_charming_vampiro");
  if (!hasObject("table", "subagent_definitions")) runMigrationStatements("0019_sturdy_fantastic_four");
  if (!hasObject("table", "runtime_config_store")) runMigrationStatements("0023_runtime_config_store");
  if (!hasObject("table", "agent_schedules")) runMigrationStatements("0025_greedy_the_santerians");
}

export function createDatabase(databasePath: string, migrationsDir: string): DatabaseClient {
  mkdirSync(dirname(databasePath), { recursive: true });

  let isFreshDatabase = true;
  try {
    isFreshDatabase = !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch {
    isFreshDatabase = true;
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("secure_delete = ON");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  repairLegacyMigrationCursor(sqlite, migrationsDir);
  adoptPreReleaseConnectorConfigMigration(sqlite, migrationsDir);
  adoptPreReleaseConnectorMarkdownMigrations(sqlite, migrationsDir);
  adoptAlreadyAppliedLateMigrations(sqlite, migrationsDir);
  repairContextRoomSchema(sqlite);
  // Compatibility repairs may create file_entries from the current schema,
  // including source_path, before the canonical additive migration runs.
  // Apply/record it idempotently so Drizzle never repeats ADD COLUMN.
  const localReferenceEntry = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0042_friendly_lake");
  const hasMigrationTable = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations' LIMIT 1",
  ).get());
  const hasFileEntries = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_entries' LIMIT 1",
  ).get());
  if (localReferenceEntry && hasMigrationTable && hasFileEntries) {
    runAdditiveMigrationIdempotently(sqlite, migrationsDir, localReferenceEntry.tag!);
    recordMigration(sqlite, migrationsDir, localReferenceEntry);
  }
  // 0064_document_import_batches_force_new 的手写时间戳早于同批 0064_document_origin
  // 与 0065+，游标已越过它的升级库会被 Drizzle 当作已应用而静默跳过 ALTER。
  const importBatchForceNewEntry = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0064_document_import_batches_force_new");
  const hasImportBatches = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_import_batches' LIMIT 1",
  ).get());
  if (importBatchForceNewEntry && hasMigrationTable && hasImportBatches) {
    runAdditiveMigrationIdempotently(sqlite, migrationsDir, importBatchForceNewEntry.tag!);
    recordMigration(sqlite, migrationsDir, importBatchForceNewEntry);
  }
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
  // Preserve canonical migration markers when a pre-release branch inserted
  // later timestamps before the main branch was adopted.
  const journalEntries = readMigrationJournal(migrationsDir);
  const insertMigration = sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (const entry of journalEntries.filter((item) => typeof item.when === "number" && (item.tag?.startsWith("0017_") || item.tag?.startsWith("0018_") || item.tag?.startsWith("0019_")))) {
    if (!entry.tag || typeof entry.when !== "number") continue;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) continue;
    const migrationPath = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(migrationPath)) continue;
    insertMigration.run(createHash("sha256").update(readFileSync(migrationPath, "utf8")).digest("hex"), entry.when);
  }
  // Drizzle identifies migrations by timestamp; the merged branch contains
  // two 0018/0019 entries with overlapping timestamps. Re-run the idempotent
  // compatibility pass after migrate so fresh databases receive whichever
  // branch migration Drizzle skipped.
  repairIncompleteUnderstandingMigration(sqlite, migrationsDir);

  // 数据级迁移（JSON blob/行级格式变换）必须在全部 schema 修复与 drizzle
  // 迁移之后执行：迁移看到的是最终表结构。失败时框架会用备份恢复整库并抛
  // MigrationFailureError，由启动流程（bin/serve.ts）以退出码 78 结束进程。
  runSqliteMigrations({
    storeId: "gateway.sqlite",
    sqlite,
    databasePath,
    backupDir: join(dirname(databasePath), "..", "backups"),
    isFreshStore: isFreshDatabase,
    migrations: gatewayDataMigrations,
    close: () => sqlite.close(),
  });

  return { db, sqlite };
}

export type GatewayDatabase = ReturnType<typeof createDatabase>["db"];
