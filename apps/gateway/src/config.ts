import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
// 阶段二：注册表只被用于「读取元数据」（env 名/默认 configKey），provider 文件本身
// 无副作用依赖，可安全进入 config 层（新增 provider 时 config 解析自动跟随注册表）。
import { SYNC_PROVIDERS } from "@nxcore/connectors-module/sync-providers/index.js";

const LogLevelSchema = Type.Union([
  Type.Literal("fatal"),
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
  Type.Literal("debug"),
  Type.Literal("trace"),
  Type.Literal("silent"),
]);

const AgentRuntimeSchema = Type.Union([
  Type.Literal("fake"),
  Type.Literal("pi"),
]);
const AiApiSchema = Type.Union([
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
  Type.Literal("google-generative-ai"),
]);
const AiReasoningSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const RawConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    dataDir: Type.String({ minLength: 1 }),
    logLevel: LogLevelSchema,
    authToken: Type.String({ minLength: 16 }),
    agentRuntime: AgentRuntimeSchema,
    subagentsEnabled: Type.Boolean(),
    subagentsDir: Type.String(),
    subagentTimeoutMs: Type.Integer({ minimum: 1_000 }),
    subagentMaxConcurrent: Type.Integer({ minimum: 1, maximum: 64 }),
    externalCallUserId: Type.String({ minLength: 1, maxLength: 200 }),
    externalCallWorkspaceId: Type.String({ minLength: 1, maxLength: 200 }),
    aiProvider: Type.String(),
    aiModel: Type.String(),
    aiBackgroundModel: Type.String(),
    aiSlidesReviewerModel: Type.String(),
    /** 审页档独立预算：视觉模型输出上限/窗口/思考档（缺省沿用主模型档）。 */
    aiSlidesReviewerMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    aiSlidesReviewerContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    aiSlidesReviewerReasoning: Type.Optional(AiReasoningSchema),
    aiLiteModel: Type.String(),
    aiBaseUrl: Type.String(),
    aiApiKey: Type.String(),
    aiApi: AiApiSchema,
    aiMaxTokens: Type.Integer({ minimum: 1 }),
    aiBackgroundMaxTokens: Type.Integer({ minimum: 1 }),
    aiLiteMaxTokens: Type.Integer({ minimum: 1 }),
    aiContextWindow: Type.Integer({ minimum: 1 }),
    aiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    aiReasoning: AiReasoningSchema,
    vlmBaseUrl: Type.String(),
    vlmApiKey: Type.String(),
    vlmModel: Type.String(),
    cursorCompletionAiProvider: Type.String(),
    cursorCompletionAiModel: Type.String(),
    cursorCompletionAiBaseUrl: Type.String(),
    cursorCompletionAiApiKey: Type.String(),
    cursorCompletionAiApi: AiApiSchema,
    cursorCompletionAiMaxTokens: Type.Integer({ minimum: 1 }),
    cursorCompletionAiContextWindow: Type.Integer({ minimum: 1 }),
    cursorCompletionAiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    cursorCompletionAiReasoning: AiReasoningSchema,
    piBuiltinTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    webSearchEnabled: Type.Boolean(),
    webSearchBaseUrl: Type.String(),
    webSearchModel: Type.String({ minLength: 1 }),
    webSearchApiKey: Type.String(),
    nangoConnectorPollMs: Type.Integer({ minimum: 1000 }),
    documentIndexBackfillEnabled: Type.Boolean(),
    documentIndexBackfillScanIntervalMs: Type.Integer({ minimum: 1_000 }),
    documentIndexBackfillQuietWindowMs: Type.Integer({ minimum: 0 }),
    documentIndexBackfillLlmEnabled: Type.Boolean(),
    documentIndexBackfillRescanMs: Type.Integer({ minimum: 0 }),
    documentIndexBackfillReadTriggerCooldownMs: Type.Integer({ minimum: 0 }),
    notificationBridgeUrl: Type.String(),
    notificationBridgeToken: Type.String(),
    officeBridgeUrl: Type.String(),
    officeBridgeToken: Type.String(),
  },
  { additionalProperties: false },
);

export type LogLevel = typeof LogLevelSchema.static;
export type AgentRuntimeMode = typeof AgentRuntimeSchema.static;
export type AiApi = typeof AiApiSchema.static;
export type AiReasoning = typeof AiReasoningSchema.static;

/** 百炼（DashScope compatible-mode）联网搜索配置，注入 agent 的 web_search 工具。 */
export interface WebSearchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PiRuntimeConfig {
  runtimeId?: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: AiApi;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  reasoning: AiReasoning;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
  systemPrompt?: string;
  runtimeRole?: "user-facing" | "internal";
  skillsEnabled?: boolean;
  skillPrompts?: Record<string, string>;
  includeBashTool?: boolean;
  maxToolCallsPerRun?: number;
  /** 子 Agent 单条工具结果字符预算（JSON 感知截断）。 */
  maxToolResultChars?: number;
  /** 子 Agent run 内轮次级工具历史裁剪。 */
  runContextGuard?: { triggerTokens: number; keepRecentTurns: number };
  /** Pi 内置工具白名单；缺省启用全部，NXCORE_PI_TOOLS（逗号分隔）收窄。 */
  builtinTools?: string[];
  /** MCP 服务器注入配置（pi-mcp-adapter）；读取 NXCORE_MCP_CONFIG 或 dataDir/agent/mcp.json。 */
  mcp?: { mcpServers: Record<string, unknown> };
}

export interface OpenConnectorCliConfig {
  executable: string;
  baseUrl: string;
  runtimeToken?: string;
  /** 本地模式由 supervisor 生成；SaaS 模式由转发层管理（Seam4 授权流用）。 */
  adminToken?: string;
  configDirectory: string;
  dataDirectory: string;
}

export interface DocumentIndexBackfillConfig {
  enabled: boolean;
  scanIntervalMs: number;
  quietWindowMs: number;
  llmEnabled: boolean;
  /** 全量重扫周期：游标走完一遍后隔这么久归零重走（复检覆盖宿主未动的文档）。 */
  rescanMs: number;
  /** 读取触发冷却：同一文档两次因被读取而入队的最小间隔。 */
  readTriggerCooldownMs: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  migrationsDir: string;
  runtimeManifestPath: string;
  logLevel: LogLevel;
  authToken: string;
  agentRuntime: AgentRuntimeMode;
  externalCallUserId?: string;
  externalCallWorkspaceId?: string;
  documentIndexBackfill?: DocumentIndexBackfillConfig;
  pi: PiRuntimeConfig | null;
  cursorCompletionPi: PiRuntimeConfig | null;
  backgroundPi: PiRuntimeConfig | null;
  /** 轻量模型档（main-lite）；model 为空＝未配置（lite 档隐藏）。 */
  litePi: PiRuntimeConfig | null;
  /** 审页代理专用档（slides-reviewer，需多模态模型）；未配置＝回退 backgroundPi。 */
  slidesReviewerPi?: PiRuntimeConfig | null;
  subagents?: SubagentFrameworkConfig;
  /** agent MCP 配置文件绝对路径（设置页管理用）。 */
  mcpConfigPath: string;
  /** 百炼（DashScope）联网搜索工具配置；null 时 agent 不提供 web_search。 */
  webSearch: WebSearchConfig | null;
  vlm?: VlmConfig | null;
  /** 链路A连接编排（P3 Nango 删除后仅剩编排自身配置；命名遗留 P4 清理）。 */
  nangoConnector?: {
    enabled: boolean;
    databasePath: string;
    pollingIntervalMs: number;
  };
  cliConnector?: OpenConnectorCliConfig | null;
  /** Agent 飞书导出用 lark-cli（发行包预装；桌面注入 NXCORE_LARK_CLI_PATH）。 */
  larkCli?: { executable: string } | null;
  /** Notion 导出用官方 ntn CLI（macOS 随包；桌面注入 NXCORE_NTN_CLI_PATH）。 */
  notionCli?: { executable: string } | null;
  /** 桌面文档资产本地桥（loopback）；飞书导出时本地图改写为该 URL 前缀由 lark-cli 下载。 */
  documentAssetBridgeUrl?: string | null;
  notificationBridge?: { baseUrl: string; token: string } | null;
  /** 桌面 Office 生成桥（loopback）：Agent 工具经它驱动隐藏 GenOffice view 生成 docx。 */
  officeBridge?: { baseUrl: string; token: string } | null;
}

export interface VlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SubagentFrameworkConfig {
  enabled: boolean;
  definitionsDir: string;
  runtimeDir: string;
  defaultTimeoutMs: number;
  maxConcurrent: number;
}

/** agent MCP 配置文件路径（NXCORE_MCP_CONFIG 优先，缺省 dataDir/agent/mcp.json）。 */
export function resolveMcpConfigPath(dataDir: string, overridePath?: string): string {
  return resolve(overridePath?.trim() || join(dataDir, "agent", "mcp.json"));
}

/** 读取 agent MCP 服务器配置（.mcp.json 格式，仅取 mcpServers 字段）；缺省或解析失败返回空。 */
function loadMcpServers(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      console.error(`[config] ${configPath} 缺少 mcpServers 字段，忽略 MCP 配置`);
      return {};
    }
    return parsed.mcpServers;
  } catch (error) {
    console.error(`[config] 解析 MCP 配置失败（${configPath}）：${error instanceof Error ? error.message : error}`);
    return {};
  }
}

function defaultDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "NxCore");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? homedir(), "NxCore");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "nxcore");
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid gateway port: ${value}`);
  }

  return Number(value);
}

function parsePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

/** Return the first non-empty environment value, allowing renamed variables to fall back safely. */
function firstEnvValue(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** 防抖窗口等 legitimately 允许 0（=立即执行）的整数配置用这个。 */
function parseNonNegativeInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

function parseTemperature(value: string, name = "NXCORE_AI_TEMPERATURE"): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return temperature;
}

const AI_REASONING_LEVELS: AiReasoning[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseAiReasoning(name: string, value: string | undefined): AiReasoning | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!AI_REASONING_LEVELS.includes(trimmed as AiReasoning)) {
    throw new Error(`Invalid ${name}: ${trimmed}`);
  }
  return trimmed as AiReasoning;
}

function validateAiEndpoint(value: string, name = "NXCORE_AI_BASE_URL"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
}

function validateConnectorEndpoint(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  // 私有网段（10.x/172.16-31.x/192.168.x/*.local）放行明文 HTTP：SaaS 转发层的
  // dev 内网地址（NXCORE_SAAS_API_URL）经 connector-mode 注入到本配置。
  const privateNetwork = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|.+\.local$)/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || privateNetwork))) {
    throw new Error(`Invalid ${name}: plain HTTP is only allowed for loopback or private network addresses`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}: credentials, query, and fragment are not allowed`);
  }
}

function parseBoolean(name: string, value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(`Invalid ${name}: expected "true" or "false"`);
  }
  return value === "true";
}

function inferMcpWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/device-mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultMigrationsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "drizzle"),
    resolve(moduleDirectory, "..", "drizzle"),
    resolve("drizzle"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Agent definitions are project assets copied beside the packaged Gateway. */
export function bundledAgentDefinitionsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "agents"),
    resolve(moduleDirectory, "..", "..", "..", "agents"),
    resolve("agents"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: normalizedArgv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "log-level": { type: "string" },
      token: { type: "string" },
      "migrations-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const dataDir = resolve(values["data-dir"] ?? env.NXCORE_GATEWAY_DATA_DIR ?? defaultDataDir());
  const rawConfig = {
    host: values.host ?? env.NXCORE_GATEWAY_HOST ?? "127.0.0.1",
    port: parsePort(values.port ?? env.NXCORE_GATEWAY_PORT ?? "0"),
    dataDir,
    logLevel: values["log-level"] ?? env.NXCORE_GATEWAY_LOG_LEVEL ?? "info",
    authToken: values.token ?? env.NXCORE_GATEWAY_TOKEN ?? randomBytes(32).toString("base64url"),
    agentRuntime: env.NXCORE_AGENT_RUNTIME ?? "fake",
    subagentsEnabled: env.NXCORE_SUBAGENTS_ENABLED == null
      ? true
      : parseBoolean("NXCORE_SUBAGENTS_ENABLED", env.NXCORE_SUBAGENTS_ENABLED.trim()),
    subagentsDir: env.NXCORE_SUBAGENTS_DIR?.trim() ?? "",
    subagentTimeoutMs: parsePositiveInteger(
      "NXCORE_SUBAGENT_TIMEOUT_MS",
      env.NXCORE_SUBAGENT_TIMEOUT_MS ?? "300000",
    ),
    subagentMaxConcurrent: parsePositiveInteger(
      "NXCORE_SUBAGENT_MAX_CONCURRENT",
      env.NXCORE_SUBAGENT_MAX_CONCURRENT ?? "8",
    ),
    externalCallUserId: env.NXCORE_EXTERNAL_CALL_USER_ID?.trim() || "local-user",
    externalCallWorkspaceId: env.NXCORE_EXTERNAL_CALL_WORKSPACE_ID?.trim() || "local-workspace",
    aiProvider: env.NXCORE_AI_PROVIDER?.trim() ?? "",
    aiModel: env.NXCORE_AI_MODEL?.trim() ?? "",
    aiBackgroundModel: env.NXCORE_AI_BACKGROUND_MODEL?.trim() || env.NXCORE_AI_MODEL?.trim() || "",
    aiSlidesReviewerModel: env.NXCORE_AI_SLIDES_REVIEWER_MODEL?.trim() || "",
    aiSlidesReviewerMaxTokens: env.NXCORE_AI_SLIDES_REVIEWER_MAX_TOKENS?.trim()
      ? parsePositiveInteger("NXCORE_AI_SLIDES_REVIEWER_MAX_TOKENS", env.NXCORE_AI_SLIDES_REVIEWER_MAX_TOKENS)
      : undefined,
    aiSlidesReviewerContextWindow: env.NXCORE_AI_SLIDES_REVIEWER_CONTEXT_WINDOW?.trim()
      ? parsePositiveInteger("NXCORE_AI_SLIDES_REVIEWER_CONTEXT_WINDOW", env.NXCORE_AI_SLIDES_REVIEWER_CONTEXT_WINDOW)
      : undefined,
    aiSlidesReviewerReasoning: parseAiReasoning(
      "NXCORE_AI_SLIDES_REVIEWER_REASONING",
      env.NXCORE_AI_SLIDES_REVIEWER_REASONING,
    ),
    aiBaseUrl: env.NXCORE_AI_BASE_URL?.trim() ?? "",
    aiApiKey: env.NXCORE_AI_API_KEY?.trim() ?? "",
    aiApi: env.NXCORE_AI_API ?? "openai-completions",
    aiMaxTokens: parsePositiveInteger("NXCORE_AI_MAX_TOKENS", env.NXCORE_AI_MAX_TOKENS ?? "8192"),
    aiBackgroundMaxTokens: parsePositiveInteger(
      "NXCORE_AI_BACKGROUND_MAX_TOKENS",
      env.NXCORE_AI_BACKGROUND_MAX_TOKENS ?? "8192",
    ),
    aiLiteModel: env.NXCORE_AI_LITE_MODEL?.trim() ?? "",
    aiLiteMaxTokens: parsePositiveInteger(
      "NXCORE_AI_LITE_MAX_TOKENS",
      env.NXCORE_AI_LITE_MAX_TOKENS ?? env.NXCORE_AI_MAX_TOKENS ?? "8192",
    ),
    aiContextWindow: parsePositiveInteger(
      "NXCORE_AI_CONTEXT_WINDOW",
      env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    aiTemperature: parseTemperature(env.NXCORE_AI_TEMPERATURE ?? "0.3"),
    aiReasoning: env.NXCORE_AI_REASONING ?? "medium",
    vlmBaseUrl: env.NXCORE_VLM_BASE_URL?.trim() ?? "",
    vlmApiKey: env.NXCORE_VLM_API_KEY?.trim() ?? "",
    vlmModel: env.NXCORE_VLM_MODEL?.trim() ?? "",
    cursorCompletionAiProvider: env.NXCORE_CURSOR_COMPLETION_AI_PROVIDER?.trim()
      || env.NXCORE_AI_PROVIDER?.trim() || "",
    cursorCompletionAiModel: env.NXCORE_CURSOR_COMPLETION_AI_MODEL?.trim()
      || env.NXCORE_AI_MODEL?.trim() || "",
    cursorCompletionAiBaseUrl: env.NXCORE_CURSOR_COMPLETION_AI_BASE_URL?.trim()
      || env.NXCORE_AI_BASE_URL?.trim() || "",
    cursorCompletionAiApiKey: env.NXCORE_CURSOR_COMPLETION_AI_API_KEY?.trim()
      || env.NXCORE_AI_API_KEY?.trim() || "",
    cursorCompletionAiApi: env.NXCORE_CURSOR_COMPLETION_AI_API?.trim()
      || env.NXCORE_AI_API?.trim() || "openai-completions",
    cursorCompletionAiMaxTokens: parsePositiveInteger(
      "NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS",
      env.NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS ?? env.NXCORE_AI_MAX_TOKENS ?? "8192",
    ),
    cursorCompletionAiContextWindow: parsePositiveInteger(
      "NXCORE_CURSOR_COMPLETION_AI_CONTEXT_WINDOW",
      env.NXCORE_CURSOR_COMPLETION_AI_CONTEXT_WINDOW ?? env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    cursorCompletionAiTemperature: parseTemperature(
      env.NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE ?? env.NXCORE_AI_TEMPERATURE ?? "0.3",
      env.NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE === undefined
        ? "NXCORE_AI_TEMPERATURE"
        : "NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE",
    ),
    cursorCompletionAiReasoning: env.NXCORE_CURSOR_COMPLETION_AI_REASONING?.trim()
      || env.NXCORE_AI_REASONING?.trim() || "medium",
    piBuiltinTools: env.NXCORE_PI_TOOLS?.trim()
      ? env.NXCORE_PI_TOOLS.split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      : undefined,
    webSearchEnabled: env.NXCORE_WEB_SEARCH == null
      ? true
      : parseBoolean("NXCORE_WEB_SEARCH", env.NXCORE_WEB_SEARCH.trim()),
    webSearchBaseUrl: env.NXCORE_WEB_SEARCH_BASE_URL?.trim()
      ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    webSearchModel: env.NXCORE_WEB_SEARCH_MODEL?.trim() ?? "qwen-plus",
    webSearchApiKey: env.NXCORE_WEB_SEARCH_API_KEY?.trim()
      ?? env.DASHSCOPE_API_KEY?.trim()
      ?? (env.NXCORE_AI_BASE_URL?.trim().toLowerCase().startsWith("https://dashscope.aliyuncs.com/")
        ? env.NXCORE_AI_API_KEY?.trim()
        : "")
      ?? "",
    nangoConnectorPollMs: parsePositiveInteger(
      "NXCORE_CONNECTOR_POLL_MS",
      env.NXCORE_CONNECTOR_POLL_MS?.trim() || "300000",
    ),
    documentIndexBackfillEnabled: env.NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED == null
      ? true
      : parseBoolean("NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED", env.NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED.trim()),
    documentIndexBackfillScanIntervalMs: parsePositiveInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_SCAN_INTERVAL_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_SCAN_INTERVAL_MS ?? "60000",
    ),
    documentIndexBackfillQuietWindowMs: parsePositiveInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_QUIET_WINDOW_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_QUIET_WINDOW_MS ?? "300000",
    ),
    documentIndexBackfillLlmEnabled: env.NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED == null
      ? true
      : parseBoolean("NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED", env.NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED.trim()),
    documentIndexBackfillRescanMs: parseNonNegativeInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_RESCAN_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_RESCAN_MS ?? "86400000",
    ),
    documentIndexBackfillReadTriggerCooldownMs: parseNonNegativeInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_READ_TRIGGER_COOLDOWN_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_READ_TRIGGER_COOLDOWN_MS ?? "1800000",
    ),
    notificationBridgeUrl: env.NXCORE_NOTIFICATION_BRIDGE_URL?.trim() ?? "",
    notificationBridgeToken: env.NXCORE_NOTIFICATION_BRIDGE_TOKEN?.trim() ?? "",
    officeBridgeUrl: env.NXCORE_OFFICE_BRIDGE_URL?.trim() ?? "",
    officeBridgeToken: env.NXCORE_OFFICE_BRIDGE_TOKEN?.trim() ?? "",
  };

  if (!Value.Check(RawConfigSchema, rawConfig)) {
    const details = [...Value.Errors(RawConfigSchema, rawConfig)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new Error(`Invalid gateway configuration: ${details}`);
  }

  if (rawConfig.agentRuntime === "pi") {
    // AI 四要素全空 = 降级启动（等 runtime config 热应用，见 create-server 的
    // applyRuntimeConfig；packaged app 无 .env，本就是常态）；部分填写 = 配置
    // 事故，宁可早失败也不带半套配置起服务。
    const missing = [
      ["NXCORE_AI_PROVIDER", rawConfig.aiProvider],
      ["NXCORE_AI_MODEL", rawConfig.aiModel],
      ["NXCORE_AI_BASE_URL", rawConfig.aiBaseUrl],
      ["NXCORE_AI_API_KEY", rawConfig.aiApiKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0 && missing.length < 4) {
      throw new Error(`Pi runtime requires: ${missing.join(", ")}`);
    }
    if (missing.length === 0) validateAiEndpoint(rawConfig.aiBaseUrl);
  }

  if (rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel) {
    validateAiEndpoint(rawConfig.vlmBaseUrl, "NXCORE_VLM_BASE_URL");
  }

  if (Boolean(rawConfig.notificationBridgeUrl)!==Boolean(rawConfig.notificationBridgeToken)) throw new Error("Notification bridge configuration requires URL and token together");
  if(rawConfig.notificationBridgeUrl){const u=new URL(rawConfig.notificationBridgeUrl);if(u.protocol!=="http:"||!["localhost","127.0.0.1","::1"].includes(u.hostname))throw new Error("NXCORE_NOTIFICATION_BRIDGE_URL must be a loopback HTTP endpoint");}
  if (Boolean(rawConfig.officeBridgeUrl)!==Boolean(rawConfig.officeBridgeToken)) throw new Error("Office bridge configuration requires URL and token together");
  if(rawConfig.officeBridgeUrl){const u=new URL(rawConfig.officeBridgeUrl);if(u.protocol!=="http:"||!["localhost","127.0.0.1","::1"].includes(u.hostname))throw new Error("NXCORE_OFFICE_BRIDGE_URL must be a loopback HTTP endpoint");}

  const mcpConfigPath = resolveMcpConfigPath(dataDir, env.NXCORE_MCP_CONFIG);
  const mcpServers = loadMcpServers(mcpConfigPath);
  const pi: PiRuntimeConfig | null = rawConfig.agentRuntime === "pi"
    ? {
        provider: rawConfig.aiProvider,
        model: rawConfig.aiModel,
        baseUrl: rawConfig.aiBaseUrl,
        apiKey: rawConfig.aiApiKey,
        api: rawConfig.aiApi,
        maxTokens: rawConfig.aiMaxTokens,
        contextWindow: rawConfig.aiContextWindow,
        temperature: rawConfig.aiTemperature,
        reasoning: rawConfig.aiReasoning,
        sessionsDir: join(dataDir, "agent", "pi-sessions"),
        workingDirectory: join(dataDir, "agent", "workspace"),
        agentDirectory: join(dataDir, "agent", "pi-config"),
        ...(rawConfig.piBuiltinTools ? { builtinTools: rawConfig.piBuiltinTools } : {}),
      }
    : null;
  const cursorCompletionPi: PiRuntimeConfig | null = rawConfig.agentRuntime === "pi"
    ? {
        provider: rawConfig.cursorCompletionAiProvider,
        model: rawConfig.cursorCompletionAiModel,
        baseUrl: rawConfig.cursorCompletionAiBaseUrl,
        apiKey: rawConfig.cursorCompletionAiApiKey,
        api: rawConfig.cursorCompletionAiApi,
        maxTokens: rawConfig.cursorCompletionAiMaxTokens,
        contextWindow: rawConfig.cursorCompletionAiContextWindow,
        temperature: rawConfig.cursorCompletionAiTemperature,
        reasoning: rawConfig.cursorCompletionAiReasoning,
        sessionsDir: join(dataDir, "agent", "cursor-completion-pi-sessions"),
        workingDirectory: join(dataDir, "agent", "cursor-completion-workspace"),
        agentDirectory: join(dataDir, "agent", "cursor-completion-pi-config"),
      }
    : null;
  if (cursorCompletionPi) {
    // 与 primary 同款降级规则：全空跳过（runtime config 兜底），部分填写报事故。
    const cursorMissing = ([
      ["NXCORE_CURSOR_COMPLETION_AI_PROVIDER", cursorCompletionPi.provider],
      ["NXCORE_CURSOR_COMPLETION_AI_MODEL", cursorCompletionPi.model],
      ["NXCORE_CURSOR_COMPLETION_AI_BASE_URL", cursorCompletionPi.baseUrl],
      ["NXCORE_CURSOR_COMPLETION_AI_API_KEY", cursorCompletionPi.apiKey],
    ] as const).filter(([, value]) => !value).map(([name]) => name);
    if (cursorMissing.length > 0 && cursorMissing.length < 4) {
      throw new Error(`Cursor completion Pi runtime requires: ${cursorMissing.join(", ")}`);
    }
    if (cursorMissing.length === 0) {
      validateAiEndpoint(cursorCompletionPi.baseUrl, "NXCORE_CURSOR_COMPLETION_AI_BASE_URL");
    }
  }
  if (rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel) {
    validateAiEndpoint(rawConfig.vlmBaseUrl, "NXCORE_VLM_BASE_URL");
  }
  const cliConnectorUrl = env.NXCORE_CLI_CONNECTOR_URL?.trim();
  if (cliConnectorUrl) validateConnectorEndpoint("NXCORE_CLI_CONNECTOR_URL", cliConnectorUrl);

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    externalCallUserId: rawConfig.externalCallUserId,
    externalCallWorkspaceId: rawConfig.externalCallWorkspaceId,
    documentIndexBackfill: {
      enabled: rawConfig.documentIndexBackfillEnabled,
      scanIntervalMs: rawConfig.documentIndexBackfillScanIntervalMs,
      quietWindowMs: rawConfig.documentIndexBackfillQuietWindowMs,
      llmEnabled: rawConfig.documentIndexBackfillLlmEnabled,
      rescanMs: rawConfig.documentIndexBackfillRescanMs,
      readTriggerCooldownMs: rawConfig.documentIndexBackfillReadTriggerCooldownMs,
    },
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve(
      values["migrations-dir"] ?? env.NXCORE_GATEWAY_MIGRATIONS_DIR ?? defaultMigrationsDir(),
    ),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    nangoConnector: {
      // P3：Nango runtime 删除——链路A编排恒可用（executor 走 oo）。
      enabled: true,
      databasePath: join(dataDir,"database","connectors.sqlite"),
      pollingIntervalMs: rawConfig.nangoConnectorPollMs,
    },
    cliConnector: cliConnectorUrl
      ? {
          executable: env.NXCORE_CLI_CONNECTOR_CLI_PATH?.trim() || 'oo',
          baseUrl: cliConnectorUrl.replace(/\/$/, ''),
          ...(env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN?.trim()
            ? { runtimeToken: env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN.trim() }
            : {}),
          ...(env.NXCORE_CLI_CONNECTOR_ADMIN_TOKEN?.trim()
            ? { adminToken: env.NXCORE_CLI_CONNECTOR_ADMIN_TOKEN.trim() }
            : {}),
          configDirectory: env.NXCORE_CLI_CONNECTOR_CONFIG_DIR?.trim() || join(dataDir, 'open-connector', 'oo-config'),
          dataDirectory: env.NXCORE_CLI_CONNECTOR_DATA_DIR?.trim() || join(dataDir, 'open-connector', 'oo-data'),
        }
      : null,
    notificationBridge: rawConfig.notificationBridgeUrl
      ? { baseUrl: rawConfig.notificationBridgeUrl.replace(/\/$/, ""), token: rawConfig.notificationBridgeToken }
      : null,
    officeBridge: rawConfig.officeBridgeUrl
      ? { baseUrl: rawConfig.officeBridgeUrl.replace(/\/$/, ""), token: rawConfig.officeBridgeToken }
      : null,
    larkCli: {
      executable: firstEnvValue(env, "NXCORE_LARK_CLI_PATH")?.trim() || "lark-cli",
    },
    documentAssetBridgeUrl: firstEnvValue(env, "NXCORE_DOCUMENT_ASSET_BRIDGE_URL")?.trim() || null,
    notionCli: firstEnvValue(env, "NXCORE_NTN_CLI_PATH")?.trim()
      ? { executable: firstEnvValue(env, "NXCORE_NTN_CLI_PATH")!.trim() }
      : null,
    pi,
    cursorCompletionPi,
    backgroundPi: pi
      ? {
          ...pi,
          model: rawConfig.aiBackgroundModel,
          maxTokens: rawConfig.aiBackgroundMaxTokens,
        }
      : null,
    // lite 档恒从 pi 派生（连接要素继承主模型），model 空＝未配置：
    // 与 background 不同，model 不回落主模型——档位只在显式配置后出现。
    // 恒建对象（而非 model 空时 null）：runtime config 的 apply 只能打补丁，
    // null 无法被用户配置补齐（webSearch 同理在 create-server 直接构造）。
    litePi: pi
      ? {
          ...pi,
          model: rawConfig.aiLiteModel,
          maxTokens: rawConfig.aiLiteMaxTokens,
        }
      : null,
    // 审页档（slides-reviewer 专用，多模态）：model 可来自 env 专用键，也可由
    // runtime config 的 vlm 槽（SaaS 套餐下发的视觉模型）apply 补齐。恒建对象
    // 使 apply 可打补丁；model 仍空时消费端回退 backgroundPi（主模型多模态时开箱可用）。
    // 输出上限/窗口/思考档支持独立 env 键：审页模型常是 qwen 系视觉模型，
    // 输出上限远小于主模型；沿用主模型档会让长思考把输出预算吃满（2026-10 实测）。
    slidesReviewerPi: pi
      ? {
          ...pi,
          model: rawConfig.aiSlidesReviewerModel,
          ...(rawConfig.aiSlidesReviewerMaxTokens === undefined
            ? {}
            : { maxTokens: rawConfig.aiSlidesReviewerMaxTokens }),
          ...(rawConfig.aiSlidesReviewerContextWindow === undefined
            ? {}
            : { contextWindow: rawConfig.aiSlidesReviewerContextWindow }),
          ...(rawConfig.aiSlidesReviewerReasoning === undefined
            ? {}
            : { reasoning: rawConfig.aiSlidesReviewerReasoning }),
        }
      : null,
    subagents: {
      enabled: rawConfig.subagentsEnabled,
      definitionsDir: resolve(rawConfig.subagentsDir || bundledAgentDefinitionsDir()),
      runtimeDir: join(dataDir, "agent", "subagents"),
      defaultTimeoutMs: rawConfig.subagentTimeoutMs,
      maxConcurrent: rawConfig.subagentMaxConcurrent,
    },
    mcpConfigPath,
    webSearch: pi && rawConfig.webSearchEnabled && rawConfig.webSearchApiKey
      ? {
          baseUrl: rawConfig.webSearchBaseUrl,
          apiKey: rawConfig.webSearchApiKey,
          model: rawConfig.webSearchModel,
        }
      : null,
    vlm: rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel
      ? { baseUrl: rawConfig.vlmBaseUrl, apiKey: rawConfig.vlmApiKey, model: rawConfig.vlmModel }
      : null,
  };
}
