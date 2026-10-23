import { describe, expect, it } from "vitest";
import { resolveSubagentReasoning, resolveSubagentRuntimeBase } from "../src/modules/subagents/runtime-manager.js";

/**
 * 推理档位解算：实测单页 165s 里 98% 是模型推理（工具只占 4s），
 * 想继续压时长只能动推理量。这条通路让「medium vs low」的 A/B 不必改 agent.yaml，
 * 而缺省不设时必须与改造前完全一致——这是本测试的重点。
 */
describe("resolveSubagentReasoning", () => {
  it("缺省不设时沿用全局档位，slides 与非 slides 一视同仁", () => {
    expect(resolveSubagentReasoning({ agentId: "slides-layouter", fallback: "medium" })).toBe("medium");
    expect(resolveSubagentReasoning({ agentId: "context-room", fallback: "medium" })).toBe("medium");
  });

  it("bundle 自己的 policy.model.reasoning 最优先", () => {
    expect(resolveSubagentReasoning({
      policyReasoning: "high",
      agentId: "slides-layouter",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("high");
  });

  it("env 覆盖只作用于 slides-*，不影响交互链路", () => {
    expect(resolveSubagentReasoning({
      agentId: "slides-layouter",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("low");
    expect(resolveSubagentReasoning({
      agentId: "slides-planner",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("low");
    // 交互链路保持全局档位：context-room 的体验不该被 PPT 的 A/B 牵连。
    expect(resolveSubagentReasoning({
      agentId: "context-room",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("medium");
  });

  it("全局也没有档位时返回 undefined（交给 runtime 缺省）", () => {
    expect(resolveSubagentReasoning({ agentId: "slides-layouter" })).toBeUndefined();
  });
});

/**
 * 模型底座解算：布局代理必须跑在视觉档（SaaS 下发的 vlm 槽模型）上——它要自己看
 * 渲染图自查；审页代理已砍，别再让布局停在纯文本的 background 上。
 */
describe("resolveSubagentRuntimeBase", () => {
  const pi = { provider: "openai", model: "text-main", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never;
  const backgroundPi = { provider: "openai", model: "text-bg", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never;
  const visionPi = { provider: "qwen", model: "qwen3.8-flash", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never;

  it("布局代理拿视觉档（vlm 槽模型），不是 background", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", visionPi, backgroundPi, pi })).toBe(visionPi);
  });

  it("其余子代理仍走 background，不被视觉档串味", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-planner", visionPi, backgroundPi, pi })).toBe(backgroundPi);
    expect(resolveSubagentRuntimeBase({ agentId: "context-room", visionPi, backgroundPi, pi })).toBe(backgroundPi);
  });

  it("视觉来源切成 background 时布局直接用主模型（主模型自己多模态的场景）", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", visionSource: "background", visionPi, backgroundPi, pi })).toBe(backgroundPi);
    // 不设来源＝默认走槽，行为与改造前一致。
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", visionSource: "slot", visionPi, backgroundPi, pi })).toBe(visionPi);
  });

  it("视觉档未配置（model 为空）时回退 background，布局不因缺槽停摆", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", visionPi: null, backgroundPi, pi })).toBe(backgroundPi);
    expect(resolveSubagentRuntimeBase({
      agentId: "slides-layouter",
      visionPi: { provider: "qwen", model: "", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never,
      backgroundPi,
      pi,
    })).toBe(backgroundPi);
  });

  it("background 也缺时退到全局 pi；全缺返回 null（交给调用方报错）", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", backgroundPi: null, pi })).toBe(pi);
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter" })).toBeNull();
  });
});
