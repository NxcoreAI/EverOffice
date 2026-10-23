# Agent 调试页（独立浏览器调试台）

> 状态：已交付并独立验收（2026-10-23）
> 日期：2026-10-23
> 范围：Gateway runtime 埋点 + 独立浏览器调试页（不进入产品导航、不落库）

## 1. 背景与目标

EverRoom 现在同时运行多类 Agent：内置 Agent（`main`/`knowledge`/`web-search`/`transcription-summary`/`diary` 等）、dispatch-only 子 Agent（`slides-planner`/`slides-layouter`/`slides-builder`/`doc-writer` 等）以及本机 CLI Agent（`codex`/`claude`/`openclaw` 经 ACP）。排查问题时只能分别看某一处：Agent Office 只有状态摘要，主对话时间线只能看当前会话，子 Agent 事件又散在 `subagent_invocation_events` 表里。

目标：提供一个**独立浏览器调试页**，可以：

1. 看到所有 Agent 的实时工作进度（谁在跑、跑到哪一步、成功/失败）；
2. 看每一次 run 的**工具调用**（参数、结果、耗时、错误）和**思考过程**（`reasoning.delta`）；
3. 随时切换跟踪的 Agent，查看不同 Agent 的执行流与最终输出。

非目标：

- 不进入产品 UI 导航，不随 Desktop 打包发布；
- 不做持久化归档，不新增数据库表；
- 不改变任何 Agent 的业务行为与权限；
- 不做远程/多人共享（只绑 `127.0.0.1`）。

## 2. 总体架构

```mermaid
flowchart LR
  subgraph Runtime["Gateway（主网关）"]
    R["AgentResolver
 内置 Agent"] --> T["AgentDebugTraceStore
 内存环形缓冲"]
    S["SubagentRuntimeManager
 dispatch-only 子 Agent"] --> T
    L["LocalAgentRuntimeRegistry
 本机 CLI Agent"] --> T
    T --> API["/v1/agent-debug/*
 snapshot / runs/:id/events"]
  end

  subgraph Page["独立调试页（Vite dev server）"]
    P["React 调试台"] -->|同源 /@agent-debug/gateway/...| V["Vite 代理插件
 读 runtime manifest、注入 Bearer"]
    V -->|HTTP + Bearer| API
  end

  M["~/Library/Application Support/EverRoom/runtime/gateway.json"] -.读取.-> V
```

关键取舍：**只在 Gateway 的 runtime 边界埋点**。三个 runtime 创建/获取入口已经覆盖全部 Agent，业务模块无需改动：

| 入口 | 覆盖范围 | 埋点位置 |
| --- | --- | --- |
| `AgentResolver`（`trackedRuntime`） | 全部内置 Agent（含 `main`、模型档位、knowledge、web-search 等） | `createRuntime()` 返回后包一层 trace |
| `SubagentRuntimeManager` | 全部 dispatch-only 子 Agent | `createRuntime()` 返回处包一层 trace |
| `LocalAgentRuntimeRegistry` | 本机 CLI Agent（ACP） | `resolve()` 新建 runtime 时包一层 trace |

> developer 类型 Agent 在 `AgentResolver` 中也注册了定义（用于状态页），但其 runtime 来自 `SubagentRuntimeManager.acquire()`。为避免同一 run 被记录两次，`AgentResolver` 对 `kind === "developer"` **不再包 trace**。

主网关与补全专用网关（`cursor-completion-server`）各自创建自己的 store 与路由；调试页通过 manifest 自动发现多个网关来源。KnowledgeService 内部自建的 `AgentResolver` 也注入了同一个 store（`createKnowledgeAgentResolver(config.dataDir, config.llm, agentDebugStore)`）。

## 3. 数据面

### 3.1 契约类型

新增在 `@nxcore/agent-contract`：`AgentDebugAgent`、`AgentDebugRun`、`AgentDebugEvent`、`AgentDebugSnapshot`、`AgentDebugRunEvents`。

### 3.2 AgentDebugTraceStore（内存环形缓冲）

常量（`apps/gateway/src/modules/agent-debug/trace-store.ts`）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `MAX_EVENTS_PER_RUN` | 3000 | 每个 run 保留的事件条数上限 |
| `MAX_RUN_BYTES` | 8 MB | 每个 run 全部事件 payload 的累计字节上限 |
| `MAX_RUNS` | 150 | 全部 run 条数上限 |
| `MAX_EVENT_BYTES` | 64 KB | 单条事件 payload 序列化预算 |

行为：

- 单条 payload 超 64KB 时截断为字符串预览并记录 `truncatedBytes`；超限事件数/字节数从最旧事件淘汰，累计 `droppedEvents`（快照/事件响应里可见）。
- run 数超过 150 时优先淘汰最旧的**终态** run，无终态可淘汰才淘汰最旧运行中 run，累计 `droppedRuns`。
- 相邻同类 `reasoning.delta` / `message.delta` 合并为一条累计事件（**seq 不变**，payload 分片保存、读取时物化），避免流式 token 把缓冲冲爆。`reasoningChars` 只累计 `reasoning.delta` 字符数。
- 增量接口在返回 `seq > afterSeq` 的事件之外，还会额外带回**最后一条可合并的尾部事件**（其 seq 可能 ≤ `afterSeq`，内容仍可能在增长）；调试页必须按 seq **upsert**（替换同 seq 事件）而不是只追加。
- run 元数据在 `beginRun` 时确定，`finishRun` 补齐终态；终态只允许写一次（幂等）。若同一 `runId` 再次 `beginRun`（resume 复用 runId），保留已累计事件并把状态拉回 `running`、清空终态字段，保证下一次终态仍可回写。
- `dispose()` 清理缓冲。

### 3.3 埋点语义

trace 包装 `AgentRuntime.start()` / `resume()`（`apps/gateway/src/modules/agent-debug/instrument.ts`）：

1. run 开始时 `beginRun({ runId, agentId, agentName, agentKind, runtimeId, sessionId, pageLabel, task })`；
2. 事件流逐条 `recordEvent`（含 `reasoning.delta`、`tool.*`、`message.*`、`context.usage`、`run.*`）；
3. 收到 `run.completed/failed/cancelled/interrupted`、事件流抛错、消费者提前 `break` 或流结束无终态时 `finishRun`；
4. 事件原样向下游透传，**不改变顺序、不吞异常**；store 自身的任何异常都被吞掉，不影响 Agent 行为；
5. 同一 runtime 重复包装只生效一次（WeakSet + Symbol 标记）。

### 3.4 HTTP API

均走既有 Gateway Bearer 鉴权（`Authorization: Bearer <token>`），只读、无写操作。

| 方法 | 路径 | 参数 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/agent-debug/snapshot` | `runs`：整数 1–300，默认 150 | Agent 目录 + 最近 run 摘要 + `droppedRuns` |
| GET | `/v1/agent-debug/runs/:runId/events` | `afterSeq`：整数 ≥0，默认 0；`limit`：整数 1–5000，默认 1000 | 单个 run 的事件增量；返回 `{ run, events, latestSeq }` |

响应要点：

- `snapshot` = `{ generatedAt, agents, runs, droppedRuns }`；`agents` 是 `AgentDebugAgent[]`（`id/name/description/kind/state/activeRunCount/lastRunAt`），`runs` 运行中优先、其余按 `startedAt` 倒序，`runs[i].eventCount` 是**缓冲内保留**的事件数。
- `events` 按 seq 升序；`latestSeq` 是缓冲内当前最大 seq（下一次 `afterSeq` 的上界参考）；页被 `limit` 截断时客户端应以**本页最后一条事件的 seq** 推进游标，而不是直接跳到 `latestSeq`。
- `snapshot.agents` 来源：主网关用 `AgentStatusService.snapshot()`（内置 + developer），再合并缓冲里观测到的本机 Agent；补全网关用 resolver 定义 + activity 推导。
- 边界：无/错误 token → `401`；未知（或已被缓冲淘汰的）run → `404`；`runs>300`、`limit>5000` 等参数越界 → `400`。

## 4. 独立浏览器调试页

### 4.1 启动方式

```bash
pnpm debug:agents        # 根目录；即 pnpm --filter @nxcore/desktop exec vite --config vite.agent-debug.config.mts
```

默认地址 **http://127.0.0.1:5199/debug/agent-debug.html**。等价方式：

```bash
cd apps/desktop && pnpm debug:agents
# 或直接跑 vite（CI/受限环境无 pnpm 依赖校验时用这个）：
node apps/desktop/node_modules/vite/bin/vite.js --config apps/desktop/vite.agent-debug.config.mts
```

环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AGENT_DEBUG_PORT` | `5199` | dev server 端口（`strictPort: true`，被占用即失败） |
| `EVERROOM_AGENT_DEBUG_MANIFEST` | — | 显式 manifest 路径；POSIX 用 `:`、Windows 用 `;` 分隔多个 |
| `NXCORE_DATA_DIR` | 平台默认数据目录 | 覆盖 manifest 自动发现的数据目录 |

调试页不进入 Electron renderer 构建产物，也不参与产品打包；`vite build` 只输出到 `apps/desktop/out/agent-debug/` 供验证。

### 4.2 网关发现与鉴权代理

Vite 插件 `agent-debug-gateway`（`configureServer` 里在 Vite 内部中间件之前挂载）：

- manifest 发现顺序（无效候选直接跳过，路径去重）：
  1. `EVERROOM_AGENT_DEBUG_MANIFEST`（相对路径按 cwd 解析）；
  2. `NXCORE_DATA_DIR`（缺省为 EverRoom 平台数据目录）下 `runtime/gateway.json` 与 `cursor-completion-service/runtime/gateway.json`；
  3. NxCore 独立网关数据目录下 `runtime/gateway.json`；
  4. 仓库 `.data/runtime/gateway.json`。
- 每次请求按 **mtime** 重读 manifest：Desktop 重启换了端口/token 会自动生效。
- `GET /@agent-debug/sources` 返回 `[{ id, label, baseUrl, version }]`，**不含 token**；manifest 无效/读取失败时通过 `x-agent-debug-warning` 响应头（URI 编码）带回可读提示。
- `GET /@agent-debug/gateway/:sourceId/*` 在同源内转发到对应 `baseUrl`，由 dev server 注入 `Authorization: Bearer <token>`；token 只存在于 Node 进程，不进浏览器、不进页面 bundle。
- 代理只接受 GET（其它方法 `405`）；无任何 manifest 时 `503`；未知 sourceId `404`。
- dev server 只监听 `127.0.0.1`（`server.host = '127.0.0.1'`）。

### 4.3 页面布局

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Agent · 来源 · 连接状态 · 过滤 · 刷新 · 暂停                              │
├──────────────┬──────────────┬────────────────────────────────────────────┤
│ Agent 列表   │ 该 Agent 的  │ Run 详情                                   │
│ 全部/内置/子 │ run 列表     │ ┌ 时间线：思考 / 工具调用 / 消息 / 系统事件 │
│ Agent/本机   │ 运行中置顶   │ ├ 原始事件（事件列表 + JSON，点击查看）     │
│ 状态标记+次数│ 耗时/工具数  │ └ 输出（最终消息 + 结构化结果）             │
└──────────────┴──────────────┴────────────────────────────────────────────┘
```

交互：

- 左侧点选 Agent = **切换跟踪对象**；切换时 run 列表按 `agentId` 过滤，事件缓冲按 `sourceId + runId` 重置为 0 增量重新拉取；点「全部 Agent」看全局 run 流。
- Agent 类型页签：全部 / 内置（builtin）/ 子 Agent（developer）/ 本机 Agent（local）。
- run 列表自动跟随最新活跃 run（可关闭「跟随」）；终态 run 保留在缓冲里可回看。
- 时间线：思考块可折叠；工具行可展开参数/结果/失败错误，展开内容为纯 mono JSON；另有上下文用量文本、压缩提示、审批、系统事件行。
- 「原始事件」页签：事件列表 + 选中事件的 JSON（列表最多渲染最近 1200 条，顶栏过滤可缩小范围；JSON 预览超过 240k 字符会截断提示）。
- 「输出」页签：最终 assistant 文本 + `subagent_submit_result` 结构化结果（依次尝试 `tool.completed.result.content` 里的 JSON、`result` 本身、`tool.started.args`，并标注提取来源）。
- 轮询策略：snapshot 1200ms；选中 run 运行中 400ms 增量拉事件（终态后停止）；暂停后完全停止轮询；事件按 seq upsert 合并。

#### 视觉规范（浅色极简，2026-10-23 改版）

整体走「排版优先、无装饰」的开发者工具风格，避免深色霓虹 / 渐变 / 彩色胶囊 / 图标墙等 AI 产品常见视觉。

| 维度 | 规范 |
| --- | --- |
| 颜色 | 仅 10 个值：中性 `#fbfbfa`(bg) `#ffffff`(surface) `#1b1b1a`(text) `#5f5f5a`(secondary) `#8a8a84`(muted) `#e3e3df`(border) `#f3f3f0`(hover) `#eeeeea`(selected) + 语义 `#3d6ff6`(accent：选中/运行中/焦点) + `#b42318`(danger：失败/错误) |
| 字体 | 系统 UI 栈（`-apple-system` / `PingFang SC` / `Helvetica Neue`）；数据、ID、JSON、时间用 `ui-monospace` / `SF Mono` / Menlo；正文 13px/1.65、界面 12px、meta 10.5–11px、字重仅 400/500 |
| 结构 | 三栏 1px 竖线分隔（240 / 330 / 1fr，≤1360px 收窄为 210 / 300 / 1fr）；无卡片容器、无阴影、无圆角（仅 0 与 2px）；顶栏 40px + 1px 底线 |
| 状态 | 全部用文字：运行中=accent、完成=muted、失败/中断/超时=danger；Agent 行仅 running/error 有 4px 静态方点，无脉冲动画 |
| 图标 | 除时间线展开的 `ChevronRight` 外不使用图标；复制等操作是纯文字按钮（muted → hover 深色）；来源选择器为无边框文字 + 1px 下划线 |
| 内容 | 思考块=1px 左线 + 缩进灰色正文、默认折叠 3 行；工具=单行 head（mono 名称/状态/参数预览/耗时）+ 展开纯 mono JSON（keys muted、无彩色高亮）；消息为纯文本段落（max-width 760px，流式行尾低调 `▍`）；usage 为一行 mono 文本，无进度条 |

约束自检（`apps/desktop/src/renderer/src/agent-debug`）：无 `gradient` / `box-shadow` / `text-shadow` / `@keyframes` / `animation` / `rgba()`；hex 字面量恰好上述 10 个；`border-radius` 仅 0 与 2px；`lucide-react` 仅 `ChevronRight`；无外部字体 / emoji / `backdrop-filter`。

截图（headless Chrome，1680×1050，均为改版后浅色极简 UI）：

- 主视图（mock 数据，含思考/工具/失败态/usage/流式消息）：`screenshots/agent-debug/minimal-1680.png`；窄屏 1280×720 无横向溢出：`minimal-1280.png`。
- 页签：`minimal-events.png`（原始事件 + JSON）、`minimal-output.png`（输出 + 结构化结果）。
- 空态：`minimal-empty.png`；连接真实 EverRoom 主网关（17 个 Agent）：`final-real-app-agents.png`。
- 改版前的深色版本截图（`debug-page.png`、`e2e-*.png`、`live-*.png`）保留为历史验收证据，不代表当前 UI。


## 5. 文件清单

```text
packages/agent-contract/src/index.ts                     # 调试契约类型
apps/gateway/src/modules/agent-debug/
  trace-store.ts                                         # 内存缓冲 + 合并/淘汰
  instrument.ts                                          # runtime 边界 trace 包装
  routes.ts                                              # /v1/agent-debug/*
apps/gateway/src/modules/agent/resolver.ts               # 接入 trace（跳过 developer）
apps/gateway/src/modules/subagents/runtime-manager.ts    # 接入 trace
apps/gateway/src/modules/local-agents/runtime-registry.ts# 接入 trace
apps/gateway/src/modules/knowledge/service.ts            # 内部 resolver 注入同一 store
apps/gateway/src/server/create-server.ts                 # 创建 store、注册路由
apps/gateway/src/server/create-cursor-completion-server.ts
apps/gateway/tests/agent-debug.test.ts                   # store/埋点/路由单测（29 个）
apps/desktop/vite.agent-debug.config.mts                 # dev server + 网关代理插件
apps/desktop/debug/agent-debug.html                      # 页面入口
apps/desktop/src/renderer/src/agent-debug/               # React 调试台源码（App/api/reducer/components/format/styles）
apps/desktop/tests/agent-debug-reducer.test.ts           # reducer/upsert/输出提取单测（17 个）
scripts/agent-debug-smoke.mjs                            # fake 网关端到端冒烟（可重复执行）
screenshots/agent-debug/                                 # 验收截图
docs/agent-debug-page.zh-CN.md                           # 本文
```

## 6. 安全与资源边界

- 调试页只监听 `127.0.0.1`，通过 dev server 代理访问网关，浏览器侧拿不到 Bearer token；`/@agent-debug/sources`、页面 HTML/DOM/构建产物（`out/agent-debug`）均不含 token。
- 页面无 `window.nxcore` / Electron / Node `require` 依赖，可独立在普通浏览器打开。
- 数据只存在 Gateway 进程内存里，网关退出即清空；不写入数据库、不写日志、不进 Sentry。
- payload 截断上限 64KB、每 run 8MB / 3000 条、总 run 150 条，避免长时间运行吃内存。
- 生产构建不包含调试页；Gateway 路由本身只读，无写操作。

## 7. 验收记录（2026-10-23）

环境：macOS，系统 `node v22.23.1`（必须用系统 node；bundled DSH node 加载 `@napi-rs/canvas` 会因签名 Team ID 失败），仓库 `feat/slides-layout-tree` 未提交工作区。

### 7.1 fake runtime 网关端到端（PASS）

```bash
rm -rf .tmp-pnpm/e2e-data && mkdir -p .tmp-pnpm/e2e-data && : > .tmp-pnpm/e2e-empty.env
NXCORE_AGENT_RUNTIME=fake NXCORE_GATEWAY_TOKEN=agent-debug-e2e-token \
NXCORE_ENV_FILE=$PWD/.tmp-pnpm/e2e-empty.env \
  node apps/gateway/node_modules/tsx/dist/cli.mjs apps/gateway/src/bin/serve.ts \
  --host 127.0.0.1 --port 3411 --data-dir $PWD/.tmp-pnpm/e2e-data \
  --migrations-dir $PWD/apps/gateway/drizzle
```

- `/v1/health/ready` → 200；manifest 写入 `.tmp-pnpm/e2e-data/runtime/gateway.json`（baseUrl/token/pid/version）。
- 建 2 个会话（pageLabel `Home` / `Room`）各起 1 轮 run（`POST /v1/agent/sessions` + `POST /v1/agent/sessions/:id/runs`），两 run **同时 running**；快照中 `agentId=main`、`agentKind=builtin`、`eventCount`/`reasoningChars` 随事件增长，终态 `completed` 且 `completedAt` 有值。
- 事件链路完整：`run.started → reasoning.delta → message.started → message.delta → message.completed → run.completed`；seq 严格递增，`latestSeq` 等于最后一条事件 seq；`reasoning.delta`/`message.delta` 各合并为 1 条整段事件，`message.delta` 文本等于 `message.completed.content`（83 字符）。
- 增量语义：`afterSeq=latestSeq` 时运行中最多重放 1 条 `seq ≤ latestSeq` 的尾部 delta（供 upsert），终态后返回空；`afterSeq` 严格增量、`limit=1` 截断不影响 `latestSeq`。
- 边界：无 token → 401（snapshot 与 events）；未知 run → 404；`snapshot?runs=1000` → 400；`events?limit=5001` → 400。

可重复执行的冒烟脚本（对上述网关）：

```bash
node scripts/agent-debug-smoke.mjs --base http://127.0.0.1:3411 --token agent-debug-e2e-token
# 结果：22 项断言全部 PASS
```

### 7.2 调试页连真实 fake 网关（PASS）

```bash
cd apps/desktop
EVERROOM_AGENT_DEBUG_MANIFEST=$PWD/../../.tmp-pnpm/e2e-data/runtime/gateway.json AGENT_DEBUG_PORT=5299 \
  node node_modules/vite/bin/vite.js --config vite.agent-debug.config.mts
```

- `GET /debug/agent-debug.html` → 200；`GET /@agent-debug/sources` → 200，含 `baseUrl=http://127.0.0.1:3411`、`version=0.1.0`，**不含 token**。
- `GET /@agent-debug/gateway/<sourceId>/v1/agent-debug/snapshot` → 200，返回 16 个 Agent、真实 run 列表。
- headless Chrome（`--headless=new --disable-gpu --hide-scrollbars --window-size=1680,1050`，本机需额外 `--no-sandbox` 才能在受限环境启动）CDP 断言：顶栏在线且来源为 `127.0.0.1:3411`；Agent 列表含 `main`（内置）与子 Agent 分类；run 列表含真实 run；时间线渲染思考块 + 助手消息块；原始事件/输出页签可切换；运行中 run 显示「400ms 增量拉取中」。
- 截图（改版前深色 UI，历史证据）：`screenshots/agent-debug/e2e-real-gateway-timeline.png`、`e2e-real-gateway.png`、`live-e2e-real-gateway-timeline.png`；当前浅色极简 UI 见 §4.3/§7.6。

### 7.3 UI 覆盖性（mock 数据，PASS）

`.tmp-pnpm/agent-debug-mock/mock-gateway.mjs`（8 个 run，覆盖主 Agent / 子 Agent / 本机 Agent、运行中/完成/失败、审批卡、工具失败、结构化 submit 结果）配合 `manifest.json` 起第二个 dev server（端口 5399）后 CDP 断言全部 PASS：

- Agent 列表含「全部 / 内置 / 子 Agent / 本机 Agent」页签，三类 Agent 均可见；本机页签过滤出 codex/claude。
- run 列表渲染 8 个 run，含 running/completed/failed；点选 Agent 后 run 列表与事件增量随之切换（claude 时间线不含 codex 的 `connector_search`，切回 main 后重新出现）。
- 时间线含思考块、工具卡（展开可见参数/部分结果/结果）、失败工具卡（`approval_denied`）、审批卡、上下文用量；尾部累计 delta 被重复回放时文本不重复追加（seq upsert 生效）。
- 「原始事件」页签渲染事件列表 + JSON；「输出」页签展示最终文本与 `subagent_submit_result` 结构化结果。
- 无 manifest（HOME 指向空目录）时空态引导正常：提示「未发现本地 Gateway」、`EVERROOM_AGENT_DEBUG_MANIFEST` 与默认 manifest 路径。
- 页面 `window.nxcore`/`electron`/`require`/`process` 均不存在；DOM 与内联脚本不含 token / `Bearer <token>`。
- dev server 只绑 loopback：从本机 LAN IP `192.168.1.99:5299` 连接被拒（ECONNREFUSED）。
- 截图（改版前深色 UI，历史证据）：`screenshots/agent-debug/e2e-mock-*.png`；当前浅色极简 UI 见 §4.3/§7.6。

### 7.4 回归（PASS）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Gateway typecheck | `cd apps/gateway && node node_modules/typescript/bin/tsc --noEmit` | exit 0，无输出 |
| Gateway 测试 | `node node_modules/vitest/vitest.mjs run tests/agent-debug.test.ts tests/agent-resolver.test.ts tests/subagents.test.ts tests/external-calls.test.ts tests/server.test.ts` | 5 files / **89 tests passed**（含 agent-debug 29 个；Lead 终验在 resume 兜底修复后复跑） |
| Desktop typecheck | `cd apps/desktop && node node_modules/typescript/bin/tsc --noEmit` | exit 2，**10 条错误且与基线 `.tmp-pnpm/desktop-typecheck-baseline.log` 完全一致**（全部在既有 `ThoughtsPane.tsx`），agent-debug 目录 0 错误 |
| Desktop reducer 测试 | `node node_modules/vitest/vitest.mjs run tests/agent-debug-reducer.test.ts` | 1 file / **17 tests passed** |
| 调试页构建 | `node node_modules/vite/bin/vite.js build --config vite.agent-debug.config.mts` | exit 0，1589 modules → `out/agent-debug`（js 203.07 kB / gzip 63.31 kB） |

> 验收环境注意：不要跑 `pnpm --filter`（当前会触发 pnpm 依赖校验 install 并在无 TTY 时中止），用上面的 `node node_modules/...` 直跑形式等价；不要 `pnpm install`、不要 `git commit`。

### 7.5 代码审查结论

- trace 包装只在 runtime 边界旁路记录，事件原样透传（单测覆盖：顺序不变、异常照抛、stream 抛错/提前结束/无终态收尾、start 抛错、重复包装幂等）。
- developer 类型在 `AgentResolver` 跳过 trace，由 `SubagentRuntimeManager.acquire()` 记录一次，无双重记录。
- 缓冲上限（3000 条/8MB/run、150 run、64KB/event）在单测中逐项验证真实生效，`droppedEvents`/`droppedRuns` 可观测。
- 代理不回传 token：`sources`、页面 HTML、DOM、构建产物均无 token；代理仅注入 `Authorization` 且只支持 GET。
- 页面无 Electron/Node 依赖；dev server 绑定 `127.0.0.1`（配置 + LAN IP 连接被拒双重确认）。

### 7.6 视觉改版（浅色极简，2026-10-23 二次验收）

用户反馈首版「深色 + 彩色 badge/图标/圆角卡片」偏 AI 风格，改为浅色、中性、排版优先的极简视觉（规范见 §4.3）。只改 `apps/desktop/src/renderer/src/agent-debug/**` 的样式与 markup/文案，数据逻辑、gateway、contract 未动。

| 项 | 结果 |
| --- | --- |
| 约束自检 | 无 gradient / box-shadow / text-shadow / keyframes / animation / rgba；hex 恰好 10 个规范值；`border-radius` 仅 0 与 2px；`lucide-react` 仅 `ChevronRight`；无网络字体 / emoji / backdrop-filter |
| `styles.css` | 1694 → 1100 行；`:root` 集中颜色/字号/间距变量 |
| Desktop typecheck | 10 条错误仍全部为既有 ThoughtsPane 基线，agent-debug 0 错误 |
| reducer 测试 | 17 passed（未改 reducer） |
| 调试页构建 | ✓ 1589 modules → css 14.51 kB（旧 30.11 kB）/ js 181.24 kB（旧 203.07 kB） |
| 功能回归（CDP） | 三页签、工具/思考展开、过滤、暂停/继续、跟随开关、切 Agent、复制、自动滚底 +「回到底部」全部可用，无 console error |
| 截图 | `minimal-1680.png`、`minimal-1280.png`（无横向溢出）、`minimal-events.png`、`minimal-output.png`、`minimal-empty.png`、`final-real-app-agents.png`（连接真实主网关 17 个 Agent） |

> 旧深色截图保留为改版前历史证据；`final-real-app-agents.png` 已用新 UI 覆盖。

## 8. 已知限制

- 仅内存：Gateway 重启后历史 run/事件全部丢失；不落库、不跨进程共享。
- 单机调试：dev server 与 Gateway 都只绑 `127.0.0.1`，不支持远程/多人访问。
- fake runtime 只产生 `run.started/reasoning.delta/message.*/run.completed`，不产生工具/审批事件；工具卡、审批卡、失败态需用 mock 数据或真实 runtime 验证（见 7.3）。
- 事件缓冲有上限：长 run 或大量 run 时旧事件会被淘汰（`droppedEvents`/`droppedRuns` 提示），时间线可能不完整。
- 调试页是 dev-only 页面：`vite build` 仅用于验证/占位，不随 Desktop 发布。
- resume 复用同一 runId：`beginRun` 保留既有事件与计数，并把终态重新拉回 `running`（清空 `completedAt`/`errorMessage`），后续终态可正常回写。当前 Gateway 业务链路尚未调用 `runtime.resume()`，该行为为前瞻性兜底。
- 页面轮询是固定间隔的全量快照 + 增量事件，不做推送；超高频事件流下 400ms 轮询可能合并多批。
