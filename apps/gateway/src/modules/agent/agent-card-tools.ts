import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { PiAgentCardDecision, PiAgentCardRequest } from "@nxcore/agent-runtime-pi";

/** 计划卡落地内容（agent_confirm 归一后交给网关侧 recorder 的字段）。 */
export interface AgentConfirmPlanDraft {
  /** 计划文档/计划页任务的标题。 */
  planTitle: string;
  /** 卡片正文（背景、取舍说明）。 */
  body?: string;
  /** 执行步骤。 */
  plan: string[];
  /** 设计决策色板（已归一为 #rrggbb）。 */
  palette: string[];
  fonts?: { heading?: string; body?: string };
  /** 其他风格要点。 */
  notes: string[];
}

/** 计划卡落地结果：云文档 id + 计划页任务 id（任务未建成为 null）。 */
export interface AgentConfirmPlanRecord {
  documentId: string;
  documentTitle: string;
  planItemId: string | null;
  planItemTitle: string;
}

export interface AgentCardToolOptions {
  /**
   * 把带设计决策的计划卡落成「工作空间云文档 + 计划页任务」。
   * 未装配（部分单测/无桌面场景）时跳过落地，出卡与确认流程不受影响。
   * 落地失败不影响出卡：错误如实回传给模型，由最终答复向用户说明。
   */
  persistPlan?: (
    input: StartRuntimeRunInput,
    draft: AgentConfirmPlanDraft,
  ) => Promise<AgentConfirmPlanRecord>;
}

/** 卡片正文里的落地回执（跟随用户 locale；标题只给名称，不暴露内部 id）。 */
function planSavedNote(language: string | null | undefined, record: AgentConfirmPlanRecord): string {
  if (/^en/i.test((language ?? "").trim())) {
    return record.planItemId
      ? `The plan is saved as cloud document "${record.documentTitle}" and added to the Plans page.`
      : `The plan is saved as cloud document "${record.documentTitle}".`;
  }
  return record.planItemId
    ? `计划已存为云文档《${record.documentTitle}》，并已加入计划页「${record.planItemTitle}」。`
    : `计划已存为云文档《${record.documentTitle}》。`;
}

/**
 * 通用交互卡工具面：agent_confirm（计划确认卡）与 agent_ask_user（提问卡）。
 *
 * 卡片经 AgentService.requestAgentCard → PiAgentRuntime.requestAgentCard 推进
 * 当前 run 的事件流（approval.requested kind="card"），阻塞等待用户在 UI 上
 * 作答；桌面端 POST /v1/agent/approvals/:id/resolve 带 choice/text 回填。
 * 超时按「confirm=denied / question=空答」收口，工具拿到正常返回而非异常。
 */
export function createAgentCardTools(
  requestCard: (runId: string, card: PiAgentCardRequest["card"]) => Promise<PiAgentCardDecision>,
  options: AgentCardToolOptions = {},
): PiAgentRuntimeTool[] {
  const confirm: PiAgentRuntimeTool = {
    name: "agent_confirm",
    label: "计划确认卡",
    description: "向用户展示计划确认卡，等用户点确认或取消后继续。用于动手前对齐："
      + "生成整册 PPT、批量改写、删除类操作等长任务先出卡（标题 + plan 步骤列表）；"
      + "PPT 整册生成必须带 palette（2~5 个 hex 色板，按 主色/次色/强调 顺序）与 "
      + "fonts（标题/正文字体），选定深浅结构再带 notes（如「深色封面 + 浅色内容页」），"
      + "用户在卡片上直接看到色块与字体再决定。"
      + "带 palette 的计划卡（演示文稿整册）会自动存成一份工作空间云文档并登记到计划页，"
      + "用户可在「云文档」里读改、在计划页上跟踪；卡片上会带「打开计划云文档」入口，步骤在文档里读全文。用 planTitle 指定计划标题（缺省用卡片 title）。"
      + "用户确认返回 choice=approved；取消返回 denied，text 带用户反馈——按反馈调整后重新出卡，"
      + "不要在取消后擅自继续原计划；同一轮里重新出卡会复用同一份计划文档与计划条目，不会重复创建。"
      + "10 分钟无应答自动取消。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "卡片标题，一句话说清将做什么（如「将生成 8 页产品介绍演示文稿」）" },
        plan: {
          type: "array",
          items: { type: "string" },
          description: "计划/步骤列表，按执行顺序每步一行",
        },
        palette: {
          type: "array",
          items: { type: "string" },
          description: "设计决策色板：2~5 个 hex 色值，按 主色/次色/强调 顺序（PPT 生成必带）",
        },
        fonts: {
          type: "object",
          properties: {
            heading: { type: "string", description: "标题字体名" },
            body: { type: "string", description: "正文字体名" },
          },
          description: "标题/正文字体（PPT 生成必带）",
        },
        notes: {
          type: "array",
          items: { type: "string" },
          description: "其他风格要点（如「深色封面 + 浅色内容页」）",
        },
        planTitle: {
          type: "string",
          description: "计划文档与计划页任务的标题（可选，≤120 字；缺省用卡片 title）。"
            + "写成用户看得懂的计划名，如「产品介绍演示文稿制作计划」",
        },
        persistPlan: {
          type: "boolean",
          description: "是否把这份计划存为云文档并登记到计划页。缺省：带 palette 的演示文稿计划自动保存；"
            + "其他长任务卡默认不保存（需要留档时显式传 true）",
        },
        body: { type: "string", description: "补充说明（可选）：背景、取舍原因、影响范围" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    promptSnippet: "计划确认卡",
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const title = typeof params.title === "string" ? params.title.trim() : "";
      if (!title) throw new Error("agent_confirm 参数 title 不能为空");
      const plan: string[] = Array.isArray(params.plan)
        ? params.plan.flatMap((step) => (typeof step === "string" && step.trim() ? [step.trim().slice(0, 500)] : [])).slice(0, 30)
        : [];
      const palette: string[] = Array.isArray(params.palette)
        ? params.palette.flatMap((color) => {
          if (typeof color !== "string") return [];
          // 宽容归一：模型常写不带 # 的裸 hex（"0E1B2A"）或带 #，
          // 只认严格 #rrggbb 会把整个色板滤空（2026-11-09 实测 palette:[]）。
          const value = color.trim().replace(/^#/, "");
          if (/^[0-9a-fA-F]{6}$/.test(value)) return [`#${value.toLowerCase()}`];
          // 再容忍「海军蓝 #0E1B2A」这类带名称的写法：取第一段 hex。
          const embedded = /#([0-9a-fA-F]{6})\b/.exec(color) ?? /\b([0-9a-fA-F]{6})\b/.exec(color);
          return embedded ? [`#${embedded[1]!.toLowerCase()}`] : [];
        }).slice(0, 5)
        : [];
      const fonts: { heading?: string; body?: string } | undefined =
        params.fonts !== null && typeof params.fonts === "object" && !Array.isArray(params.fonts)
          ? (() => {
            const raw = params.fonts as { heading?: unknown; body?: unknown };
            const normalized = {
              ...(typeof raw.heading === "string" && raw.heading.trim()
                ? { heading: raw.heading.trim().slice(0, 100) }
                : {}),
              ...(typeof raw.body === "string" && raw.body.trim()
                ? { body: raw.body.trim().slice(0, 100) }
                : {}),
            };
            return Object.keys(normalized).length ? normalized : undefined;
          })()
          : undefined;
      const notes: string[] = Array.isArray(params.notes)
        ? params.notes.flatMap((note) => (typeof note === "string" && note.trim() ? [note.trim().slice(0, 300)] : [])).slice(0, 10)
        : [];

      // 计划落地：带色板的计划（演示文稿整册）默认存云文档 + 登计划页；显式
      // persistPlan=false 才关掉。落地失败不拦出卡，错误如实回传给模型。
      const persistRequested = params.persistPlan === false
        ? false
        : params.persistPlan === true || palette.length > 0;
      let planRecord: AgentConfirmPlanRecord | null = null;
      let planSaveError: string | null = null;
      if (persistRequested && options.persistPlan) {
        const planTitle = typeof params.planTitle === "string" && params.planTitle.trim()
          ? params.planTitle.trim().slice(0, 120)
          : title.slice(0, 120);
        try {
          planRecord = await options.persistPlan(input, {
            planTitle,
            ...(typeof params.body === "string" && params.body.trim()
              ? { body: params.body.trim().slice(0, 2_000) }
              : {}),
            plan,
            palette,
            ...(fonts ? { fonts } : {}),
            notes,
          });
        } catch (error) {
          planSaveError = error instanceof Error ? error.message : String(error);
        }
      }

      const bodyCandidate = typeof params.body === "string" ? params.body.trim() : "";
      const receipt = planRecord ? planSavedNote(input.responseLanguage, planRecord) : "";
      const body = [bodyCandidate, receipt].filter(Boolean).join("\n\n").slice(0, 2_000);
      const card: PiAgentCardRequest["card"] = {
        kind: "confirm",
        title: title.slice(0, 200),
        ...(body ? { body } : {}),
        ...(plan.length ? { plan } : {}),
        ...(palette.length ? { palette } : {}),
        ...(fonts ? { fonts } : {}),
        ...(notes.length ? { notes } : {}),
        // 计划已落成云文档时把入口带上：卡片不再只是步骤清单，用户可先读文档再确认。
        ...(planRecord
          ? { document: { id: planRecord.documentId, title: planRecord.documentTitle } }
          : {}),
      };
      const decision = await requestCard(input.runId, card);
      const planDetails = planRecord
        ? {
          documentId: planRecord.documentId,
          documentTitle: planRecord.documentTitle,
          navigation: { title: planRecord.documentTitle, action: "created", objectType: "document" },
          planItemId: planRecord.planItemId,
        }
        : {};
      const planHint = planRecord
        ? (planRecord.planItemId
          ? `计划已存为云文档《${planRecord.documentTitle}》并登记到计划页（planItemId=${planRecord.planItemId}）。整册生成完成或明确失败后调用 plan_update 收口这条任务（完成时 status=done 并写 resultSummary）。`
          : `计划已存为云文档《${planRecord.documentTitle}》。`)
        : planSaveError
          ? `计划未能存为云文档/计划页（${planSaveError}）。最终答复里如实告知用户，不要把保存说成成功。`
          : "";
      return {
        content: JSON.stringify({
          choice: decision.choice,
          ...(decision.text ? { text: decision.text } : {}),
          hint: decision.choice === "approved"
            ? "用户已确认，按计划继续执行。"
            : "用户未确认。text 是用户反馈（可能为空/timeout）：有反馈就按反馈调整后重新出卡；无反馈且任务可缩减就缩小范围重新出卡，不要原样重发。",
          ...(planRecord ? { plan: { documentId: planRecord.documentId, documentTitle: planRecord.documentTitle, planItemId: planRecord.planItemId } } : {}),
          ...(planSaveError ? { planSaveError } : {}),
          ...(planHint ? { planHint } : {}),
        }),
        details: { ...planDetails, ...(planSaveError ? { planSaveError } : {}) },
      };
    },
  };

  const askUser: PiAgentRuntimeTool = {
    name: "agent_ask_user",
    label: "提问卡",
    description: "向用户提一个问题并等待回答。只用于无法从上下文与工具推断的关键分歧："
      + "方向二选一、关键参数缺失、素材歧义。能给选项就给 options（按钮），"
      + "allowText=true 时用户也可自由输入。返回 choice=所选选项或用户输入文本（text）。"
      + "能推断的不要问；一次只问一个问题；连续提问不超过 2 次，仍不够就按最合理假设继续并说明。"
      + "10 分钟无应答自动取消（choice 为空）。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "问题本身，一句话只问一个关键分歧点" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "候选答案（按钮）；不传则用户只能自由输入",
        },
        allowText: { type: "boolean", description: "允许自由输入补充（默认 true）" },
        context: { type: "string", description: "补充上下文（可选）：为什么问、两个选项分别意味着什么" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    promptSnippet: "提问卡",
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) throw new Error("agent_ask_user 参数 question 不能为空");
      const card: PiAgentCardRequest["card"] = {
        kind: "question",
        title: question.slice(0, 500),
        ...(typeof params.context === "string" && params.context.trim()
          ? { body: params.context.trim().slice(0, 2_000) }
          : {}),
        ...(Array.isArray(params.options)
          ? {
            options: params.options.flatMap((option) =>
              typeof option === "string" && option.trim() ? [option.trim().slice(0, 200)] : [],
            ).slice(0, 6),
          }
          : {}),
        ...(typeof params.allowText === "boolean" ? { allowText: params.allowText } : {}),
      };
      const decision = await requestCard(input.runId, card);
      return {
        content: JSON.stringify({
          choice: decision.choice,
          ...(decision.text ? { text: decision.text } : {}),
          hint: decision.choice.trim()
            ? "已收到用户作答，按答案继续。"
            : "用户未作答（超时或取消）：不要重复追问同一问题，按最合理假设继续并向用户说明该假设。",
        }),
      };
    },
  };

  return [confirm, askUser];
}
