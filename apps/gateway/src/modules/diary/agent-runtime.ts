import { join } from "node:path";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../../config.js";
import { loadBuiltinAgentBundle } from "../agent/builtin-bundles.js";
import { isPiRuntimeConfigured } from "../agent/runtime-factory.js";
import { BUILTIN_AGENT_IDS, type AgentDefinition, type AgentResolver } from "../agent/resolver.js";
import type { DiaryAgentGenerator } from "./agent-generator.js";

/**
 * Phase 1 迁出：日记运行时的工厂原本住在 modules/agent/runtime-factory，
 * 造成存活模块反向依赖将被删除的 diary。挪到 diary 模块内部，
 * 依赖方向变成 diary → agent（单向），Phase 2 随 diary 一起删除。
 */

function definition(config: GatewayConfig, input: Omit<AgentDefinition, "configDirectory" | "kind">): AgentDefinition {
  return {
    ...input,
    configDirectory: join(config.dataDir, "agent", "runtimes", input.id, "config"),
    kind: "builtin",
  };
}

function builtin(id: (typeof BUILTIN_AGENT_IDS)[keyof typeof BUILTIN_AGENT_IDS]) {
  return loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id);
}

/** 日记使用隔离的 Pi Runtime，只暴露来源清单读取工具。 */
export function createDiaryAgentRuntime(
  config: GatewayConfig,
  generator: DiaryAgentGenerator,
): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const bundle = builtin(BUILTIN_AGENT_IDS.diary);
  const { memory: _memory, knowledge: _knowledge, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    runtimeId: `pi:${BUILTIN_AGENT_IDS.diary}`,
    maxTokens: config.diaryMaxTokens ?? Math.max(pi.maxTokens, 16_384),
    includeBashTool: false,
    maxToolCallsPerRun: 128,
    runtimeRole: "internal",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
    sessionsDir: join(pi.sessionsDir, "diary"),
    workingDirectory: join(pi.workingDirectory, "diary"),
    agentDirectory: join(pi.agentDirectory, "diary"),
  }, { tools: generator.tools() });
}

export function registerDiaryAgent(
  resolver: AgentResolver,
  config: GatewayConfig,
  generator: DiaryAgentGenerator,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.diary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.diary,
    name: bundle.name,
    description: bundle.description,
  }), () => createDiaryAgentRuntime(config, generator)
    ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.diary));
}