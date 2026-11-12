import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentCardDecision, PiAgentCardRequest } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { createAgentCardTools, type AgentConfirmPlanDraft } from "../src/modules/agent/agent-card-tools.js";

function runInput(): StartRuntimeRunInput {
  return {
    runId: "run-card-1",
    sessionId: "session-card-1",
    runtimeSessionRef: null,
    prompt: "生成 PPT",
    pageLabel: "Agent",
  } as unknown as StartRuntimeRunInput;
}

function harness(decision: PiAgentCardDecision) {
  const requested: PiAgentCardRequest["card"][] = [];
  const tools = createAgentCardTools(async (_runId, card) => {
    requested.push(card);
    return decision;
  });
  const confirm = tools.find((tool) => tool.name === "agent_confirm")!;
  const askUser = tools.find((tool) => tool.name === "agent_ask_user")!;
  return { requested, confirm, askUser };
}

describe("createAgentCardTools（通用决策卡工具面）", () => {
  it("agent_confirm 组装 confirm 卡（title/plan/palette/fonts/notes）并回传用户决策", async () => {
    const { requested, confirm } = harness({ choice: "approved" });

    const result = await confirm.execute(runInput(), {
      title: "将生成 8 页产品介绍演示文稿",
      plan: ["读取材料", "写脚本", "生成 pptx"],
      palette: ["#0B5FFF", "#F5F7FA", "#FF6B35"],
      fonts: { heading: "Source Han Sans", body: "PingFang SC" },
      notes: ["深色封面 + 浅色内容页"],
      body: "素材来自工作区 3 份文档",
    });

    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      kind: "confirm",
      title: "将生成 8 页产品介绍演示文稿",
      plan: ["读取材料", "写脚本", "生成 pptx"],
      palette: ["#0b5fff", "#f5f7fa", "#ff6b35"],
      fonts: { heading: "Source Han Sans", body: "PingFang SC" },
      notes: ["深色封面 + 浅色内容页"],
      body: "素材来自工作区 3 份文档",
    });
    const payload = JSON.parse(result.content) as { choice: string };
    expect(payload.choice).toBe("approved");
  });

  it("agent_confirm 用户取消时回传 denied 与反馈文本", async () => {
    const { confirm } = harness({ choice: "denied", text: "换成暖色" });

    const result = await confirm.execute(runInput(), { title: "生成计划" });

    const payload = JSON.parse(result.content) as { choice: string; text?: string };
    expect(payload.choice).toBe("denied");
    expect(payload.text).toBe("换成暖色");
  });

  it("agent_confirm 剔除非法色板值（只保留 #rrggbb）", async () => {
    const { requested, confirm } = harness({ choice: "approved" });

    await confirm.execute(runInput(), {
      title: "生成计划",
      palette: ["#0B5FFF", "red", "#xyz", "#0b5ff"],
    });

    expect(requested[0]!.palette).toEqual(["#0b5fff"]);
  });

  it("agent_ask_user 组装 question 卡（options）并把所选选项作为 choice 回传", async () => {
    const { requested, askUser } = harness({ choice: "深色科技风", text: "深色科技风" });

    const result = await askUser.execute(runInput(), {
      question: "整套 PPT 用哪种基调？",
      options: ["深色科技风", "浅色商务风"],
    });

    expect(requested[0]).toMatchObject({
      kind: "question",
      title: "整套 PPT 用哪种基调？",
      options: ["深色科技风", "浅色商务风"],
    });
    const payload = JSON.parse(result.content) as { choice: string };
    expect(payload.choice).toBe("深色科技风");
  });

  it("agent_ask_user 超时（空答）时 hint 指示不要重复追问", async () => {
    const { askUser } = harness({ choice: "", text: "timeout" });

    const result = await askUser.execute(runInput(), { question: "基调选哪种？" });

    const payload = JSON.parse(result.content) as { choice: string; text?: string; hint: string };
    expect(payload.choice).toBe("");
    expect(payload.text).toBe("timeout");
    expect(payload.hint).toContain("不要重复追问");
  });

  it("缺 title/question 直接拒绝", async () => {
    const { confirm, askUser } = harness({ choice: "approved" });
    await expect(confirm.execute(runInput(), {})).rejects.toThrow("title");
    await expect(askUser.execute(runInput(), {})).rejects.toThrow("question");
  });
});

describe("createAgentCardTools · 计划落地（云文档 + 计划页）", () => {
  function persistHarness(decision: PiAgentCardDecision) {
    const requested: PiAgentCardRequest["card"][] = [];
    const drafts: AgentConfirmPlanDraft[] = [];
    const persistPlan = async (_input: StartRuntimeRunInput, draft: AgentConfirmPlanDraft) => {
      drafts.push(draft);
      return {
        documentId: "doc-plan-1",
        documentTitle: draft.planTitle,
        planItemId: "plan-item-1",
        planItemTitle: draft.planTitle,
      };
    };
    const tools = createAgentCardTools(async (_runId, card) => {
      requested.push(card);
      return decision;
    }, { persistPlan });
    return { requested, drafts, confirm: tools.find((tool) => tool.name === "agent_confirm")! };
  }

  it("带 palette 的计划卡自动落地，并在卡片正文里给出回执", async () => {
    const { requested, drafts, confirm } = persistHarness({ choice: "approved" });

    const result = await confirm.execute(runInput(), {
      title: "将生成 8 页产品介绍演示文稿",
      planTitle: "产品介绍演示文稿制作计划",
      plan: ["读取材料", "写脚本", "生成 pptx"],
      palette: ["#0B5FFF", "#F5F7FA", "#FF6B35"],
      fonts: { heading: "Source Han Sans", body: "PingFang SC" },
      notes: ["深色封面 + 浅色内容页"],
      body: "素材来自工作区 3 份文档",
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      planTitle: "产品介绍演示文稿制作计划",
      plan: ["读取材料", "写脚本", "生成 pptx"],
      palette: ["#0b5fff", "#f5f7fa", "#ff6b35"],
      fonts: { heading: "Source Han Sans", body: "PingFang SC" },
      notes: ["深色封面 + 浅色内容页"],
      body: "素材来自工作区 3 份文档",
    });
    expect(requested[0]!.body).toContain("计划已存为云文档《产品介绍演示文稿制作计划》");
    expect(requested[0]!.body).toContain("并已加入计划页");
    expect(requested[0]!.document).toEqual({
      id: "doc-plan-1",
      title: "产品介绍演示文稿制作计划",
    });
    const payload = JSON.parse(result.content) as {
      choice: string;
      plan?: { documentId: string; planItemId: string };
      planHint?: string;
    };
    expect(payload.plan).toMatchObject({ documentId: "doc-plan-1", planItemId: "plan-item-1" });
    expect(payload.planHint).toContain("planItemId=plan-item-1");
    expect(result.details).toMatchObject({
      documentId: "doc-plan-1",
      navigation: { title: "产品介绍演示文稿制作计划" },
    });
  });

  it("无色板的长任务卡默认不落地", async () => {
    const { drafts, confirm } = persistHarness({ choice: "approved" });

    await confirm.execute(runInput(), { title: "批量改写 10 篇文档", plan: ["逐篇改写"] });

    expect(drafts).toHaveLength(0);
  });

  it("persistPlan=false 可显式关闭落地", async () => {
    const { drafts, confirm } = persistHarness({ choice: "approved" });

    await confirm.execute(runInput(), {
      title: "将生成 8 页演示文稿",
      palette: ["#0B5FFF"],
      persistPlan: false,
    });

    expect(drafts).toHaveLength(0);
  });

  it("落地失败不拦出卡：错误如实回传，不谎报已保存", async () => {
    const requested: PiAgentCardRequest["card"][] = [];
    const tools = createAgentCardTools(
      async (_runId, card) => {
        requested.push(card);
        return { choice: "approved" };
      },
      { persistPlan: async () => { throw new Error("document busy"); } },
    );
    const confirm = tools.find((tool) => tool.name === "agent_confirm")!;

    const result = await confirm.execute(runInput(), {
      title: "将生成 8 页演示文稿",
      palette: ["#0B5FFF"],
    });

    expect(requested).toHaveLength(1);
    expect(requested[0]!.body ?? "").not.toContain("已存为云文档");
    const payload = JSON.parse(result.content) as { planSaveError?: string; planHint?: string };
    expect(payload.planSaveError).toBe("document busy");
    expect(payload.planHint).toContain("如实告知");
  });
});
