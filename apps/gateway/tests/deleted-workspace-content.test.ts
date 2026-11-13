import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSession, AgentWorkspace } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-deleted-space-ppt-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "test-token-0123456789",
    agentRuntime: "fake",
    pi: null,
    cursorCompletionPi: null,
    litePi: null,
    backgroundPi: null,
    webSearch: null,
    mcpConfigPath: join(dataDir, "agent", "mcp.json"),
  };
}

describe("deleted workspace content must not reappear", () => {
  it("deleting a workspace removes its sessions instead of re-homing them to the default workspace", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "模拟个人人生" },
    })).json<AgentWorkspace>();

    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "工作台", workspaceId: workspace.id },
    })).json<AgentSession>();
    expect(session.workspaceId).toBe(workspace.id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);

    // The deleted workspace's sessions must not reappear under the default
    // workspace (the view the home-page PPT button opens).
    const allSessions = (await app.inject({ method: "GET", url: "/v1/agent/sessions", headers }))
      .json<AgentSession[]>();
    expect(allSessions.some((item) => item.id === session.id)).toBe(false);

    const workspaces = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(workspaces.map((item) => item.id)).toEqual(["default"]);
    await app.close();
  });

  it("refuses to delete a workspace while one of its sessions is running", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "项目 A" },
    })).json<AgentWorkspace>();

    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "工作台", workspaceId: workspace.id },
    })).json<AgentSession>();

    // Mark the session as running directly through a run start on the fake runtime
    // is heavyweight; instead simulate by updating status via the updateSession path
    // is unavailable — so start a real run through startRun on the fake runtime.
    const run = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: { prompt: "跑起来", idempotencyKey: "guard-test-0001" },
    });
    expect(run.statusCode).toBe(202);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json<{ error: string }>().error).toBe("session_busy");

    // The workspace and its running session survive the refused delete.
    const workspaces = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(workspaces.some((item) => item.id === workspace.id)).toBe(true);
    await app.close();
  });
});
