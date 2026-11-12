# Harness 搜索数据能力基准测试方案（设计稿）

> 定位（2026-11-11 与用户确认）：量化 **harness 搜索链路本身的数据能力**（检索命中、新鲜度、来源覆盖、引用忠实度、延迟、成本），并与同类产品的搜索后端对比。**不是**测基础模型的推理/答题能力——公开 QA 基准只作题库与金标来源，不作端到端跑法。
>
> 状态：设计稿。指标出处与竞品 API 对比表见两份调研笔记（见文末链接），落地实施待调研合入后启动。

## 一、被测对象盘点（代码勘察结论）

产品内有两条独立的搜索链路，能力边界不同，必须分开评测。

### Path A：网关 web_search（主 Agent 链路）

```
主 Agent ──web_search 工具──> 内置 web-search agent（agents/web-search/）
  ──openai-completions 运行时──> 百炼 compatible-mode 端点
  （requestOptions: { enable_search: true }，检索发生在端点内部）
```

- 代码位置：`apps/gateway/src/modules/agent/web-search-tools.ts`（工具壳）、`apps/gateway/src/modules/agent/runtime-factory.ts`（`enable_search: true` 注入，两处）、`agents/web-search/SYSTEM.md`（输出约束：标注来源线索、结果不可信声明）。
- 配置来源：`NXCORE_WEB_SEARCH_*` 环境变量（默认 qwen-plus / DashScope compatible-mode）或运行时配置 UI（密钥专存）；SaaS 中继可覆盖。未配置时 `web_search` 工具不注册。
- **关键边界：原始搜索结果对 harness 不可见**。`enable_search` 在模型端点内部完成检索，harness 只拿回整理后的自然语言文本（含"来源线索"，但无结构化 URL 列表保证）。调研确认（笔记 A §4）：这是 OpenAI 兼容协议的固有限制——**DashScope 原生协议加 `enable_source` 可返回 `search_info.search_results`（URL/标题），Responses API 的 `web_search_call.action.sources` 也可拿 URL**。若评测需要来源层指标，Path A 有协议升级路径，但无 freshness/域名过滤参数（`search_strategy` 仅 agent）。
- 预算与超时：走 `ExternalCallBudgetService`（`WEB_SEARCH` 类目），单次 60s 超时。

### Path B：genoffice 内置搜索（docs/slides 应用链路）

```
renderer ──window.*Api.webSearch──> 主进程 ai-search 包
  三级回退：gsk(Genspark 云) → Serper(Google SERP) → DuckDuckGo HTML
```

- 代码位置：`apps/desktop/vendor/genoffice/packages/ai-search/src/index.ts`、`src/gsk.ts`。
- 返回结构：`{ results: {title, url, snippet}[], answer?, method: 'gsk'|'serper'|'duckduckgo'|'error' }`；Serper 层另有 answerBox / knowledgeGraph 提取为 `answer`。
- **纯 API 层，无 LLM 在环**——L0 评测的天然对象；`method` 标记支持按后端分层统计。
- 已知设计特征（转译为评测假设）：
  1. Serper 请求硬编码 `gl: 'us', hl: 'en'` → **中文查询预期显著弱于英文**（基准需中英分层验证）；
  2. DuckDuckGo 回退层只解析标题+URL，**无 snippet** → snippet 类指标按构造为 0；
  3. gsk 依赖 Genspark 凭据（本地 .env 未配），无凭据时静默降级到 Serper；
  4. 图片搜索有版权域名黑名单（COPYRIGHT_HOSTS），影响图搜覆盖指标。
- slides 应用有"图表数据必须先真实 web_search"的 provenance 门（`data-source-gate.test.ts`），说明该链路承担事实供给职责，质量直接影响产物可信度。

### 程序化驱动通道（评测 harness 的接入点）

- Path A：`POST /v1/agent/sessions` + `POST /v1/agent/sessions/:sessionId/runs`（Bearer `NXCORE_GATEWAY_TOKEN`；prompt/idempotencyKey/targetAgentId；SSE `/stream`）。驱动范式参考 `scripts/agent-debug-smoke.mjs`。
- Path B：直接 `node` 调 vendored 包（单测已有 Serper mock 先例 `search.test.ts`），或抽成独立 probe 脚本。

## 二、评测分层设计

| 层 | 回路内容 | 对象 | 能回答的问题 |
|---|---|---|---|
| **L0 纯搜索 API 层** | 无 LLM | Path B 三后端 + 竞品 API（Tavily/Serper/博查/Brave/Exa/Jina/Sonar 等） | 裸检索质量：命中、新鲜度、覆盖、延迟、成本 |
| **L0.5 端点内置检索层** | 端点内检索（模型仅做"转述"） | Path A（百炼 enable_search） | 用受限输出探针（要求逐条罗列结果与 URL）逼近 L0；残余混入模型转述噪声，需标注 |
| **L1 固定模型换搜索后端** | 同一模型 + 不同搜索供给 | Path A/B 与竞品后端 | 隔离"搜索贡献"：同题同模型，只换搜索数据源，看答案层差异 |
| **L2 产品级对比** | 完整产品 | 本产品 vs 竞品（Perplexity/Kimi/Genspark 等） | Search Arena 式成对评审：正确性/新鲜度/引用质量/覆盖 |

原则：先 L0 定位问题在数据层还是模型层，再决定是否需要 L1/L2。L0 弱则换后端/加参数；L0 强答案弱则是 harness 装配或模型问题。

## 三、指标集（草案；定义与出处以调研笔记为准）

**检索质量**
- hit@k / MRR：top-k 结果是否命中金标（答案字符串包含或金标 URL 命中）
- gold-URL recall@k：金标支撑文档 URL 出现率（FRAMES 类带金标来源的题库可用）
- snippet 答案包含率：答案是否出现在 title+snippet 拼接内（免点开页面的可用性）

**新鲜度（FreshQA 方法论）**
- 按 never-changing / slow-changing / fast-changing 分层出题
- freshness lag：返回内容的日期 vs 事实已知更新日期
- 时效题正确率：答案随时间变化的事实（汇率/版本号/在任者）

**来源质量**
- 域名覆盖与多样性（唯一 host 数、权威域名占比——可按题类定制白名单）
- 引用忠实度：答案中的 URL 是否真实出现在返回结果中（反编造）；citation precision/recall 定义借用 ALCE
- Path A 专有：来源线索可核实率（SYSTEM.md 要求标注来源，验证其真实存在于结果）

**工程指标**
- 延迟 P50/P95（Path A 含预算排队需剔除；Path B 按 method 分层）
- 成本 per 1k 查询（各 API 官方定价）
- 错误率 / 回退触发率（Path B 的 method 分布本身就是健康信号）
- 中英查询分层（Path B 的 gl/hl 硬编码使该分层为必做项）

## 四、题库构建

1. 公开基准抽题组 mini set（作金标来源）：SimpleQA（短事实+参考答案）、FRAMES（带金标支撑文档）、FreshQA（新鲜度分层）、BrowseComp-ZH（中文深搜难题，取子集测上限）。规模建议各 100–200，中英平衡。
2. 自建办公场景时效题：汇率/股价/政策日期/软件版本/节假日安排/新闻事件，答案带明确时间戳，可自动核验。
3. 防污染：时效题按周滚动更新；静态题只用于相对对比（同题跨后端），不用绝对分 cross-model 排名。

## 五、实施形态（对齐仓库惯例）

- 脚本：`scripts/web-search-bench.mjs`（node，无新依赖），子命令 `run`（跑题集落 JSONL）/ `score`（算指标）/ `report`（Markdown+表格），`--backend path-a|path-b|tavily|serper|bocha|...`。
- 输出目录：`.local/web-search-bench/<日期>-<配置组>/`（对齐 slides 评测的 report.json 惯例，不入 Git）。
- 文档：结果写回本文件附录或 `docs/notes/`，格式对齐 `*-test-cases.zh-CN.md`（提示词→预期→验证点）文化。
- 判分：答案层用 LLM-as-judge（固定 judge 模型+双盲顺序）+ 字符串包含快筛；L0 层纯确定性计算，不需要 LLM。

## 六、调研合入结论（两份笔记已交付并经 Lead 抽查核实）

- [x] 指标规范出处（BEIR / ALCE / FreshQA / CRAG / Search Arena）→ [docs/notes/search-data-layer-benchmark-research.md](notes/search-data-layer-benchmark-research.md) §2 指标表 + §3 方法论
- [x] 竞品搜索 API 能力/定价/中文支持对比表（同上笔记 §4，13 家；Brave/Jina/Perplexity 官方页因网络阻断未核实，已标注）
- [x] **百炼能力边界确认（关键）**：百炼联网搜索是模型服务端 grounding 工具，无独立检索端点、无 freshness/域名过滤参数；`search_strategy` 仅支持 agent。**OpenAI 兼容协议（本项目 Path A 现用的 `enable_search: true`）不返回搜索来源**；DashScope 原生协议 `enable_source` 可拿到 `search_info.search_results`（URL/标题）。计费 = 模型 token + 搜索策略费（agent 策略 $0.573411/千次，新加坡区 $10/千次）。→ Path A 天然只能进 L1；若要在 L0.5 拿到来源，需切 DashScope 原生协议或 Responses API 的 `web_search_call`。
- [x] 公开题库核实（Lead 亲自下载验证）：SimpleQA 公开 CSV **4,326 题全量有效**（`problem`/`answer`/`metadata.urls`；初版调研误记 1,199，已更正）；FRAMES test.tsv 824 题（`Prompt`/`Answer`/`wiki_links` 金标 URL 2–15 篇/题）。两者均可离线算指标，均为英文——中文需自建（借 FreshQA 四分类 + false-premise 设计）。
- [x] 同类产品公开信息（Kimi 有独立搜索 API Basic/Pro/fetch 三端点、Perplexity Sonar、Gemini Grounding；豆包/WPS/Notion/Genspark/Manus 后端未公开——"未能确认"清单见笔记 §5）
- [x] 端到端评测框架选型（promptfoo trajectory:* 断言 / DeepEval ToolCorrectness+TaskCompletion）→ [docs/web-search-benchmark-options.zh-CN.md](web-search-benchmark-options.zh-CN.md) §3

**调研更正记录**：FreshQA 正确 arXiv 编号 2310.03214（非 2211.04207）；CRAG 2406.04744（非 2401.17791）；Search Arena 2506.05334（非 2505.23915）；"NIPA 版 Deep Research Bench (2506.16263)"不存在（该编号实为机器人论文 CapsDT），同名基准实为人大 muset 的 2506.11763 与 FutureSearch 的 2506.06287。

**三层设计的方法论锚点**（出处见笔记）：
- L0：BEIR 的 IR 指标规范（hit@k / MRR / nDCG@10 / recall@k）；打分前先跑 BM25 基线（BEIR 结论：BM25 是强基线）
- L1：Tavily 官方 Company Search benchmark 的"固定模型 + 固定 judge + 只换搜索来源"设计为直接模板；检索侧指标用 ALCE citation precision/recall（NLI 判定）；CRAG 三态计分（correct +1 / missing 0 / incorrect −1，幻觉罚分）
- L2：Search Arena 方法论——匿名成对比较 + Bradley-Terry + 引用样式归一化 + 意图分层；注意其实证发现"用户分不清支持性引用和无关引用"（β_support=0.29 vs β_irrelevant=0.27），人类 win-rate 必须与 L0/L1 客观指标并列报告

**题库与成本速查**（详见笔记 §4/§6）：免费额度起步可行——Tavily 1k credits/月、Exa $10/月、千帆 1.5k 次/月、SerpApi 250 次/月；智谱 Search-Std ¥10/1k。英文题集用 SimpleQA + FRAMES 抽样，中文对照集自建 100 题（FreshQA 四分类 + 25 题 false-premise）。

## 附：相关文件索引

| 链路 | 关键代码 |
|---|---|
| Path A 工具壳 | `apps/gateway/src/modules/agent/web-search-tools.ts` |
| Path A 运行时注入 | `apps/gateway/src/modules/agent/runtime-factory.ts`（`enable_search` 两处） |
| Path A agent 定义 | `agents/web-search/agent.yaml` + `SYSTEM.md` |
| Path B 搜索包 | `apps/desktop/vendor/genoffice/packages/ai-search/src/index.ts` |
| Path B gsk 后端 | `apps/desktop/vendor/genoffice/packages/ai-search/src/gsk.ts` |
| Path A 配置 | `apps/gateway/src/config.ts`（`NXCORE_WEB_SEARCH_*`） |
| 驱动范式 | `scripts/agent-debug-smoke.mjs` |
| provenance 门 | `apps/desktop/vendor/genoffice/apps/slides/tests/data-source-gate.test.ts` |
| **调研笔记 A**（指标出处/搜索 API 对比/百炼边界） | [docs/notes/search-data-layer-benchmark-research.md](notes/search-data-layer-benchmark-research.md) |
| **调研笔记 B**（公开基准全景/评测框架/判分方法） | [docs/web-search-benchmark-options.zh-CN.md](web-search-benchmark-options.zh-CN.md) |
