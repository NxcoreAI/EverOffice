# 搜索数据层基准评测调研：如何量化评估搜索链路本身的数据能力

> 调研日期：2026-11-11。本报告只采信一手来源（arXiv 论文原文、官方文档/定价页、官方 GitHub/HF 仓库），每个 claim 标注来源；无法核实的明确写"未能确认"。
>
> 背景：产品是 macOS 办公助手（pnpm monorepo），搜索链路有两条：① 网关 web_search 工具 → 百炼（DashScope）兼容端点（qwen-plus 默认）实时检索；② vendored 应用内直调 Serper API。目标是量化"搜索数据能力"并与同类产品对比——**不是测基础模型推理**。因此评测设计核心是：把 LLM 从回路里拿掉（或固定住），直接对搜索 API/链路打分。

---

## 0. 结论速览

1. **"搜索数据能力"可以脱离 LLM 单独量化**：SimpleQA（公开 CSV 共 4,326 题、全部带 gold answer，Lead 于 2026-11-11 复核下载验证：4,326 行、零空答案；初版调研误记 1,199 题，已更正）和 FRAMES（824 题，每题带 gold answer + `wiki_links` 金标 URL 列表）两个公开数据集的标签结构天然支持"直接打搜索 API → 算 hit@k / gold-URL recall / snippet 答案包含率"，无需任何生成模型参与（数据格式核验见 §4）。
2. **三层评测设计（L0/L1/L2）各有成熟方法论可借**：L0 用 BEIR 的 IR 指标规范（nDCG/MRR/recall@k）+ FRAMES/SimpleQA 题库；L1 固定模型换搜索后端做成对对照（隔离搜索贡献，Tavily 官方 benchmark 即此做法）；L2 用 Search Arena（LMArena，arXiv 2506.05334）的人类成对比较 + Bradley-Terry 建模方法论。
3. **用户给的两个 arXiv 编号有误，已纠正**：FreshQA 正确编号是 **2310.03214**（2211.04207 是一篇数学论文）；CRAG 正确编号是 **2406.04744**（2401.17791 是图 Transformer 论文）；Search Arena 正确编号是 **2506.05334**（2505.23915 是天体物理学论文）。ALCE(2305.14627)、BEIR(2104.08663)、SimpleQA(2411.04368)、FRAMES(2409.12941) 编号无误。
4. **可直接 API 对 API 量化对比的后端**：Tavily、Exa、SerpApi、智谱 Web Search API、Kimi 联网搜索 API、百度千帆"百度搜索"、博查（参数已核实）共 7 家返回结构化结果的搜索 API；Serper 和 Brave 文档在本次网络环境下不可达（详见 §5 注）；Perplexity Sonar 是"搜索+生成"一体的答案 API，只能进 L1/L2 层对比，不能算 L0 纯搜索层。
5. **用户当前百炼链路的能力边界**：百炼联网搜索是**模型服务端工具**（`enable_search`/`search_options`），不是独立搜索 API——不开放独立检索端点、检索由模型多轮自主调用（agent 策略）、OpenAI 兼容协议下不返回搜索来源，只有 DashScope 原生协议 `enable_source` 可拿到 `search_info.search_results`。计费按搜索策略次数（agent 策略 $0.573411/千次，新加坡区 $10/千次）+ 模型 token 费。这意味着它天然只能进 L1 层评测；若要 L0，必须引入独立搜索 API。

---

## 1. 评测分层设计建议（L0 / L1 / L2）

### L0：纯搜索 API 层（无 LLM）

把搜索 API 当成一个"黑盒检索器"：输入 query，输出 top-k 结果（URL/标题/摘要/日期）。所有指标离线计算，完全不涉及生成模型。

- **题库**：
  - FRAMES 的 824 题（`Prompt` / `Answer` / `wiki_links` 列表），直接把 `Prompt` 作为 query 打给搜索 API，`wiki_links` 作为 gold URL 集，算 gold-URL recall@k 与答案包含率。FRAMES 是多跳题（平均每题需 2–15 篇 Wikipedia 文章，约 36% 需 2 篇、35% 需 3 篇）[来源](https://arxiv.org/html/2409.12941v2)。
  - SimpleQA 的 4,326 题测试集（`problem` / `answer` / `metadata.urls`），CSV 直接可下[来源](https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv)。注意 SimpleQA 题目为英文短事实题，对中文搜索后端（博查/千帆/智谱）需自建中文对照题集（可参考 FreshQA 的中文版或 CRAG 的 false-premise 题设计自建，见 §3.1）。
  - FreshQA 的四类划分（never-changing / slow-changing / fast-changing / false-premise）可直接搬来做**新鲜度子榜**的分层报告维度[来源](https://arxiv.org/html/2310.03214v2)。
- **评测方式**：固定 query 集合 → 并发打各 API（控制相同 count/max_results、相同时间过滤语义）→ 落盘原始响应 → 统一算指标。延迟 P50/P95、成本 per 1k 查询同时采集。
- **谁不能进 L0**：Perplexity Sonar（返回的是生成答案+引用，不是原始结果列表）、百炼联网搜索（模型服务端工具，见 §5.9）、Google Search Grounding（Gemini API 的工具，返回 grounding 支撑块而非可配置检索结果）。

### L1：固定模型、换搜索后端（隔离搜索贡献的成对对照）

固定同一个 LLM（如 qwen-plus 或任一固定模型）与同一条 prompt 模板，只切换搜索后端（百炼联网搜索 / Serper / Tavily / Exa / 智谱 / Kimi / 千帆）。这样模型推理能力被"冻结"，回答质量差异主要来自检索质量。

- **业界先例**：Tavily 官方 Company Search benchmark 的做法可以照抄——"Dataset: 同一题集；Model: 所有 provider 使用同一组模型；Retrieval: 每查询最多 10 篇文档；Scoring: 共享 AI judge 按 complete(1.0)/partial(0.85)/related(0.15)/irrelevant(0.0) 加权打分；Normalization: 每个 provider 的答案由共享模型基于该 provider 自己的搜索结果写成"[来源](https://www.tavily.com/#pricing)。这个设计的关键是把"模型"和"评分器"都固定，只让搜索来源变。
- **指标**：除了端到端答案正确率，更应报告**检索侧指标**（引用 URL 的 gold-URL recall、citation precision/recall，用 ALCE 的 NLI 判定法，见 §3.3），把"检索质量"从"生成质量"里剥离出来报告。
- **成对评审**：同一题两个后端的回答并排，用 LLM judge（或人工）选优，报告 win-rate；Search Arena 的 Bradley-Terry 系数拟合可用于把 win-rate 转成可比分数并检验显著性（论文用 bootstrap 置信区间）[来源](https://arxiv.org/html/2506.05334v2)。

### L2：产品级竞品对比（同题集 + 人类/LLM 成对评审）

对整个产品（自己的助手 vs Kimi vs 豆包 vs Perplexity 等）做黑盒对比。

- **方法论来源：Search Arena**（LMArena，ICLR 2026）：众包匿名成对比较 → 人类投票 → Bradley-Terry 建模排名。数据集含 24,069 组多轮对话、12,652 票、71 种语言（英语 56.4%、俄语 11.4%、中文约 7%）、9 类用户意图分类[来源](https://arxiv.org/html/2506.05334v2)。其数据与代码开源[来源](https://github.com/lmarena/search-arena)。
- **关键可复用设计**：
  1. **匿名 + 随机引用样式**：不同产品引用格式不同会泄露身份且影响偏好，Search Arena 对引用样式做了随机化归一，并验证"内联引用样式对偏好和排名无显著影响"[来源](https://arxiv.org/html/2506.05334v2)。
  2. **意图分层报告**：Factual Lookup 只占真实用户查询的 19.3%，其余是综合/推荐/分析等；评测集应按意图分层抽样，而不是全是事实题[来源](https://arxiv.org/html/2506.05334v2)。
  3. **警惕"引用数量偏置"**：用户显著偏好引用更多的回答（β=0.209），且**分不清支持性引用和无关引用**（supporting β=0.29 vs irrelevant β=0.27，均显著为正）——即人类评审会被引用堆砌"骗"，所以 L2 的人类偏好必须配合 L0/L1 的客观检索指标一起报告，不能只看 win-rate[来源](https://arxiv.org/html/2506.05334v2)。
  4. **题集来源**：可直接复用 Search Arena 公开数据集里的真实 query（含完整 system traces 与 retrieved URLs）做种子[来源](https://github.com/lmarena/search-arena)；加上 FreshQA fast-changing 子集测新鲜度。
- **落地建议**：小团队做 L2 不必搭众包平台，固定 2–3 名内部评审 + 每题双盲 + 位置随机化 + Kappa 一致性检查即可起步；Search Arena 的专家-用户一致率为 68%（排除 tie 后，随机=50%），说明小规模评审有效但有噪声，样本量要够[来源](https://arxiv.org/html/2506.05334v2)。

---

## 2. 指标定义表

| 指标 | 定义 | 计算方式 | 出处 |
|---|---|---|---|
| **hit@k** | 前 k 条搜索结果中至少一条包含正确答案的比例 | 对每题，检查 top-k 结果的 title/snippet（或正文）是否包含 gold answer（SimpleQA 用 exact match 于 answer 字符串）；命中记 1，取平均。SimpleQA 公开 CSV 共 4,326 题（`problem`/`answer`/`metadata.urls` 三列，Lead 已复核全量有效），每题答案为"单一无可争议"短答案，correct/incorrect/not-attempted 三态判分[来源](https://arxiv.org/abs/2411.04368)；FRAMES 用 LLM autorater 判答案匹配（与人一致性 0.96，Cohen's κ=0.889）[来源](https://arxiv.org/html/2409.12941v2) | SimpleQA[来源](https://arxiv.org/abs/2411.04368)；FRAMES autorater[来源](https://arxiv.org/html/2409.12941v2) |
| **MRR**（Mean Reciprocal Rank） | 首条包含答案结果的排名倒数的均值 | MRR = (1/&#124;Q&#124;)·Σ 1/rankᵢ，rankᵢ 为第一条命中结果的排名，未命中记 0 | BEIR 采用的 IR 标准指标之一，与 nDCG@10、Recall@k 并列[来源](https://arxiv.org/abs/2104.08663) |
| **recall@k / gold-URL recall** | gold 文档集合被 top-k 覆盖的比例 | 对每题：&#124;top-k URLs ∩ gold URLs&#124; / &#124;gold URLs&#124;，取均值。FRAMES 的 `wiki_links` 即 gold URL 集；BEIR 语境的 Recall@k 是标准秩评估指标 | BEIR[来源](https://arxiv.org/abs/2104.08663)；FRAMES 数据字段[来源](https://huggingface.co/datasets/google/frames-benchmark)（本次已下载 test.tsv 验证列名） |
| **nDCG@k** | 考虑排名位置折损的增益归一化指标 | DCG = Σ relᵢ/log₂(i+1)，除以理想 DCG；BEIR 默认报告 nDCG@10 | BEIR[来源](https://arxiv.org/abs/2104.08663) |
| **snippet 答案包含率** | 顶层返回的摘要文本（不抓正文）中直接包含 gold answer 的比例 | 对每题，string-match（大小写/别名归一后）gold answer 是否出现在任一 top-k 结果的 snippet/summary 字段；本质是 hit@k 的"仅摘要"严格版 | 实践约定；FreshQA 的 Relaxed 评测（只看主答案是否正确）是其评测学基础[来源](https://arxiv.org/html/2310.03214v2) |
| **freshness lag（新鲜度滞后）** | 搜索结果中目标事件的最新发布日期与事件实际发生日期的差 | 对 fast-changing 题集：lag = (检索时刻 − 结果中最新的 published_date) 或 (结果 published_date − 事件日期)，报告分布/P50；FreshQA 定义 fast-changing 为"答案在一年内变化"[来源](https://arxiv.org/html/2310.03214v2)；CRAG 的 dynamism 分级（real-time：秒级 / fast：年内 / slow：多年 / static）可作为题集分层标准[来源](https://arxiv.org/html/2406.04744v2)。计算前提是 API 返回日期字段（见 §5 各家"是否返回日期"列） | FreshQA[来源](https://arxiv.org/html/2310.03214v2)；CRAG dynamism 定义[来源](https://arxiv.org/html/2406.04744v2) |
| **来源域名覆盖/多样性** | top-k 结果覆盖的不同域名数量/多样性（如唯一域名数、Shannon 熵） | unique_domains / k；或 H = −Σ pᵢ·log pᵢ（pᵢ 为各域名结果占比）。Search Arena 证明来源类型显著影响用户偏好（社区/技术平台正偏，Wikipedia 负偏 β=−0.071），因此来源分布本身是可报告的产品指标[来源](https://arxiv.org/html/2506.05334v2) | Search Arena[来源](https://arxiv.org/html/2506.05334v2) |
| **citation precision** | 生成内容中引用的"不相关引用"检出率（越高越好=引用都支撑论断） | ALCE 定义：对每个引用 cᵢⱼ，其为"irrelevant"当且仅当 (a) NLI(cᵢⱼ, sᵢ)=0 且 (b) NLI(concat(Cᵢ∖{cᵢⱼ}), sᵢ)=1；cᵢⱼ 的 precision=1 当且仅当语句 sᵢ recall=1 且 cᵢⱼ 非 irrelevant；对所有引用取平均。NLI 模型用 TRUE（T5-11B） | ALCE（EMNLP 2023，Princeton）[来源](https://arxiv.org/html/2305.14627v2)，代码[来源](https://github.com/princeton-nlp/ALCE) |
| **citation recall** | 生成内容被引用文档完全支撑的比例 | ALCE 定义：语句 sᵢ 的 citation recall = 1 当且仅当 Cᵢ≠∅ 且 NLI(concat(Cᵢ), sᵢ)=1；对所有语句取平均。论文实验：ELI5 上最好模型也有约 50% 生成缺乏完整引用支撑[来源](https://arxiv.org/html/2305.14627v2) | ALCE[来源](https://arxiv.org/html/2305.14627v2) |
| **延迟 P50/P95** | 搜索 API 端到端响应时间的分位数 | 客户端计时（发请求到收完整响应），按题取分布；注意各家延迟语义不同（Serper 称 1–2 秒返回 Google SERP[来源](https://serper.dev/)；Tavily 自称 /search p50=180ms[来源](https://www.tavily.com/#pricing)；Exa 按类型 450ms–15s[来源](https://exa.ai/docs/search/quickstart.md)），必须同条件实测 | 各官方页 + 自测 |
| **成本 per 1k 查询** | 每千次查询的货币成本 | 用官方定价页单价 × 1000；注意计费单位差异（Tavily 按 credit、Exa 按请求+超额结果数、千帆按次且分版本、智谱按元/次、百炼按"搜索策略调用次数"且新加坡区贵 17 倍） | 见 §5 各家定价来源 |

**CRAG 的防污染/可靠性做法（适用于动态题集维护）**：CRAG 强调 benchmark 的 "Reliability / Longevity" 设计——ground truth 需人工核验、指标需统计显著（各分层切片样本量保证 <5% 误差@95% 置信）、数据需定期刷新；其自动评分对幻觉答案罚分（correct +1 / missing 0 / incorrect −1），比单纯准确率更能反映"搜索数据能力"[来源](https://arxiv.org/html/2406.04744v2)（评分实现见[来源](https://github.com/facebookresearch/CRAG)）。FRAMES 同样做了"三个月后复核答案仍成立"的时效清洗（剔除 5.5% 过期样本）并对时间敏感题加"As of 日期"限定词[来源](https://arxiv.org/html/2409.12941v2)。

---

## 3. 学术基准与方法论详情（借指标定义与题库，不借端到端跑法）

### 3.1 FreshQA（arXiv 2310.03214，Google）——新鲜度分类法

- **四分类法**：never-changing（答案几乎不变）/ slow-changing（数年尺度变化）/ fast-changing（一年内变化）/ false-premise（前提错误需驳斥）。600 题，test 500 题（每类 125）+ dev 100 题，另每类标注一跳/多跳难度[来源](https://arxiv.org/html/2310.03214v2)。
- **false-premise 设计**：题目前提事实错误（如"Elon Musk 与现任配偶结婚多久了"），正确行为是指出前提错误；所有模型在此类题上表现极差（多数 0–1.6%，最好的 GPT-4 Relaxed 66.9%）[来源](https://arxiv.org/html/2310.03214v2)。
- **两模式评测**：Relaxed（只看主答案对错）与 Strict（所有陈述都须无幻觉）；两者之差衡量幻觉量。FreshEval 自动评审与人工一致率 Relaxed 96.5% / Strict 96%[来源](https://arxiv.org/html/2310.03214v2)。
- **search-backed 设置**：FreshPrompt 用 Google SERP（经 SerpApi 抓取）的 organic results + related questions + crowdsourced QA + knowledge graph/answer box，把 (source, date, title, snippet, highlights) 五元组按日期升序排入 prompt[来源](https://arxiv.org/html/2310.03214v2)。
- **对本项目的可借之处**：① 新鲜度四分类作为题集分层维度与"freshness lag"指标的定义基础；② false-premise 题设计用来测"搜索链路能否召回驳斥性证据"；③ 数据集承诺定期更新，需在题库维护流程里复刻（CRAG/FRAMES 的做法见上）。
- **获取**：github.com/freshllms/freshqa（论文脚注给出仓库，本次网络环境下 GitHub raw 可达性有限，未能在线验证当前文件结构——**数据文件未能确认**，但论文明确"release FreshQA at github.com/freshllms/freshqa 并承诺定期更新"[来源](https://arxiv.org/html/2310.03214v2)）。

### 3.2 CRAG（arXiv 2406.04744，Meta，NeurIPS 2024 D&B / KDD Cup 2024）

- **数据**：4,409 对 QA，5 域（金融/体育/音乐/影视/开放域）× 8 题型（simple / simple+condition / set / comparison / aggregation / multi-hop / post-processing / false-premise）× 3 流行度（head/torso/tail）× 5 档动态性（real-time 437 题 / fast 564 / slow 1,007 / static 2,401）[来源](https://arxiv.org/html/2406.04744v2)。
- **web search track 的做法**：每题附带真实搜索引擎（Brave Search API）返回的最多 50 个完整 HTML 页面作为 mock API 检索语料（Task 3 给 50 页含噪候选，Task 1 给 5 页），从而**把"检索"固定成静态语料、把评测焦点放在合成与排序**——同时天然防污染（语料快照固定）[来源](https://arxiv.org/html/2406.04744v2)。论文明确指出："唯一未覆盖的组件是搜索检索本身；可扩展为用全部 22 万网页作为检索语料做完全端到端测试"[来源](https://arxiv.org/html/2406.04744v2)。
- **对本项目的可借之处**：① dynamism 五档分层报告；② correct/missing/incorrect 三态计分（幻觉罚分）；③ 22 万页快照语料可直接当 L0 的"固定语料检索"对照（BM25/自建索引 vs 各搜索 API）。
- **获取**：github.com/facebookresearch/CRAG（CC BY-NC 4.0，**注意非商业许可**；README 已核验[来源](https://raw.githubusercontent.com/facebookresearch/CRAG/main/README.md)）。

### 3.3 ALCE（arXiv 2305.14627，Princeton，EMNLP 2023）——引用忠实度的事实标准

- citation recall / citation precision 的定义与 NLI（TRUE 模型）计算方式见 §2 表；指标与人工判断强相关[来源](https://arxiv.org/html/2305.14627v2)。
- 三个子集：ASQA（歧义事实题，Wikipedia 21M 语料）、QAMPARI（列表题）、ELI5（why/how 题 Sphere 语料）[来源](https://arxiv.org/html/2305.14627v2)。
- **对本项目的可借之处**：L1 层把"搜索后端"换成自变量时，用 ALCE 指标直接量化"这个后端给到的证据能否支撑引用"，比端到端正确率更能归因到搜索层。代码库含完整评测实现[来源](https://github.com/princeton-nlp/ALCE)。

### 3.4 Search Arena（arXiv 2506.05334，LMArena/UC Berkeley，ICLR 2026）——竞品对比最直接的方法论

- 众包平台 + 匿名成对比较 + Bradley-Terry；24,069 组对话 / 12,652 票 / 11,650 用户 / 136 国 / 71 语言 / 22.4% 多轮[来源](https://arxiv.org/html/2506.05334v2)。
- **参赛系统全部通过公开 API 接入**（这对"竞品对比可复现"很关键）：Perplexity pplx-sonar / sonar-pro（含 search_context_size=high 变体）/ sonar-reasoning（含 pro-high）；Gemini 2.0-flash / 2.5-flash / 2.5-pro（均 With Google Search enabled，即 grounding）；OpenAI api-gpt-4o-mini-search-preview / gpt-4o-search-preview（含 high context 与 user_location 变体）。论文特别注明评估的是 OpenAI 的 **web search API**，"与 ChatGPT 产品内的搜索功能不同"[来源](https://arxiv.org/html/2506.05334v2)。
- 核心发现（对评测设计的警示）：引用数量偏置（§1 L2 第 3 点）；来源类型影响偏好（技术平台 β=0.073 / 社区 β=0.061 / 社媒 β=0.057 正向，Wikipedia β=−0.071 负向）；搜索上下文窗口大的 sonar-pro 显著更优（63.9% vs 57.6% 平均胜率，p<0.01）；非搜索模型在搜索场景显著更差（p=0.009）而搜索增强模型在普通聊天场景不吃亏[来源](https://arxiv.org/html/2506.05334v2)。
- **数据获取**：HF `lmarena-ai/search-arena-24k`（论文摘要附链接；本次网络环境 HF 直连失败，**未能在线验证文件**，但 GitHub 仓库 README 列明 `data/search_arena_24k.jsonl` 等文件[来源](https://raw.githubusercontent.com/lmarena/search-arena/main/README.md)）。

### 3.5 BEIR（arXiv 2104.08663，NeurIPS 2021 D&B）——IR 指标规范出处

- 18 个异构数据集、10 种检索架构的零样本评测基准；采用 nDCG@10（主指标）、MRR@10、Recall@k 等标准 IR 指标；结论之一是 BM25 是强基线[来源](https://arxiv.org/abs/2104.08663)。对本项目的作用：L0 指标的规范定义出处 + "任何搜索 API 打分前先跑一个 BM25 基线"的惯例。

### 3.6 SimpleQA（arXiv 2411.04368，OpenAI）与 FRAMES（arXiv 2409.12941，Google）能否直接当 L0 题库

**结论：都能，且 FRAMES 更适合做 gold-URL recall，SimpleQA 更适合做答案包含率。**

| | SimpleQA | FRAMES |
|---|---|---|
| 规模 | 公开 CSV **4,326 题全部有效**（Lead 于 2026-11-11 亲自下载复核：4,326 数据行、零空答案，与论文一致；初版调研的"1,199 题有效"为解析错误，已更正）[来源](https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv) | 824 题（下载核验 824 数据行）[来源](https://huggingface.co/datasets/google/frames-benchmark) |
| gold answer | ✅ `answer` 列，单一无可争议短答案[来源](https://arxiv.org/abs/2411.04368) | ✅ `Answer` 列（自由文本） |
| gold supporting docs | ✅ `metadata.urls`（每题 3–5 个佐证 URL，但**不是"回答所必需的全部文档"**，是出题佐证） | ✅ `wiki_links`（**出题所用的全部 Wikipedia 文章列表**，2–15 篇/题，是严格意义的 gold URL 集）[来源](https://arxiv.org/html/2409.12941v2) |
| 语言 | 仅英文 | 仅英文 |
| 获取方式 | 直接 CSV：`https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv`（simple-evals 官方仓库 simpleqa_eval.py 第 101–102 行给出）[来源](https://raw.githubusercontent.com/openai/simple-evals/main/simpleqa_eval.py)；MIT 许可[来源](https://github.com/openai/simple-evals) | HF `google/frames-benchmark` 的 `test.tsv`（本次经 hf-mirror 下载核验列结构）[来源](https://huggingface.co/datasets/google/frames-benchmark) |
| 用法建议 | query=`problem`，对 snippet 做 `answer` 的 exact/normalized match → hit@k、MRR、snippet 包含率 | query=`Prompt`，对结果 URL 与 `wiki_links` 求交集 → gold-URL recall@k；多跳题对"单次检索"偏难，可按 `reasoning_types` 分层或只用单跳近似题 |
| 注意 | SimpleQA 是对抗 GPT-4 收集的难题集，无检索设定下前沿模型也只 ~30–40% 正确；urls 字段语义是"佐证"而非"金标检索集"，算 recall 会低估 | 时效清洗做过（复核剔除 5.5%），题干带 "As of 日期"；wiki_links 限 Wikipedia——对非英文搜索引擎需自建中文等价题集 |

---

## 4. 各搜索 API 能力/定价对比表

> "API 对 API 可直接量化对比（L0）"标注：✅ = 返回结构化结果列表可直接打分；⚠️ = 返回生成答案/引用，只能进 L1/L2；❌ = 本次无法核实。
> 定价与参数以 2026-11-11 官方页面为准；本网络环境无法访问的站点明确标注。

| API | L0? | 时间/freshness 过滤 | 域名过滤 | 中文支持 | 定价（per 1k queries 换算） | 是否返回日期 | 官方文档 |
|---|---|---|---|---|---|---|---|
| **Tavily** | ✅ | `time_range`（day/week/month/year）、`start_date`/`end_date`（YYYY-MM-DD）、`filter_by_published_date`（严格剔除无日期结果）、`max_age_hours`（缓存新鲜度，1–720h）、`topic=news` 自动开日期 | `include_domains`（≤300）/`exclude_domains`（≤150），`include_domains_mode: restrict/prefer` | `country` 参数可 boost 指定国家结果；未见中文专述 | Researcher 免费 1,000 credits/月；PAYG **$8/1k credits**；Project $30/月含 4k credits；官方自称 /search **p50=180ms** | ✅ `include_published_date: true` 返回 `published_date`（beta，无日期返回 null） | [docs](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[pricing](https://www.tavily.com/pricing)、[首页（p50 数据）](https://www.tavily.com/#pricing) |
| **Serper** | ✅（SERP 型） | Google SERP 原生参数（News/时间过滤），具体参数文档本次不可达 | Google SERP 域名语法 | 支持 Google 各区域接口 | **官方定价数字未能确认**（官网仅"Get 2,500 free queries / No credit card"，定价页在登录后 dashboard；serper.dev/pricing 404） | ✅ SERP 结果含 date 字段（其 playground 演示 JSON 含 date） | [首页](https://serper.dev/)（定价未能确认） |
| **SerpApi** | ✅（SERP 型） | Google 原生 `tbs`/date 参数族（文档目录含 Google Search API 全家桶） | Google 原生 `site:` 等语法 | 支持多引擎多区域 | Free 250 次/月；Starter $25/月=1k 次（**$25/1k**）；Developer $75/月=5k（$15/1k）；Production $150/月=15k（**$10/1k**）；Big Data $275/月=30k（~$9.2/1k）；含 U.S. Legal Shield | ✅ organic results 含 date | [pricing](https://serpapi.com/pricing)、[search-api](https://serpapi.com/search-api) |
| **Brave Search API** | ❌ | （已知支持 freshness/局部参数，官方口径）未能在线核实 | 未能在线核实 | 未能在线核实 | 未能在线核实 | 未能在线核实 | brave.com 与 api-dashboard.search.brave.com 在本网络环境均不可达（DNS 污染 + 连接超时），**官方页未能确认** |
| **Exa** | ✅ | `startPublishedDate` / `endPublishedDate`（ISO 时间戳）；`contents.maxAgeHours` 控制缓存新鲜度 | `includeDomains` / `excludeDomains`（支持路径前缀与 `*.subdomain` 通配） | 未见中文专述（英文为主的索引） | `/search` lite **$4/1k**（10 条内）、auto/fast **$7/1k**；>10 条结果每条 $1/1k；Contents $1/1k 页；deep 模式 $12–15/1k；免费 $10 额度/月 | ✅ 每结果含 `publishedDate` | [pricing](https://exa.ai/pricing)、[详细定价](https://exa.ai/docs/admin/pricing.md)、[参数](https://exa.ai/docs/search/quickstart.md) |
| **Perplexity Sonar API** | ⚠️ | `search_context_size`（low/medium/high）控制检索深度；时间过滤参数未能在线核实（docs.perplexity.ai 不可达） | 未能在线核实 | 多语言生成 | 官方定价页未能在线核实；旁证（OpenRouter 转售，非官方）：sonar $1/M input tokens、sonar-pro $3/M + 描述称"价格已含 Perplexity 搜索费" | 生成答案带 citations（URL 列表） | [docs 未能确认]；旁证 [OpenRouter](https://openrouter.ai/api/v1/models)；Search Arena 论文实测过 pplx-sonar 系列[来源](https://arxiv.org/html/2506.05334v2) |
| **Jina Reader/Search** | ❌ | 未能在线核实（jina.ai 域名在本网络不可达） | 未能在线核实 | 未能在线核实 | 未能在线核实 | 未能在线核实 | jina.ai / s.jina.ai 连接失败，**官方页未能确认** |
| **博查 Bocha** | ✅ | `freshness`: `noLimit`/`oneDay`/`oneWeek`/`oneMonth`/`oneYear`/`YYYY-MM-DD`/`YYYY-MM-DD..YYYY-MM-DD` | `include_domains` / `exclude_domains`（多域名 `\|` 分隔） | ✅ 中文原生（近千亿网页+生态内容源） | **官方定价数字未能确认**（定价在飞书 wiki，需登录；open.bochaai.com 无价格） | ✅ 响应含发布时间字段（官网演示响应含 summary/date 类字段） | [开放平台](https://open.bochaai.com/)；参数经第三方 MCP 实现核验[来源](https://raw.githubusercontent.com/aweffr/bocha-mcp/main/README.md)（非官方， freshness 取值需以官方 wiki 为准） |
| **百炼 DashScope 联网搜索**（用户当前后端①） | ⚠️（无独立检索端点） | 无用户级时间过滤参数（检索策略由服务端 agent 决定；文档未提供 freshness 类参数） | 无域名过滤参数 | ✅ 中文 | **两部分计费**：模型 token 费（检索内容注入 prompt 增加输入 token，按模型标准价）+ 搜索策略费：agent 策略 **$0.573411/千次**（北京/弗吉尼亚/香港/东京/法兰克福区），**新加坡区 $10/千次**；agent_max 限时同价含 web extractor；账单以实际成功检索次数为准（API 的 count 字段不作为计费依据） | DashScope 原生协议 `enable_source` 返回 `search_info.search_results`（含 URL/标题）；**OpenAI 兼容协议不返回搜索来源** | [Web search（国际站英文版，本次实际核验）](https://www.alibabacloud.com/help/en/model-studio/web-search)；中文站对应路径在本网络 404 |
| **智谱 Web Search API** | ✅ | `search_recency_filter`（如 `noLimit`；文档示例值） | `search_domain_filter`（如 `www.sohu.com`） | ✅ 中文 | **Search-Std ¥10/1k 次**；**Search-Pro ¥30/1k 次**；**Search-Pro-Sogou ¥50/1k 次**；**Search-Pro-Quark ¥50/1k 次**（自研引擎 + 搜狗/夸克第三方） | ✅ 响应含 `publish_date` | [联网搜索指南](https://docs.bigmodel.cn/cn/guide/tools/web-search.md)、[API](https://docs.bigmodel.cn/cn/api-reference/工具-api/网络搜索.md)、[定价](https://docs.bigmodel.cn/cn/guide/start/pricing.md) |
| **百度千帆"百度搜索"组件** | ✅ | "内容发布时间筛选"（能力说明列出；具体参数名未能在线核实，API 参考正文为 JS 壳） | "指定站点搜索" | ✅ 中文 | 国内内容：**标准版 ¥36/1k 次**、增强版 ¥40/1k、旗舰版 ¥72/1k；国外内容增强版 ¥72/1k；预付量包 10k 次 ¥352 起；默认 3 QPS，每月免费 1,500 次（按天发放） | ✅ 返回"发布时间"（能力说明：URL、标题、摘要、发布时间及多模态信息） | [百度AI搜索计费](https://cloud.baidu.com/doc/qianfan/s/1mh4sv6c4)、[平台简介（百度AI搜索组件描述）](https://cloud.baidu.com/doc/qianfan/s/rmh8khvwu) |
| **Kimi 联网搜索 API（Moonshot）** | ✅ | 联网搜索 Pro `time_window`（`start`/`end`，支持 YYYY / YYYY-MM / YYYY-MM-DD） | 联网搜索 Pro `sites`（最多 5 个站点，OR 语义） | ✅ 中文 | **官方单价数字未能确认**（定价页表格为 JS 组件未渲染；计费规则已核验：按次计费，仅 HTTP 200 且有结果时计费，空结果不计费）；Basic `/v1/tools/search`、Pro `/v1/tools/search_pro` | ✅ 每结果含 `date`、`site_name`、`chunks`（相关性分片）；Pro 额外返回 `authority`（来源权威性等级） | [联网搜索最佳实践](https://platform.moonshot.cn/docs/guide/best-practices-for-web-search)、[联网搜索定价](https://platform.moonshot.cn/docs/pricing/websearch) |
| **Google Search Grounding（Gemini API）** | ⚠️ | 由 Gemini 工具执行，返回 grounding 支撑块（非可配置检索结果列表） | 动态检索，无用户域名过滤 | 多语言 | ai.google.dev 在本网络不可达，**官方定价未能确认**（已知计入 Gemini API 请求计费并按 grounding 元数据额外计费的官方口径存在，具体单价未能核实） | 返回 grounded chunks + queries | [官方文档未能在线核实]；Search Arena 以 "gemini-2.0/2.5-flash/pro-grounding (With Google Search enabled)" 名义实测过[来源](https://arxiv.org/html/2506.05334v2) |

**关于两个"不可达"的重要说明**：本调研所处网络对 brave.com、jina.ai、docs.perplexity.ai、ai.google.dev 存在 DNS 污染/连接阻断，上述四家 + Serper 定价数字 + Bocha 定价数字**均未能一手确认**，报告中已逐项标注。若需补齐，可在可访问这些域名的网络环境复跑，官方入口分别是：brave.com/search/api、jina.ai、docs.perplexity.ai（guides/pricing）、serper.dev（登录后 plans 页）、open.bochaai.com（飞书 wiki 定价页）。

### 百炼联网搜索能力边界（用户当前后端①，重点）

已核验的官方文档要点（英文国际站，2026-11-11 更新版）：

1. **四种接入方式**：Responses API（`tools=[{"type":"web_search"}]`）/ OpenAI 兼容 Chat Completions（`extra_body={"enable_search": true}`）/ DashScope 原生（`enable_search=True` + `search_options`）/ Anthropic 兼容（`tools` 里 `web_search_20250305`，需带 `x-anthropic-billing-header: cc_entrypoint=cli;`）[来源](https://www.alibabacloud.com/help/en/model-studio/web-search)。
2. **search_options 只有三个已知键**：`search_strategy`（目前**仅支持 `agent`**：模型可多轮调用搜索工具并整合内容）、`enable_source`（是否返回搜索来源，仅 DashScope 协议）、多模态 API 语境下另有 turbo/max/agent 策略差异。**没有 freshness、域名过滤、结果数控制等搜索 API 级参数**[来源](https://www.alibabacloud.com/help/en/model-studio/web-search)。
3. **来源可见性**：DashScope 协议 `enable_source` 可拿 `search_info.search_results`（index/title/url）；Responses API 通过 `web_search_call` 的 `action.sources` 拿 URL；**OpenAI 兼容协议明确"不支持返回搜索来源"**——这直接限制 L0/L1 评测里"引用忠实度"类指标的可计算性[来源](https://www.alibabacloud.com/help/en/model-studio/web-search)。
4. **计费双轨**（见上表）；另注意官方 FAQ：账单按"实际完成检索并成功返回"计，API 返回的 `usage.plugins.search.count` 只表示意图判定要搜，**不作为计费与对账依据**[来源](https://www.alibabacloud.com/help/en/model-studio/web-search)。
5. **含义**：百炼联网搜索是"模型服务端 grounding 工具"，无法作为独立检索器进 L0。建议用户的 L0 用一家独立搜索 API（如智谱/博查/Exa/SerpApi）搭好基线，L1 再把"qwen-plus + 百炼联网"作为一个被测系统整体对比。

---

## 5. 同类产品的搜索能力公开信息（仅收录可验证来源）

| 产品 | 公开可验证信息 | 来源 |
|---|---|---|
| **Kimi（Moonshot）** | 开放平台提供独立联网搜索 REST API：Basic（`/v1/tools/search`，标题/链接/摘要，`include_content=true` 附正文）、Pro（`/v1/tools/search_pro`，正文相关片段 chunks + `authority` 来源权威性字段 + `sites`/`time_window` 过滤）、网页抓取（`/v1/tools/fetch`）；Chat 侧 Responses API 的 `web_search` 工具为服务端判断是否触发搜索 | [联网搜索最佳实践](https://platform.moonshot.cn/docs/guide/best-practices-for-web-search)、[官方工具列表](https://platform.moonshot.cn/docs/guide/use-official-tools.md)。Kimi 消费级产品自建搜索的具体引擎构成未见官方披露——**未能确认** |
| **Perplexity** | Sonar API 系列是"搜索增强生成"商用 API；Search Arena 论文实测了 pplx-sonar、sonar-pro（含 search_context_size high 变体，高上下文版本胜率显著更高 63.9% vs 57.6%）、sonar-reasoning（含 pro-high），全部经公开 API 默认配置接入 | [Search Arena 论文](https://arxiv.org/html/2506.05334v2)。其搜索索引是否自建：官方博客/文档在本网络不可达——**未能确认** |
| **Gemini（Google Search Grounding）** | Search Arena 实测 gemini-2.0-flash-grounding / gemini-2.5-flash-grounding / gemini-2.5-pro-grounding（"With Google Search enabled"），是 grounding 型而非独立搜索 API | [Search Arena 论文](https://arxiv.org/html/2506.05334v2) |
| **OpenAI 搜索 API** | Search Arena 实测 api-gpt-4o-mini-search-preview / api-gpt-4o-search-preview（含 high context、user_location 变体）；论文注明这是 web search API，与 ChatGPT 产品内搜索不同 | [Search Arena 论文](https://arxiv.org/html/2506.05334v2) |
| **豆包（字节）** | 公开搜索后端信息——**未能确认**（www.doubao.com 可达但其技术口径未在本轮核验范围） | 未能确认 |
| **WPS AI** | 公开搜索后端信息——**未能确认** | 未能确认 |
| **Notion AI** | 公开搜索后端信息——**未能确认** | 未能确认 |
| **Genspark** | 官网 genspark.ai 可达（HTTP 403 于部分路径）；搜索后端构成公开信息——**未能确认** | 未能确认 |
| **Manus** | 官网 manus.im 可达；其 agent 搜索链路的后端选型公开信息——**未能确认** | 未能确认 |

---

## 6. 竞品产品对比的可行做法（落地清单）

1. **先立 L0（1–2 周）**：下载 SimpleQA CSV（已验证 URL）+ FRAMES test.tsv（HF google/frames-benchmark）→ 写一个打分 harness：并发调 Tavily/Exa/智谱/博查/SerpApi/千帆（各注册免费档：Tavily 1k credits/月、Exa $10/月、千帆 1.5k 次/月、SerpApi 250 次/月）→ 输出 hit@5、MRR@10、gold-URL recall@10、snippet 包含率、P50/P95、$/1k。英文题集 + 自建 100 题中文对照集（借 FreshQA 四分类法设计，false-premise 25 题）。
2. **再立 L1（1 周）**：固定 qwen-plus（或任一模型）+ 固定 prompt 模板，把"搜索后端"做成可切换注入（检索结果拼进 context），对比 百炼联网搜索 vs Serper vs L0 最优 API。评分用 ALCE citation precision/recall + CRAG 三态计分（幻觉罚分）+ LLM judge 成对 win-rate。
3. **L2 抽样（持续）**：从 Search Arena 公开数据集抽 200 条真实 query（按 9 类意图分层，保留其 7% 中文份额的配额）+ FreshQA fast-changing 子集，双盲评审自己的产品 vs Kimi/Perplexity，引用样式归一化（Search Arena 已验证样式不影响排名），每题两两对比 + 位置随机；同时记录每答案的引用数与引用域名分布，报告时**必须与 L0/L1 客观指标并列**，防止"引用堆砌偏置"污染结论。
4. **新鲜度专项**：自建"事件探针"集（每日新增 10 题实事，标注事件时间戳），对各 API 计算 freshness lag 分布（结果 published_date − 事件日期），这是办公助手场景（新闻/股价/日程类 query）最贴近产品价值的指标，且 FreshQA/CRAG 均证明这是现有系统最弱的维度。
5. **维护**：题集每季度复核（FRAMES 式"答案仍成立"清洗 + 时效题加 As-of 限定词）；每次评测落盘全部原始响应与版本号（API 行为会漂移，FreshQA 论文专门同日评测以保可比）。

---

## 附：来源清单（全部一手）

- FreshQA/FreshLLMs: <https://arxiv.org/abs/2310.03214>（正文 <https://arxiv.org/html/2310.03214v2>）
- CRAG: <https://arxiv.org/abs/2406.04744>（正文 v2；仓库 README 经 raw.githubusercontent 核验）
- ALCE: <https://arxiv.org/abs/2305.14627>（正文 v2）
- Search Arena: <https://arxiv.org/abs/2506.05334>（正文 v2；GitHub lmarena/search-arena）
- BEIR: <https://arxiv.org/abs/2104.08663>
- SimpleQA: <https://arxiv.org/abs/2411.04368>；数据 <https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv>（URL 出处：simple-evals 仓库 simpleqa_eval.py）
- FRAMES: <https://arxiv.org/abs/2409.12941>；数据 <https://huggingface.co/datasets/google/frames-benchmark>（test.tsv 经 hf-mirror 下载核验）
- Tavily: <https://docs.tavily.com/documentation/api-reference/endpoint/search> / <https://www.tavily.com/pricing> / <https://www.tavily.com/#pricing>
- Serper: <https://serper.dev/>（定价未能确认）
- SerpApi: <https://serpapi.com/pricing> / <https://serpapi.com/search-api>
- Exa: <https://exa.ai/pricing> / <https://exa.ai/docs/admin/pricing.md> / <https://exa.ai/docs/search/quickstart.md>
- 百炼联网搜索: <https://www.alibabacloud.com/help/en/model-studio/web-search>（2026-11-11 版）
- 智谱: <https://docs.bigmodel.cn/cn/guide/tools/web-search.md> / <https://docs.bigmodel.cn/cn/guide/start/pricing.md> / <https://docs.bigmodel.cn/cn/api-reference/工具-api/网络搜索.md>
- 百度千帆: <https://cloud.baidu.com/doc/qianfan/s/1mh4sv6c4>（百度AI搜索计费）/ <https://cloud.baidu.com/doc/qianfan/s/rmh8khvwu>（平台简介）
- Kimi/Moonshot: <https://platform.moonshot.cn/docs/guide/best-practices-for-web-search> / <https://platform.moonshot.cn/docs/pricing/websearch> / <https://platform.moonshot.cn/docs/guide/use-official-tools.md>
- 博查: <https://open.bochaai.com/>；参数旁证 <https://github.com/aweffr/bocha-mcp>（第三方）
- OpenRouter（Perplexity 定价旁证，非官方一手）: <https://openrouter.ai/api/v1/models>
