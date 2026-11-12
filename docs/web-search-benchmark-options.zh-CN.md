# LLM / AI Agent 联网搜索能力基准测试调研报告

> 调研日期：2026-11-11。所有关键信息均对照一手来源（arXiv 论文原文、GitHub 官方仓库 README、HuggingFace dataset 页面/API、官方网站）核实；无法确认的信息明确标注"未能确认"。
>
> **放置说明**：本仓库 docs/ 目录的命名约定为 `kebab-case（短横线小写）+ .zh-CN.md` 后缀、直接放在 docs/ 根目录（如 `tool-call-limit-industry-survey.zh-CN.md`、`slides-semantic-evaluation.zh-CN.md`），故本报告命名为 `web-search-benchmark-options.zh-CN.md` 存于 docs/ 根目录，未使用任务建议的 `docs/research/` 路径（仓库不存在 research/ 子目录，遵循仓库既有约定优先）。

## 0. TL;DR

| 需求 | 推荐方案 |
|---|---|
| 直接跑、可复现、有官方评分器 | SimpleQA（轻量事实）+ FRAMES（检索+推理）+ BrowseComp-ZH（中文深度搜索） |
| 抽题自建 mini set | GAIA validation（300 题）、xbench-DeepSearch（100 题）、Mind2Web 2 dev（30 题） |
| 只借鉴指标设计 | Mind2Web 2 的 Agent-as-a-Judge、DeepResearch Bench 的 RACE/FACT 引用指标、xbench 的加密防污染机制 |
| 端到端评测框架 | promptfoo（Agent 轨迹断言）或 DeepEval（ToolCorrectness/TaskCompletion 指标） |

**重要更正**：任务描述中 "Deep Research Bench (KOREA 软件振兴院, arXiv 2506.16263)" 的编号有误——arXiv 2506.16263 实际是一篇胶囊机器人论文（CapsDT）[来源](https://arxiv.org/abs/2506.16263)。真正的 "Deep Research Bench" 是 FutureSearch 公司的 arXiv 2506.06287；KOREA 软件振兴院（NIPA）相关的说法**未能在一手来源中确认**。

---

## 1. 基准总览对照表

| 基准 | 机构 | 规模 | 任务形态 | 评分方式 | 需要真实浏览 | 中文 | 办公助手适用度 |
|---|---|---|---|---|---|---|---|
| BrowseComp | OpenAI | 1,266 题 | 短答案硬检索问题 | LLM judge（HLE 同款 prompt） | 是 | 否 | 低 |
| BrowseComp-ZH | 字节/HKU 等 | 289 题 | 中文多跳检索 | LLM judge | 是 | **是** | **高** |
| GAIA | Meta/HF | 466 题（300 有答案） | 通用助手问答（含文件/多模态） | 精确匹配为主 | 部分 | 否 | **高** |
| WebArena | CMU/MIT 等 | 812 任务 | 网站操作（点击/输入） | 环境状态校验 | 自托管环境 | 否 | 低 |
| VisualWebArena | 同上 | 910 任务 | 视觉网页任务 | 环境状态校验 | 自托管环境 | 否 | 低 |
| Mind2Web | OSU | 2,350 任务（HF 1,009） | 真实网站操作步骤预测 | 步骤级 EM | 否（离线快照） | 否 | 低 |
| Mind2Web 2 | OSU | 130 任务 | 长程 agentic search + 报告 | **Agent-as-a-Judge** | 是 | 部分 | **高**（借鉴） |
| xbench-DeepSearch | 红杉中国 | 100 题×2 版本 | 深度搜索（多跳+时效） | LLM judge（HLE prompt） | 是 | **是** | **高** |
| SimpleQA | OpenAI | 4,326 题 | 短事实问答 | LLM 自动判分（三分类） | 否 | 否 | 中（作为对照组） |
| FRAMES | Google | 824 题 | 多跳 RAG 问答 | 答案匹配 | 否（可选联网） | 否 | **高** |
| HotpotQA | GWU/CMU | 113k QA（distractor 97,852 + fullwiki 105,257） | 多跳问答 | EM/F1 | 否 | 否 | 中 |
| tau-bench / tau2-bench | Sierra | retail/airline/telecom | 工具+用户模拟对话 | 数据库状态比对 + pass^k | 否 | 部分 | 低（与联网搜索无直接关系） |
| DeepResearch Bench | 人大等（muset） | 100 PhD 级任务（50 中 + 50 英） | 深度研究报告 | RACE + FACT | 是 | **是** | **高**（借鉴指标） |
| Deep Research Bench | FutureSearch | 89 任务 | 多步 web research | 冻结网页快照 + 自动评估 | RetroSearch 冻结集 | 否 | 中 |
| ReportBench | 字节 | arXiv 综述任务 | 报告引用质量 | 引用核查 agent | 是 | 否 | 中 |
| ToolBench | OpenBMB | 16,464 REST API | 工具调用 | pass@1 / win rate | 否 | 否 | 低 |
| BFCL | Berkeley | 多类别 | 函数调用 | AST/执行匹配 | 否 | 否 | 低 |

---

## 2. 各基准详情

### 2.1 BrowseComp（OpenAI）

- **arXiv**: [2504.12516](https://arxiv.org/abs/2504.12516)
- **设计目标**：测量 agent "坚持且有创造力地"在网上寻找难以找到的纠缠信息的能力，类比编程比赛之于编码 agent [来源](https://arxiv.org/abs/2504.12516)。
- **任务形态**：1,266 道需要持续浏览互联网的问题；预测答案短小、易于对照参考答案验证 [来源](https://arxiv.org/abs/2504.12516)。题目标签后由 ChatGPT 分类，前几大主题：TV shows & movies (n=205)、Other (n=197)、Science & technology (n=173)、Art (n=127)、History (n=125) 等 [来源](https://arxiv.org/html/2504.12516v1)。
- **评分方式**：使用与 Humanity's Last Exam 相同的 LLM grader prompt，由判分模型判断回答是否等价于参考答案 [来源](https://arxiv.org/html/2504.12516v1)。
- **数据获取**：官方实现随 [openai/simple-evals](https://github.com/openai/simple-evals) 发布，数据从 `https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv` 直接读取 [来源](https://raw.githubusercontent.com/openai/simple-evals/main/browsecomp_eval.py)。注意该仓库 2025 年 7 月起停止为新模型更新，仅保留 HealthBench/BrowseComp/SimpleQA 参考实现 [来源](https://raw.githubusercontent.com/openai/simple-evals/main/README.md)。
- **防污染**：论文明确"sidesteps 真·用户查询分布"，答案短且唯一；仓库未声明动态更新机制（未见官方轮换计划，未能确认）。
- **办公助手适用度**：**低** —— 题目刻意"难以找到"，分布偏娱乐/冷知识，与办公场景（查资料、找数据、核对事实）的用户查询分布差异大；但作为 agent 检索能力上限的压力测试有价值。

### 2.2 BrowseComp-ZH（字节跳动等，中文版）

- **arXiv**: [2504.19314](https://arxiv.org/abs/2504.19314)；GitHub: [PALIN2018/BrowseComp-ZH](https://github.com/PALIN2018/BrowseComp-ZH)；HF: [PALIN2018/BrowseComp-ZH](https://huggingface.co/datasets/PALIN2018/BrowseComp-ZH)（289 行，apache-2.0）
- **设计目标**：针对中文信息生态（碎片化平台、隐式语言模式、内容审查）的高难度浏览基准 [来源](https://arxiv.org/abs/2504.19314)。
- **任务形态**：289 道多跳问题，覆盖 11 个领域（Film & TV 15.6%、Art 13.8%、Geography 12.8% 为前三大）[来源](https://arxiv.org/html/2504.19314v2)。每题从短小客观答案（日期/数字/专名）反向设计，经 Baidu/Bing(中国)/Google 三引擎验证 + 两阶段人工质检（难度验证 + 答案唯一性验证）[来源](https://huggingface.co/datasets/PALIN2018/BrowseComp-ZH)。
- **评分方式**：论文附录 A.2 给出 grading instruction（LLM judge）；最强系统 OpenAI DeepResearch 也仅 42.9%，多数模型 <10% [来源](https://arxiv.org/html/2504.19314v2)。
- **数据获取**：HF 数据集（gated 为否，可直接下载）+ GitHub 仓库含构建指南与基准结果 [来源](https://arxiv.org/abs/2504.19314)。
- **防污染**：反向出题 + 三引擎验证筛除易检索样本（静态数据集，无动态更新机制）。
- **办公助手适用度**：**高** —— 唯一针对中文网络生态的主流浏览基准，直接贴合中文办公用户的搜索环境。

### 2.3 GAIA（Meta / HuggingFace）

- **arXiv**: [2311.12983](https://arxiv.org/abs/2311.12983)；HF: [gaia-benchmark/GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA)（gated，需申请）；排行榜: [gaia-benchmark/leaderboard](https://huggingface.co/spaces/gaia-benchmark/leaderboard)（gradio Space，README 确认 title 为 "GAIA Leaderboard" [来源](https://hf-mirror.com/spaces/gaia-benchmark/leaderboard/raw/main/README.md)）
- **设计目标**：通用 AI 助手基准——人类 92% vs GPT-4+plugins 15%，题目"对人简单对 AI 难"，反潮流地不追求对人类也难的任务 [来源](https://arxiv.org/abs/2311.12983)。
- **任务形态**：466 道真实世界问题，需要推理、多模态（含附件文件）、网页浏览、工具使用；300 题保留答案用于排行榜 [来源](https://arxiv.org/abs/2311.12983)。三级难度：Level 1 ≤5 步/最多 1 工具；Level 2 约 5-10 步需组合工具；Level 3 需任意长动作序列 [来源](https://arxiv.org/html/2311.12983v1)。
- **评分方式**：答案为短字符串，官方评估器做精确匹配（含小变化容忍）；这是各 leaderboard 的通行做法（论文第 3 节）。
- **数据获取**：HF 数据集 gated（申请通过后可见 2023/validation 与 test split）；直接访问 metadata.jsonl 返回 403 [来源](https://hf-mirror.com/datasets/gaia-benchmark/GAIA/resolve/main/2023/validation/metadata.jsonl)。
- **防污染**：官方排行榜以 test set（答案私有）为主，validation 公开答案；未见定期换题机制（未能确认）。
- **办公助手适用度**：**高** —— "概念上简单、需要浏览+工具"的分布与办公助手日常查询高度吻合；建议抽 validation 子集自建。

### 2.4 WebArena / VisualWebArena

- **arXiv**: [2307.13854](https://arxiv.org/abs/2307.13854) / [2401.13649](https://arxiv.org/abs/2401.13649)；官网: [webarena.dev](https://webarena.dev)（WebArena-x 项目族门户）[来源](https://webarena.dev/)；GitHub: [web-arena-x/webarena](https://github.com/web-arena-x/webarena)、[web-arena-x/visualwebarena](https://github.com/web-arena-x/visualwebarena)
- **设计目标**：高度真实、可复现的网页环境（电商、论坛、GitLab、CMS 四类自营网站），评测功能正确性；GPT-4 agent 仅 14.41% vs 人类 78.24% [来源](https://arxiv.org/abs/2307.13854)。
- **任务形态**：812 个任务（README："After evaluating the 812 examples, reset the environment"）[来源](https://raw.githubusercontent.com/web-arena-x/webarena/main/README.md)；VWA 为 910 个视觉任务（GPT-4V+SoM 轨迹覆盖全部 910 任务）[来源](https://raw.githubusercontent.com/web-arena-x/visualwebarena/main/README.md)。需要真实点击/输入。
- **评分方式**：执行式——比对环境最终状态/数据库内容。
- **数据获取**：**需自托管**——官方提供 docker 环境与 AWS AMI 预装镜像；官方推荐经 BrowserGym/AgentLab 框架运行 [来源](https://raw.githubusercontent.com/web-arena-x/webarena/main/README.md)。
- **防污染**：环境自托管 + 状态可复位，天然可复现；无换题机制。
- **办公助手适用度**：**低** —— 评测的是"操作网站"（UI agent）而非"搜索信息"；搭环境成本高，与办公助手的联网查资料场景错位。

### 2.5 Mind2Web / Mind2Web 2

**Mind2Web**
- **arXiv**: [2306.06070](https://arxiv.org/abs/2306.06070)；官网: [osu-nlp-group.github.io/Mind2Web](https://osu-nlp-group.github.io/Mind2Web)；HF: [osunlp/Mind2Web](https://huggingface.co/datasets/osunlp/Mind2Web)（cc-by-4.0）
- 2,000+ 开放任务、137 网站、31 领域，众包动作序列；测试集分 Cross Task(252)/Cross Website(177)/Cross Domain(912) [来源](https://raw.githubusercontent.com/OSU-NLP-Group/Mind2Web/master/README.md)。HF 版当前 train split 为 1,009 行 [来源](https://datasets-server.huggingface.co/size?dataset=osunlp/Mind2Web)。
- 评分：步骤级动作匹配（element EM / 宏平均准确率）；离线快照推理，不需真实联网。
- **适用度：低** —— 评测"给定页面预测下一步操作"的离线步骤预测，不是端到端搜索。

**Mind2Web 2（重点借鉴）**
- **arXiv**: [2506.21506](https://arxiv.org/abs/2506.21506)；官网: [osu-nlp-group.github.io/Mind2Web-2](https://osu-nlp-group.github.io/Mind2Web-2/)；HF: [osunlp/Mind2Web-2](https://huggingface.co/datasets/osunlp/Mind2Web-2)（gated:auto，dev/test split）
- 130 个长程、需实时浏览与大规模信息综合的任务，构建耗人时 1000+；提出 **Agent-as-a-Judge**：基于树状 rubric 构建任务专属 judge agent，同时评答案正确性与来源归因（source attribution）[来源](https://arxiv.org/abs/2506.21506)。
- 数据获取：HF gated（自动批准），README 提供本地评测脚本（dev 与 test 均可本地跑）+ 网页预缓存脚本 [来源](https://raw.githubusercontent.com/OSU-NLP-Group/Mind2Web-2/main/README.md)。
- 防污染：答案随时间变化的设计本身抗记忆；test set 私有答案 + 排行榜提交制。
- **适用度：高（指标借鉴 + dev set 抽题）** —— 其"树状 rubric + 判分 agent"是评"搜索质量"而非"命中唯一短答案"的最佳范式，直接适用于办公助手的开放式检索问答评测。

### 2.6 xbench / xbench-DeepSearch（红杉中国）

- **arXiv**: [2506.13651](https://arxiv.org/abs/2506.13651)（论文主体是 Recruitment 50 任务 + Marketing 50 需求的 Profession-Aligned 评测）；官网: [xbench.org](https://xbench.org)；GitHub: [xbench-ai/xbench-evals](https://github.com/xbench-ai/xbench-evals)
- **DeepSearch 场景**：AGI Tracking 系列之一，评测搜索与信息检索场景的工具使用能力 [来源](https://raw.githubusercontent.com/xbench-ai/xbench-evals/main/README.md)。HF: [xbench/DeepSearch](https://huggingface.co/datasets/xbench/DeepSearch)（100 行）与 [xbench/DeepSearch-2510](https://huggingface.co/datasets/xbench/DeepSearch-2510)（100 行新版）[来源](https://datasets-server.huggingface.co/size?dataset=xbench/DeepSearch)。
- **任务形态**：中文深度搜索题（CSV 含 id/prompt/answer/reference_steps/canary 列，答案与参考步骤**加密**，需用仓库解密代码获取明文）[来源](https://huggingface.co/datasets/xbench/DeepSearch)。Eval Card 显示题目形态如：给定筛选条件在证监会官网找 IPO 公司、多约束多跳（8+3+1=12 式）、从 top5 名单聚合等，且含时效题（如 2025-05-16 新闻）[来源](https://xbench.org/files/Eval%20Card%20xbench-DeepSearch.pdf)。
- **评分方式**：LLM-as-Judge，采用 Humanity's Last Exam 的 judge prompt（Eval Card 附完整 prompt）[来源](https://xbench.org/files/Eval%20Card%20xbench-DeepSearch.pdf)。
- **防污染/动态更新**：数据加密防搜索引擎爬取（canary 列）+ Evergreen 定期换新版（2505→2510 已换 100 新题）+ 出题绕开 AI 可爬取源（robots.txt 禁止 AI 的站点、私有数据库如 Arxiv/Bilibili 站内）[来源](https://raw.githubusercontent.com/xbench-ai/xbench-evals/main/README.md)。
- 榜单（产品级）：ChatGPT-5-Pro 75+ 分、SuperGrok Expert 40+、Manus/Doubao Deep Research 等 35+（2025.08 评测）[来源](https://raw.githubusercontent.com/xbench-ai/xbench-evals/main/README.md)。
- **适用度：高** —— 中文、面向真实产品级 agent（含成本/耗时指标）、防污染设计最好；100 题规模适中可直接抽题。

### 2.7 SimpleQA（OpenAI）

- **arXiv**: [2411.04368](https://arxiv.org/abs/2411.04368)；官方实现: [openai/simple-evals](https://github.com/openai/simple-evals)（数据：`openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv`）[来源](https://raw.githubusercontent.com/openai/simple-evals/main/simpleqa_eval.py)
- 4,326 道短事实型问题，对抗性收集（针对 GPT-4 回答出错处出题），答案唯一无争议 [来源](https://arxiv.org/html/2411.04368v1)。
- 评分：LLM 自动判分为 correct / incorrect / not attempted 三态，关注"知道自不知道"的校准 [来源](https://arxiv.org/abs/2411.04368)。
- 衍生：Google DeepMind 的 **SimpleQA Verified**（1,000 题清理版，HF: [google/simpleqa-verified](https://huggingface.co/datasets/google/simpleqa-verified)，arXiv 2509.07968）修复了原版标签噪声与冗余 [来源](https://huggingface.co/datasets/google/simpleqa-verified)。
- **适用度：中** —— 不需要联网（参数知识即可答），但在联网评测里作为"对照组"很有价值：SimpleQA 开卷（带搜索）正确率若不升反降，说明搜索管线在引入噪声。也是 CI 冒烟测试的理想规模。

### 2.8 FRAMES（Google）

- **arXiv**: [2409.12941](https://arxiv.org/abs/2409.12941)；HF: [google/frames-benchmark](https://huggingface.co/datasets/google/frames-benchmark)（824 题，apache-2.0）
- **设计目标**：统一评测 RAG 的 Factuality、Retrieval、reasoning MEasurement Set [来源](https://arxiv.org/abs/2409.12941)。
- **任务形态**：824 道多跳问题，需整合 2-15 篇 Wikipedia 文章信息；每题标注推理类型（数值/表格/多约束/时间/后处理）并附 gold 答案与相关 Wikipedia 文章 [来源](https://huggingface.co/datasets/google/frames-benchmark)。
- 基线：无检索 40.8%、BM25(4 docs) 47.4%、oracle 检索 72.9%、多步检索 66% [来源](https://huggingface.co/datasets/google/frames-benchmark)。
- **适用度：高** —— 规模适中、开源直接可跑、自带检索子指标（可用 gold 文章集算检索 recall）；是把"检索质量"与"最终答案"拆开评的最佳入门基准。

### 2.9 HotpotQA 等经典多跳基准（简述）

- **arXiv**: [1809.09600](https://arxiv.org/abs/1809.09600)；HF: [hotpotqa/hotpot_qa](https://huggingface.co/datasets/hotpotqa/hotpot_qa)（distractor 97,852 + fullwiki 105,257 行）[来源](https://datasets-server.huggingface.co/size?dataset=hotpotqa/hotpot_qa)
- 113k Wikipedia 多跳问答，提供句级 supporting facts 支持 EM/F1 与可解释性评测 [来源](https://arxiv.org/abs/1809.09600)。
- **适用度：中** —— 2018 年数据，污染严重（多数模型背过），不宜做能力结论；其 fullwiki 设置（先检索维基再答）可借鉴为"可控检索源"实验设计。同类还有 2WikiMultihopQA、MuSiQue（本报告未逐一核验，不展开）。

### 2.10 tau-bench / tau2-bench（Sierra）——适用性简评

- **arXiv**: [2406.12045](https://arxiv.org/abs/2406.12045) / [2506.07982](https://arxiv.org/abs/2506.07982)；GitHub: [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench)、[sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)（现更名为 τ³-bench，新增 banking 域与 voice 模态）[来源](https://raw.githubusercontent.com/sierra-research/tau-bench/main/README.md)
- 模拟用户（LLM 扮演）与 agent 的动态对话，agent 持有领域 API 工具与政策；用对话结束后的**数据库状态**与目标状态比对评分，并提出 pass^k 度量可靠性 [来源](https://arxiv.org/abs/2406.12045)。
- **与"联网搜索"的关系**：tau 系列评测的是"工具调用 + 遵守政策 + 与用户协作"（telecom 双控制环境），**不含 web 搜索**。对办公助手的价值在于其 pass^k 可靠性指标与"数据库终态比对"这种确定性评分思路，可迁移到"搜索后写入文档/表格的正确性"评测。**直接跑不适用。**

### 2.11 DeepResearch Bench（人大等，muset）与 Deep Research Bench（FutureSearch）——两个不同基准

**DeepResearch Bench（arXiv 2506.11763）**
- **arXiv**: [2506.11763](https://arxiv.org/abs/2506.11763)；GitHub: [Ayanami0730/deep_research_bench](https://github.com/Ayanami0730/deep_research_bench)；任务数据: `data/prompt_data/query.jsonl`（100 题基准任务）[来源](https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/main/README.md)；HF 数据集: [muset-ai/DeepResearch-Bench-Dataset](https://huggingface.co/datasets/muset-ai/DeepResearch-Bench-Dataset)（参考文章用）；排行榜: [Ayanami0730/DeepResearch-Leaderboard](https://huggingface.co/spaces/Ayanami0730/DeepResearch-Leaderboard)
- 100 道 PhD 级研究任务、22 个领域，中英各 50；任务分布基于 96,147 条真实匿名搜索查询按 WebOrganizer 分类对齐 [来源](https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/main/README.md)。
- **两套评测方法**（值得借鉴的核心）：
  - **RACE**（Reference-based Adaptive Criteria-driven Evaluation）：动态生成任务级评审标准（Comprehensiveness / Insight-Depth / Instruction-Following / Readability 四维），对照高质量参考报告加权打分 [来源](https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/main/README.md)。
  - **FACT**（Factual Abundance and Citation Trustworthiness）：抽取报告中的"陈述-URL"对→去重→网页抓取+LLM 判断引用是否真的支持该陈述→输出 **Citation Accuracy**（正确引用占比）与 **Effective Citations**（每任务有效引用均数）[来源](https://raw.githubusercontent.com/Ayanami0730/deep_research_bench/main/README.md)。
- **适用度：高（指标借鉴 + 中英双语任务）** —— FACT 是目前引用正确性评测最完整的开源管线，办公助手"带引用的搜索回答"可直接复用。

**Deep Research Bench（FutureSearch，arXiv 2506.06287）**
- **arXiv**: [2506.06287](https://arxiv.org/abs/2506.06287)；公开排行榜: [drb.futuresearch.ai](https://drb.futuresearch.ai/)
- 89 个多步 web research 任务、8 类任务型；核心创新是 **RetroSearch 环境**——大型冻结网页快照集，证明离线 RetroSearch agent 与 live web agent 表现相当，从而支持跨时间的可靠评测；并对长 agent 轨迹自动评估幻觉、工具使用、遗忘 [来源](https://arxiv.org/abs/2506.06287)。
- **适用度：中** —— "冻结快照环境"思路对解决"每次评测网页都变了"的痛点极具借鉴意义，但任务偏研究型。
- **关于 "KOREA 软件振兴院 (NIPA) + arXiv 2506.16263"**：arXiv 2506.16263 实为机器人论文 CapsDT [来源](https://arxiv.org/abs/2506.16263)；经 arXiv 全文检索 "Deep Research Bench" 仅得上述两篇 + DeepResearch Bench II (arXiv 2601.08536)。NIPA 版**未能确认**，疑似出处混淆。

**ReportBench（字节跳动，2025-08）**
- **arXiv**: [2508.15804](https://arxiv.org/abs/2508.15804)；GitHub: [ByteDance-BandAI/ReportBench](https://github.com/ByteDance-BandAI/ReportBench)
- 以 arXiv 高质量综述论文为 gold 标准，反向工程出 prompt；agent 化评估框架抽取引用与陈述、核对被引内容忠实度、用 web 资源验证无引用断言 [来源](https://arxiv.org/abs/2508.15804)。
- **适用度：中** —— 学术综述场景离办公较远，但其"逐条断言验证"与 FACT 互补。

### 2.12 ToolBench / BFCL（function calling 类）——适用性简判

- **ToolBench**: [OpenBMB/ToolBench](https://github.com/OpenBMB/ToolBench)（ICLR'24 spotlight），16,464 个 RapidAPI REST API 构建指令数据，评测工具选择与调用 [来源](https://raw.githubusercontent.com/OpenBMB/ToolBench/master/README.md)。
- **BFCL**: [Berkeley Function Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)，函数调用专项榜，AST/可执行双轨评分。
- **判断**：**不适用于"搜索工具调用"评估**。二者评的是"给定工具集，正确选工具+参数格式"，而搜索评测的难点在"多轮检索策略 + 信息综合"，参数对不对只是次要环节。若办公助手要评"该不该调搜索 vs 先问用户"这类路由问题，可抽 BFCL 的多工具场景做补充，但不是主战场。

---

## 3. 评测框架 / 工具链对比

| 框架 | Agent 端到端评测支持 | 关键能力 | 一手文档 |
|---|---|---|---|
| **promptfoo** | **强** | Python provider 封装任意 agent；OTel span 摄取后在 Trace Timeline 上做 `trajectory:*` 断言（工具调用、参数、顺序、任务成功）；支持 MCP、red-teaming | [Evaluate OpenAI Agents (Python SDK)](https://www.promptfoo.dev/docs/guides/evaluate-openai-agents-python/)、[Tools config](https://www.promptfoo.dev/docs/configuration/tools/) |
| **DeepEval** | **强** | 内置 agent 指标族：TaskCompletion（基于全 trace 的 LLM-judge）、ToolCorrectness（比对 expected vs actual 工具调用，可要求参数/输出也匹配）、Step Efficiency、Plan Adherence；支持 trajectory-based evals | [Tool Correctness](https://docs.confident-ai.com/docs/metrics-tool-correctness)、[Task Completion](https://docs.confident-ai.com/docs/metrics-task-completion) |
| **LangSmith (LangChain)** | **强** | Dataset + evaluator 框架，"把系统拆成 LLM 调用/检索/工具调用/输出格式并逐组件定标准"；支持 agent 轨迹评估与生产监控 | [LangSmith Evaluation concepts](https://docs.smith.langchain.com/evaluation) |
| **Arize Phoenix** | 中 | 代码型 evaluator（精确匹配/正则/自定义启发式）+ LLM-as-a-judge（rubric 打分）；可对生产 trace、实验结果或任意 dataset 跑评估；SDK（Python/TS）客户端侧 + 服务端两种模式 | [Phoenix Evals](https://arize.com/docs/phoenix/evaluation/llm-evals) |
| **OpenAI Evals** | 弱 | 官方注册表 + 自定义 eval 框架，现已引导到 OpenAI Dashboard 的 Evals 功能；对多轮 agent 轨迹断言无原生支持 | [openai/evals README](https://github.com/openai/evals) |
| **Ragas** | 弱（RAG 专用） | faithfulness / answer relevancy / context precision / context recall 等 RAG 分项指标；不含 agent 轨迹 | （DeepEval 文档对比页提及；Ragas 官方文档本会话未能直接核验，标注未确认） |

**适配要点**（针对带 web search 工具的办公助手）：
1. **promptfoo** 的路径：把办公助手封装成 Python provider（任何 pnpm monorepo 里的 agent 服务都可通过 HTTP/CLI 桥接），发 OTLP span，然后对"是否调用了搜索、搜索 query 质量、引用 URL 是否出现在最终回答、答案正确性"做 trajectory 断言 + LLM judge 断言。
2. **DeepEval** 的路径：把一次搜索问答记录为 LLMTestCase（input/actual_output/tools_called/expected_tools/retrieval_context），用 ToolCorrectness 评工具选择、用自定义 G-Eval（基于 Mind2Web 2 式 rubric）评答案与引用。
3. **LangSmith** 适合作为长期数据集管理与回归基线（生产 trace → 标注 → dataset → 实验），与上两者互补而非互斥。

---

## 4. 搜索质量分项指标（一手出处）

| 指标 | 定义与做法 | 一手出处 |
|---|---|---|
| **答案正确率（LLM-as-judge）** | "Judge whether the following [response] to [question] is correct based on the precise [correct_answer]"——HLE 同款 judge prompt，被 BrowseComp、xbench-DeepSearch 等直接复用 | [BrowseComp 论文 App. B](https://arxiv.org/html/2504.12516v1)；[simple-evals browsecomp_eval.py](https://github.com/openai/simple-evals/blob/main/browsecomp_eval.py)；[xbench Eval Card](https://xbench.org/files/Eval%20Card%20xbench-DeepSearch.pdf) |
| **引用正确性（citation accuracy）** | 抽取报告"陈述-URL"对→去重→抓取被引网页→LLM 判断该来源是否支持该陈述；报告为 Citation Accuracy % 与 Effective Citations 均值 | [DeepResearch Bench README — FACT](https://github.com/Ayanami0730/deep_research_bench#-fact-framework-for-factual-abundance-and-citation-trustworthiness)；[arXiv 2506.11763](https://arxiv.org/abs/2506.11763) |
| **来源归因（source attribution）** | Agent-as-a-Judge 中与答案正确性并列的评分轴：树状 rubric 分解出"哪些子结论须有来源支撑"逐一核查 | [Mind2Web 2, arXiv 2506.21506](https://arxiv.org/abs/2506.21506) |
| **覆盖率 / 检索 recall** | FRAMES：每题附 gold 相关 Wikipedia 文章集，可计算检索命中（recall）并与最终 accuracy 分开报告；oracle 检索 72.9% vs BM25 47.4% 即为该指标价值的直接证据 | [google/frames-benchmark](https://huggingface.co/datasets/google/frames-benchmark)；[arXiv 2409.12941](https://arxiv.org/abs/2409.12941) |
| **新鲜度 / 时效性** | xbench-DeepSearch 含需最新网页/新闻的题目（如评测当月日期敏感题），并把 Cost/Task 与 Time Cost/Task 与 accuracy 并列报告 | [xbench-evals README（2510 榜单含成本/耗时列）](https://github.com/xbench-ai/xbench-evals)；[Eval Card](https://xbench.org/files/Eval%20Card%20xbench-DeepSearch.pdf) |
| **可靠性 / 一致性** | tau-bench 的 pass^k（k 次试验全部通过率）度量 agent 行为一致性，可直接迁移到搜索 agent 的稳定性评测 | [arXiv 2406.12045](https://arxiv.org/abs/2406.12045) |
| **校准 / 知识边界** | SimpleQA 的 correct / incorrect / not attempted 三态判分，刻画"知道自己不知道" | [arXiv 2411.04368](https://arxiv.org/abs/2411.04368) |
| **幻觉 / 遗忘（轨迹级）** | 对长 agent 轨迹自动评估 hallucination、tool use、forgetting | [Deep Research Bench (FutureSearch), arXiv 2506.06287](https://arxiv.org/abs/2506.06287) |

> 补充：DeepEval 内置的 faithfulness / hallucination 指标（将回答拆成原子陈述逐条对照 context 验证）可作为引用核查的轻量替代，见其 [faithfulness 文档](https://docs.confident-ai.com/docs/metrics-faithfulness)。

---

## 5. 针对办公助手类产品的组合建议

### 5.1 适合直接跑（数据/评分器开箱即用）

| 基准 | 理由与跑法 |
|---|---|
| **FRAMES（824 题，先抽 100-200）** | HF 直接下载、答案+gold 文章齐全；一条命令算出"检索 recall"与"答案 accuracy"两条曲线，是诊断"搜索没找到" vs "找到了没答对"的首选 |
| **SimpleQA（抽 300-500）** | CSV 直读、官方 grader prompt 成熟；做"闭卷 vs 开卷（带搜索）"对照，监控搜索是否引入噪声；适合进 CI 做日级冒烟 |
| **BrowseComp-ZH（289 题）** | 中文原生、HF 直接下载；建议抽 50-100 题作为中文深度检索的季度压力测试（预期分数会很低，重在相对趋势） |

### 5.2 适合抽题自建 mini set（需改造或申请）

| 基准 | 理由与跑法 |
|---|---|
| **GAIA validation（300 题有公开答案）** | 需 HF 申请（gated）；题目形态（查资料+算+给短答案）与办公助手最像，建议抽 Level 1/2 各 30 题做起步；注意部分题需读附件文件，正好覆盖"搜索+本地文档"混合场景 |
| **xbench-DeepSearch-2510（100 题）** | 中文、防污染、含时效题；数据加密需用官方解密代码；更适合"每季度换题防泄漏"的自建池参考蓝本 |
| **Mind2Web 2 dev set** | gated(auto) 批准即用；不必全跑，重点复用其 judge agent 脚本给自建开放式搜索题打分 |

### 5.3 只适合借鉴指标设计

| 来源 | 借鉴点 |
|---|---|
| **Mind2Web 2** | Agent-as-a-Judge：树状 rubric + 任务专属 judge，评开放式答案与来源归因——办公助手开放式搜索问答的评分骨架 |
| **DeepResearch Bench (muset)** | FACT 管线：Citation Accuracy + Effective Citations，直接用于"带引用回答"的质量监控 |
| **Deep Research Bench (FutureSearch)** | RetroSearch 冻结快照环境：解决 live web 评测不可复现的问题 |
| **tau-bench** | pass^k 可靠性指标 + 数据库终态比对的确定性评分思路 |
| **xbench** | 数据加密 + canary + 定期换版 + 成本/耗时并列报告的产品级评测运营方式 |

### 5.4 建议落地路径（三阶段）

1. **第一阶段（1-2 周）**：promptfoo 或 DeepEval 搭 harness，把办公助手封装为 provider；跑 FRAMES 抽样 + SimpleQA 闭/开卷对照，建立基线。
2. **第二阶段（1 个月）**：申请 GAIA 与 Mind2Web 2 数据；抽题建 100 题自建混合集（中文 50 + 英文 50，含时效题与本地文档题）；引入 FACT 式引用核查指标。
3. **第三阶段（季度化）**：按 xbench 模式建"内部 evergreen 题池"（每季换 30% 题防泄漏），报告 accuracy / citation accuracy / recall / cost / latency / pass^3 六列。

---

## 6. 未能确认事项清单

1. **"KOREA 软件振兴院 (NIPA) 版 Deep Research Bench"**：arXiv 2506.16263 实为 CapsDT 机器人论文；arXiv 全文检索 "Deep Research Bench" 无 NIPA 作者条目。该条目疑为信息混淆。
2. **Ragas 官方文档**：本会话网络受限未能直接访问 ragas 文档站，其指标清单引自 DeepEval 对比页，未一手核验。
3. **BrowseComp 官方换题机制**：simple-evals 仓库 2025-07 起停止更新新模型结果，未见后续版本计划。
4. **GAIA 排行榜当前在线状态**：HF Space 存在（title: GAIA Leaderboard, gradio sdk 5.49.1），但因 gated 与网络限制未能验证榜单数据新鲜度。
