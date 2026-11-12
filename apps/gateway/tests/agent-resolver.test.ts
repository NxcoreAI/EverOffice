import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { invokeAgent } from "../src/modules/agent/invoke.js";
import { OpenAiCompletionAgentRuntime } from "../src/modules/agent/openai-completion-runtime.js";
import { createAgentResolver, createCursorCompletionRuntime } from "../src/modules/agent/runtime-factory.js";
import { AgentResolver, BUILTIN_AGENT_IDS } from "../src/modules/agent/resolver.js";
import { loadAllBuiltinAgentBundles } from "../src/modules/agent/builtin-bundles.js";
import { bundledAgentDefinitionsDir } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentResolver", () => {
  it("loads every built-in Agent from the shipped agents directory", () => {
    const bundles = loadAllBuiltinAgentBundles(bundledAgentDefinitionsDir());
    expect(bundles.map(({ id }) => id).sort()).toEqual(Object.values(BUILTIN_AGENT_IDS).sort());
    for (const bundle of bundles) {
      expect(bundle.systemPrompt.length).toBeGreaterThan(0);
      expect(bundle.directory).toBe(join(bundledAgentDefinitionsDir(), bundle.id));
    }
  });

  it("selects lazily by stable Agent id and caches one runtime", async () => {
    const resolver = new AgentResolver();
    const runtime = { dispose: vi.fn(async () => undefined) } as unknown as AgentRuntime;
    const factory = vi.fn(() => runtime);
    resolver.register({
      id: "test-agent",
      name: "Test Agent",
      description: "Test",
      configDirectory: "/tmp/test-agent/config",
      kind: "developer",
    }, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(resolver.resolve("test-agent")).toBe(runtime);
    expect(resolver.resolve("test-agent")).toBe(runtime);
    expect(factory).toHaveBeenCalledTimes(1);
    await resolver.dispose();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers model-backed built-ins with isolated config directories", () => {
    const dataDir = join(tmpdir(), "everroom-agent-resolver");
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", dataDir], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "main-model",
      NXCORE_AI_BASE_URL: "https://main.example/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_WEB_SEARCH_ENABLED: "true",
      NXCORE_WEB_SEARCH_API_KEY: "search-key",
    });
    const resolver = createAgentResolver(config);

    expect(resolver.list().map(({ id }) => id).sort()).toEqual([BUILTIN_AGENT_IDS.webSearch]);
    for (const agent of resolver.list()) {
      expect(agent.configDirectory).toBe(join(dataDir, "agent", "runtimes", agent.id, "config"));
    }
  });
});

describe("Agent runtime isolation", () => {
  it("scopes cursor completion sessions, workspace, config and runtime id", () => {
    const dataDir = join(tmpdir(), "everroom-cursor-agent");
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", dataDir], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "main-model",
      NXCORE_AI_BASE_URL: "https://main.example/v1",
      NXCORE_AI_API_KEY: "main-key",
    });
    const runtime = createCursorCompletionRuntime(config) as unknown as {
      config: { runtimeId: string; sessionsDir: string; workingDirectory: string; agentDirectory: string };
    };
    const root = join(dataDir, "agent", "runtimes", BUILTIN_AGENT_IDS.cursorCompletion);

    expect(runtime.config).toMatchObject({
      runtimeId: `pi:${BUILTIN_AGENT_IDS.cursorCompletion}`,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    });
  });

  it("keeps OpenAI-compatible calls behind an AgentRuntime", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-agent-runtime-"));
    temporaryDirectories.push(root);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "search-model",
        enable_search: true,
        search_options: { forced_search: true },
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "search result" } }],
        // 真搜索：检索结果注入 prompt，prompt_tokens 远超裸 prompt 量级。
        usage: { prompt_tokens: 2156, total_tokens: 2200 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolver = new AgentResolver();
    resolver.register({
      id: BUILTIN_AGENT_IDS.webSearch,
      name: "Web Search Agent",
      description: "Search",
      configDirectory: join(root, "config"),
      kind: "builtin",
    }, () => new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      baseUrl: "https://search.example/v1",
      apiKey: "secret",
      model: "search-model",
      systemPrompt: "Search",
      requestOptions: { enable_search: true, search_options: { forced_search: true } },
      requireSearch: true,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    }));

    await expect(invokeAgent(resolver, BUILTIN_AGENT_IDS.webSearch, "EverOffice", {
      pageLabel: "search",
    })).resolves.toBe("search result");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://search.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    await resolver.dispose();
  });

  it("rejects silently-skipped searches (no search results injected)", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-agent-nosearch-"));
    temporaryDirectories.push(root);
    // 200 + 正文但 prompt_tokens 等于裸 prompt 量级：上游静默跳过检索（如
    // enable_search 被忽略/中转剥参），模型会拿训练知识冒充检索结果——必须
    // 报错而不是放行。（真实场景：中文系统提示词 ~260 字符 ≈280 token，
    // 搜索注入后 2100~6800。）
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "stale training-data answer" } }],
      // 裸 prompt 量级（本用例 system+prompt 为短 ASCII，≈5 token）：
      // 无搜索注入时 prompt_tokens 就该是这个量级。
      usage: { prompt_tokens: 8, total_tokens: 28 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const resolver = new AgentResolver();
    resolver.register({
      id: BUILTIN_AGENT_IDS.webSearch,
      name: "Web Search Agent",
      description: "Search",
      configDirectory: join(root, "config"),
      kind: "builtin",
    }, () => new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      baseUrl: "https://search.example/v1",
      apiKey: "secret",
      model: "search-model",
      systemPrompt: "Search",
      requestOptions: { enable_search: true, search_options: { forced_search: true } },
      requireSearch: true,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    }));

    await expect(invokeAgent(resolver, BUILTIN_AGENT_IDS.webSearch, "EverOffice", {
      pageLabel: "search",
    })).rejects.toThrow(/no search results were injected/);
    await resolver.dispose();
  });

  it("puts the response locale in the OpenAI system message", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-agent-locale-"));
    temporaryDirectories.push(root);
    let requestBody: { messages?: Array<{ role?: string; content?: string }> } = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(JSON.stringify({ choices: [{ message: { content: "result" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const runtime = new OpenAiCompletionAgentRuntime({
      runtimeId: "locale-test",
      baseUrl: "https://agent.example/v1",
      apiKey: "secret",
      model: "test-model",
      systemPrompt: "Base system prompt",
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    });
    const run = await runtime.start({
      runId: "locale-run",
      sessionId: "locale-session",
      runtimeSessionRef: null,
      prompt: "User-authored request",
      responseLanguage: "de-DE",
      pageLabel: "Agent",
    });
    for await (const _event of run.events) {
      // Drain the runtime so the mocked request completes.
    }

    expect(requestBody.messages?.find((message) => message.role === "system")?.content)
      .toContain("当前界面 locale：de-DE");
    expect(requestBody.messages?.find((message) => message.role === "user")?.content)
      .toBe("User-authored request");
    await runtime.dispose();
  });
});
