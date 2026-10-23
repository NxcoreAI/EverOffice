# 只保留 Office + Agent：移除记忆与 Context Room 的可执行改造计划

> 版本：v1 · 2026-10-23 · 状态：执行中
> 范围：`NxcoreAI/EverRoom`（`nxcore-ce`）monorepo
> 前置审计：行号以 2026-10-23 工作区（起点 `3cbfc289`）为准。
> 关联文档：[agent-architecture-optimization-plan.zh-CN.md](./agent-architecture-optimization-plan.zh-CN.md)、[agent-document-development-sop.md](./agent-document-development-sop.md)

---

## 0. 目标与终态

**保留**：Office（文档 / 表格 / 幻灯片 / PDF 的生产、编辑、预览、导入导出）与 Agent（会话、调度、子 Agent、连接器、通知）。

**移除**：记忆（MemoryCore / 屏幕记忆 / 知识库 Wiki / 实体 / 写作风格画像）与 Context Room（房间、总览、纠错、合并、任务夹），以及只为它们供料的采集管线（现实感知、转写、摄取、素材、剪藏、日记）。

**终态关键判据**（Phase 0 完成的定义）：

1. 用户能在没有 Room 概念的前提下新建文稿 → Agent 写入 → 审阅 patch → 导出 docx/pptx/xlsx；
2. Agent 会话能正常创建、流式、取消、派发子 Agent，且工具面里不含任何 `memory_*` / `wiki_*` / `conversation_search` / `context_room_*` / `room_*`；
3. `pnpm typecheck` 与保留后的 `pnpm test` 全绿；
4. 代码里不存在对 `modules/{memory,knowledge,context-rooms,screen-memory,perception,reality,ingest,diary}` 的任何 import。

**非目标**：连接器（OpenConnector / 飞书 / Notion）、SaaS 登录与云同步、本地文件与 GitHub 源接入——这些照旧。

### 0.1 需产品/架构拍板的 3 项（已按建议默认执行）

| # | 议题 | 决策 |
|---|---|---|
| D1 | 文稿的容器模型。现状：`documents` 表无 `room_id`，容器关系在多对多表 `room_doc_links(room_id, document_id, folder_id)` 上 | 去掉房间维度，`docs` 页作为唯一文稿入口，保留任务夹作为轻量分组；`room_doc_links` 随迁移 drop |
| D2 | 「新文档写作路线导图」（`route_mindmap_*`），素材 100% 来自 Room 三图谱 | 一并删除 |
| D3 | `agents/cursor-completion`（文档光标补全），功能属 Office、命名带 Room 前缀 | 保留功能，重命名为 `document-cursor-completion` |

---

## 1. Phase 0：划界

### P0-1 迁出寄生在 `components/context-room/` 里的 Office 编辑器 —— 已完成第一刀

`git mv` 后的新布局（分支 `refactor/office-agent-only`）：

| 新路径 | 内容 |
|---|---|
| `apps/desktop/src/renderer/src/components/office-editor/editor/` | 原 `context-room/ported/components/detail-editor/` 全部 69 个文件（Tiptap 编辑器、块引用、块索引标记、批注锚点、导入导出对话框、划词改写 UI、历史 diff） |
| `apps/desktop/src/renderer/src/components/office-editor/embeddedOffice.ts` | 原 `ported/embeddedOffice.ts`，Office 实例仲裁 |
| `apps/desktop/src/renderer/src/components/office-editor/officeViewport.ts` | 原 `ported/officeViewport.ts`，Office 视口挂载 |

同步改写的引用：44 个外部文件（含 `App.tsx`、`DocsPage`、`mock-overview-entry`、`tests/**` 共 35 个测试文件），旧路径 0 残留。

**验证结果**：`tsc --noEmit` 与基线完全一致（10 个错误，全部是 `detail-panels/ThoughtsPane.tsx` 的存量错误）；编辑器相关 41 个测试文件、298 个用例中，3 个失败（`document-image-assets`、`document-comments-panel`、`document-comments-anchor-marks`）经 stash 对比确认**为基线既有失败**，与本次搬移无关。

**P0-1 后续（已完成的部分，2026-10-23）**：

| 反向依赖 | 处理 | 状态 |
|---|---|---|
| `context-room/operations/*`（文档操作中心 / 审阅 / 续写，18 文件） | 迁到 `office-editor/operations/` | 已完成 |
| `ported/types.ts`、`ported/adapters.ts` | 迁到 `office-editor/`（`ContextRoom*` 类型改名留到 P0-3） | 已完成 |
| `ported/components/shared.tsx` | 迁到 `office-editor/shared.tsx` | 已完成 |
| `ported/components/detail-panels/MarkdownBody(.test).tsx` | 迁到 `office-editor/` | 已完成 |
| `ported/components/MoveDocumentToRoomDialog` | 从 `TiptapDocumentActions` 摘除菜单项/状态/对话框 | 已完成 |
| `@/components/context-room/RoomDocumentsProvider` | P0-2 用工作区维度文稿库 Provider 替换 | **待做（P0-2 第一件事）** |

另注：`office-editor` 内 34 个文件仍含 `context-room-*` CSS 类名与 `contextRoom:` i18n key（纯样式/文案，不影响编译），在 Phase 2 收尾时统一改名，避免与 `styles.css` 大改混在同一次提交里。

### P0-2 文档域去 roomId

**问题**：`roomId` 已渗入文档内核——`capabilities/*.ts` 113 处、`service.ts` 41 处、`routes.ts` 13 处、`mcp-host.ts` 8 处。

**做法**：

1. `documents` 的表结构不动（本就无 `room_id`）；`room_doc_links` 随迁移 drop（见 §5）。
2. 文档权限判据从「同房间」改为「同工作区」：
   - `service.ts:795-847` 的 `assertRoomAccess` / `readDocumentForAgent(documentId, roomId)` → `readDocumentForAgent(documentId)`；
   - `service.ts:1056-1064` 的 `document.roomId !== input.roomId` 校验删除；
   - `mcp-host.ts:377` 的 `bound.roomId !== request.roomId` 门禁删除；
   - `mcp-host.ts:179-181` 的 `roomExists()` 删除。
3. 列表与回收站按工作区收敛：`service.ts:311` `list(roomId, …)` → `list(options)`；`service.ts:1121` `emptyTrash(roomId)` → `emptyTrash()`；`routes.ts:36-56`、`:303-307` 的 `roomId` query 参数删除。
4. `routes.ts:459` 的 WS `document.ready` 去掉 `roomId` 字段。
5. `service.ts:322-334` 的 `move(fromRoomId, roomId)` 改为 `moveToFolder(documentId, folderId | null)`。
6. `capabilities/` 各 plugin 的 `roomId` 参数逐个摘除（以 `rg roomId apps/gateway/src/modules/documents/capabilities` 收敛到 0 为验收）。

### P0-3 工具改名（25 个 `context_room_*`）

| 旧名 | 新名 | 归属 | 定义位置（起点） | 状态 |
|---|---|---|---|---|
| `context_room_list` | — 删除 | Room | query-plugin | 待 Phase 2 |
| `context_room_create` | — 删除 | Room | create-plugin | 待 Phase 2 |
| `context_room_document_list` | `document_list` | Office | query-plugin.ts:102 | ✅ 已改 |
| `context_room_document_read` | `document_read` | Office | query-plugin.ts:127 | ✅ 已改 |
| `context_room_document_delete` | `document_delete` | Office | delete-plugin.ts:20 | ✅ 已改 |
| `context_room_document_comment_add` | `document_comment_add` | Office | comment-plugin.ts:40 | ✅ 已改 |
| `context_room_write_begin` | `document_write_begin` | Office | create-plugin.ts:49 | ✅ 已改 |
| `context_room_write_append` | `document_write_append` | Office | create-plugin.ts:123 | ✅ 已改 |
| `context_room_write_commit` | `document_write_commit` | Office | create-plugin.ts:246 | ✅ 已改 |
| `context_room_write_abort` | `document_write_abort` | Office | create-plugin.ts:319 | ✅ 已改 |
| `context_room_patch_begin` | `document_patch_begin` | Office | review-plugins.ts:438 | ✅ 已改 |
| `context_room_patch_hunk` | `document_patch_hunk` | Office | review-plugins.ts:505 | ✅ 已改 |
| `context_room_patch_commit` | `document_patch_commit` | Office | review-plugins.ts:808 | ✅ 已改 |
| `context_room_patch_abort` | `document_patch_abort` | Office | review-plugins.ts:884 | ✅ 已改 |
| `context_room_office_create` | `office_create` | Office | office-plugin.ts:176 | ✅ 已改 |
| `context_room_slides_create` | `slides_create` | Office | office-plugin.ts:231 | ✅ 已改 |
| `context_room_slides_set_page` | `slides_set_page` | Office | office-plugin.ts:293 | ✅ 已改 |
| `context_room_slides_read` | `slides_read` | Office | office-plugin.ts:437 | ✅ 已改 |
| `context_room_slides_edit` | `slides_edit` | Office | office-plugin.ts `SLIDES_TOOL_NAMES` | ✅ 已改 |
| `context_room_sheets_create` | `sheets_create` | Office | office-plugin.ts:370 | ✅ 已改 |
| `context_room_task_start/read/update/clarify/attach` | — 删除 | Room 任务夹 | task-plugin.ts:213/268/328/386/462 | 待 Phase 2 |

MCP server name 同步由 `everroom-context-room` 改为 `everroom-office`（`mcp-host.ts:348`）。

**连带改名点**：`office-plugin.ts:39-44` 的 `SLIDES_TOOL_NAMES`、`runtime-factory.ts:13,144`、`subagents/slides-agent-tools.ts:5,39`、`pi-tools.ts:59/83/93/98/113`、MCP server name（`mcp-host.ts:348` `everroom-context-room` → `everroom-office`）、`mcp-routes.ts` 路径、i18n 文案、各 agent 的 `SYSTEM.md` 与 `schemas/*.json`。

### P0-4 Agent 运行时工具面重建

**关键事实（已核实）**：`agents/*/agent.yaml` 的 `capabilities` / `tools` 字段只被解析、不参与装配（`modules/agent/builtin-bundles.ts:85-86`），真正决定工具面的是 `modules/agent/runtime-factory.ts:138-172`。**只改 YAML 不会移除能力。**

- `runtime-factory.ts:139` `...(knowledge?.tools ?? [])` → 删除；
- `:153-160` `createDocumentPiToolsWithRoomBindings(mcpHost, routedRoomByRun)` → `createDocumentPiTools(mcpHost)`；
- `:166-172` `resolveKnowledgeWikiIds` / `resolveRoomMemories` / `roomMemorySearch` → 删除；
- `:210-241` `createIngestFilterAgentRuntime` → 删除；
- `createWritingStyleRuntime` / `createIndexBackfillRuntime` → 随记忆/风格画像删除；
- `agents/main/agent.yaml`：删 `:13-16`、`:25-28`、`:29-40`、`:43-53`、`:67`；保留 `:41-42`、`:54-66`、`:68`；
- `agents/main/SYSTEM.md`：改 `:5`、`:6`、`:9`、`:10`、`:14`、`:19`；
- `agents/main-lite/agent.yaml:12-14`、`agents/main-direct/agent.yaml:12-15`：删能力声明；
- `agents/doc-writer`：`SYSTEM.md:15,17`、`schemas/input.schema.json:36-49`、三个 skill 的 SKILL.md；
- `agents/slides-planner/SYSTEM.md:12,20`、`agents/slides-builder/SYSTEM.md:5,7,8,14`；
- 删除 bundle：`agents/{context-room,room-corrector,knowledge,diary,ingest-filter,transcription-summary,route-planner}`；改 `agents/README.md:36`。

---

## 2. Phase 1：断耦合（逐文件 import 替换表）

| 文件 | 现状 | 替换方案 |
|---|---|---|
| `modules/agent/runtime-factory.ts` | 引 knowledge 工具、room 绑定、ingest-filter / writing-style runtime | 按 P0-4 |
| `modules/agent/channel-mcp-host.ts:162` | `knowledgeToolFactory` 注入 | 删除构造参数与调用点 |
| `modules/agent/*` → `diary/agent-generator` | 日记任务生成 | 删除调用点（`agent-scheduler` 保留） |
| `modules/agent/*` → `search/jobs` | 检索索引 | 保留 `search/jobs`，仅删日记/记忆入队 |
| `modules/files/clustering-service.ts:16` | `knowledge/embedding` 图片聚类 | 删除聚类服务 |
| `modules/files/image-describe.ts:3-4,28,47,62-100` | `perception/service` + `reality/insight-tags` | 删除 VLM 描述链路 |
| `modules/files/service.ts:9` | `search/jobs` | 保留 |
| `modules/subagents/tools.ts` → `context-rooms/room-context-digest` | `room_analysis` 材料组装 | 删除 `room_analysis` 与 `resolveRoomContext` |
| `modules/subagents/*` → `perception/vlm-client` | 图片理解 | 删除，图片理解改走 `multimodal-document-parser` |
| `modules/subagents/doc-writer-tools.ts:36`、`slides-agent-tools.ts:150` | `roomTools` 参数 | 删除 |
| `modules/documents/integration-outbox.ts:6,54` | `document.ingest` 作业 | 删除 |
| `modules/documents/capabilities/route-mindmap-plugin.ts` | 写作路线导图 | 按 D2 删除 |
| `submodules/.../gateway-module/manager.ts:10,20-33,207,223-262` | `memorySink` 扇出 | 删除 |
| `submodules/.../gateway-module/connector-memory.ts` | 邮件/日程 → MemoryCore | 整文件删除，改 `README.md:21` |
| `submodules/.../gateway-module/domain-projection.ts:13-21,261-345` | 六张 Room/知识身份表 ref 改写 | 删除该段 |
| `apps/gateway/src/server/connector-identity-rewrite.ts` | 同上逻辑宿主副本 | 整文件删除 |
| `apps/desktop/.../components/agent/agentRoomSelection.ts` | 会话绑定 Room | 删除，并清 `agentRoomCitations` 状态 |
| `apps/desktop/.../components/agent/agentMentions.ts` | @ 提及含 Room | 去掉 Room 提及类型 |
| `apps/desktop/.../components/agent/activeDocumentContext.ts` | 经 Room 取文档上下文 | 改为按当前文稿标签页取 |

---

## 3. `create-server.ts` 装配点删除/改写表

| 行 | 内容 | 动作 |
|---|---|---|
| :91-104、:160-162 | 四个模块 import | 删 |
| :609-614 | `ContextRoomService` + `MemoryService` | 删 |
| :633 | `RoomOverviewService` | 删 |
| :644-656 | 文档创建 / 划词改写 → 记忆捕获 | 删 |
| :730-737 | Room capabilities、room 记忆 provider | 删 |
| :771-834 | `KnowledgeService`、`RoomDuplicateService`、实体认领、记忆晋升 | 删 |
| :859-883 | `createContextRoomAgentTools` × 3 | 删 |
| :974-993 | room-agent dispatcher、总览调度器 | 删 |
| :1012-1042 | selection-rewrite / doc-writer 授权解析 | 去 `roomId`，保留 `document_draft` 授权链 |
| :1057-1069 | `channelRoomTools`、room wiki 解析 | 删，`ChannelMcpHost` 保留文档 capability |
| :1107-1117 | `ScreenMemoryService`、screen memory / room overview 工具 | 删 |
| :1138、:1248-1258 | 子 Agent 的 Room 记忆 / wiki 注入 | 删 |
| :1294 | `contextRoomService` 注入 | 删 |
| :1352、:1397 | knowledge embedding / LLM 热替换 | 删 |
| :1495 | `DataMigrationService(…, memoryService)` | 去掉 `memoryService` 参数 |
| :1561-1589 | 日记的记忆数据源 | 删 |
| :1619 | `knowledgeService.start()` | 删 |

---

## 4. Phase 2：删除顺序（按依赖倒序）

1. **Agent bundle**：`agents/{context-room,room-corrector,knowledge,diary,ingest-filter,transcription-summary,route-planner}`
2. **渲染层**：`components/{context-room 剩余部分,diary,reality,graph,recording,search}`、`components/onboarding/{RoomOnboardingGate,MemoryOnboardingGate,MicrophonePermissionOnboarding,ScreenRecordingPermissionOnboarding}`、`MemoryPipelineStatus.tsx`、`App.tsx` 页面与状态、`data/navigation.ts` 的 `rooms|recording|memory|wiki|diary|inspiration`、i18n、`mock-*` 入口与 vite mock 配置
3. **主进程**：`main/{memory,knowledge,screen-memory,evidence,recording,transcription,obsidian}`、`main/index.ts:360-385,487-500,542+`、`preload/index.ts:436-449,547,675+`、`shared/{memory,knowledge}.ts`
4. **Gateway**：`modules/{context-rooms,memory,knowledge,screen-memory,perception,reality,ingest,materials,clipper,diary,writing-style}`、`modules/files/{clustering-service,image-describe}.ts`
5. **共享包**：`packages/agent-runtime-pi/src/{memory,knowledge}`、`packages/reality-contract`
6. **数据迁移**：新增 drop 迁移（见 §5）

> `modules/search` 只删 Room/证据范围入口，FTS 骨架保留；`modules/files` 保留文件浏览与文档资产。

---

## 5. 数据与配置

**迁移策略**：不改历史迁移，新增 `00XX_drop_memory_and_rooms.sql`：

- drop：`room_doc_links`、`room_folders`、`rooms`、`room_wikis`、`room_memory_*`、`room_merge_*`、`room_duplicate_candidates`、`room_source_memberships`、`room_entity_*`、`room_relations`、`entities`、`entity_doc_links`、`route_mindmaps`、`route_decisions`、`routing_rules`、`knowledge_*`、`diary_*`、`screen_*`、`visual_*`、`reality_events`、`ingest_events`、`clipper_*`、`perception_settings`；
- **保留**：`documents`、`document_*`、`file_*`、`agent_*`、`audit_logs`、`connector_*`、`external_*`、`runtime_config_store`、`gateway_metadata`；
- 迁移前用现有 `data-migrations` 模块导出备份；用户文稿不受影响（`documents` 本体无房间列，仅丢容器归属）。

**配置删除**：`config.ts:108-118`、`:770-814` 的 memory/knowledge 段；`runtime-config.default.json` 的 `memory` / `knowledge` 块；`.env.example:11,78-99`；`apps/desktop/scripts/generate-packaged-env.mjs:7-8`。

**依赖删除**：`@tencentdb-agent-memory/memory-tencentdb-v2`、`@tencentdb-agent-memory/knowledge-service`、`sqlite-vec`（`apps/desktop/package.json:37-38,114-116,129-130`）；`pnpm-workspace.yaml` 的 `allowBuilds`（:23,29,33）与 `patchedDependencies`（:49-50）；`patches/{knowledge-service@0.1.0-everroom.1,memory-tencentdb-v2@2.0.0-beta.1-everroom.8,sqlite-vec@0.1.7-alpha.2}.patch`。改完由 `pnpm install` 重生成 lockfile，不要手改 `pnpm-lock.yaml`。

**CI / 打包校验**：`.github/workflows/{release-desktop,scheduled-desktop-release}.yml` 的 knowledge 变量与 asar 记忆包断言；`apps/desktop/scripts/verify-windows-package.mjs:72-108`。

**测试**：`package.json:10` 去掉 `tests/memory-onboarding.test.ts`；`apps/gateway/package.json:15` 去掉两个 memory e2e；`apps/gateway/tests/{config,server}.test.ts` 的记忆/知识断言；`apps/desktop/tests` 约 40 个 `context-room-*` / `memory-*` / `knowledge-*` / `room-*` 文件。

**文档**：归档 14 篇（`entity-room-plan`、`room-wiki-plan`、`knowledge-room-agent-plan`、`knowledge-organization-iteration-plan`、`room-corrector-plan`、`memory-app-plan`、`memory-md-source-plan`、`pi-agent-memory-plan`、`screen-memory-*`（2）、`unified-ingest-plan`、`ingest-filter-agent-plan`、`reality-wiki-ingest-design`、`graph-rendering-architecture-design`）；改写 `README.md` / `README.zh-CN.md` 定位叙事。

---

## 6. 验证闸门

| 阶段 | 命令 | 通过标准 |
|---|---|---|
| Phase 0 | `tsc --noEmit`（desktop） | 与基线错误集完全一致 |
| Phase 0 | 手动冒烟 | 新建文稿 → Agent 写入 → patch 审阅 → 导出 docx/pptx/xlsx 全通 |
| Phase 1 | `pnpm typecheck` | `rg 'modules/(memory\|knowledge\|context-rooms\|screen-memory\|perception\|reality\|ingest\|diary)' apps packages` 为 0 |
| Phase 2 | `pnpm test` / `pnpm test:ci` | 裁剪后的测试集全绿 |
| Phase 3 | `pnpm package:mac` | 打包成功、asar 断言按新清单通过、启动后无 MemoryCore 子进程 |
| 收尾 | 全量 `rg` | `memory_search`、`wiki_search`、`context_room_`、`MemoryCore`、`TencentDB` 在源码中命中为 0 |

> 环境注记：本机 `pnpm` 需在 Node 22 下运行（`fnm exec --using=22.22.1 pnpm …`），Node 20.19.4 下 corepack 报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`；`electron` postinstall 需联网下载二进制，离线会失败但不影响 typecheck。可直接调用 `node_modules/.pnpm/typescript@5.6.2/.../tsc` 与 `node_modules/.pnpm/vitest@4.1.10_.../vitest.mjs` 绕过 `pnpm` 的预检查。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Office 编辑器搬移导致编辑器回归 | 已完成；typecheck 与测试集与基线一致，后续 `operations/` 迁出单独提交 |
| 文档去 roomId 改变权限语义 | 单独提交；权限从「同房间」改为「单工作区」后原跨房间共享行为消失，需在变更说明中明示 |
| 老用户数据在 drop 迁移中丢失 | 迁移前强制备份 + 只 drop 房间/记忆表，`documents` 与 `file_blobs` 不动 |
| 工具改名破坏已有 Agent 会话/渠道 MCP 客户端 | 改名与删除分两次提交；过渡期在 MCP host 保留旧名别名 |
| 删除面过大难以 review | 按 §4 的 6 步拆 6 个提交，每步独立可编译可测 |

**回滚**：每个提交保持独立可 revert；数据迁移脚本提供 down 版本（重建空表，不恢复数据）。

---

## 8. 执行进展

| 时间 | 阶段 | 内容 | 状态 |
|---|---|---|---|
| 2026-10-23 | P0-1 | Office 编辑器 71 个文件迁至 `components/office-editor/`，改写 44 个文件的引用，旧路径 0 残留 | 完成（typecheck / 测试与基线一致） |
| 2026-10-23 | P0-1 收尾 | `operations/`（18 文件）、`types`、`adapters`、`shared`、`MarkdownBody` 迁出；改写 83 个文件引用 | 完成（office-editor→context-room 反向依赖 12 → 1） |
| 2026-10-23 | P0-1 收尾 | 移除文稿「移动到另一个 Room」入口 | 完成（46 用例全绿） |
| 2026-10-23 | P0-2a | 契约 `RoomDocument.roomId` / `DocumentEvent.roomId` / `AgentActiveDocumentContext.roomId` / `ImportRoomDocumentInput.roomId` 改 `string \| null`；新增 `WORKSPACE_DOCUMENT_CHANNEL`；网关文档内核（repository GET 改 LEFT JOIN、list(null) 全工作区、无归属不再写 `room_doc_links`、content-engine/event-broker/lifecycle/service/commit 全链路接受 null、新增 `room-scope.ts` 归一旧管线 scope） | 完成（tsc 与基线一致；document-* 329 用例全绿） |
| 2026-10-23 | P0-2b | 桌面主进程桥接与 preload：`list/listTrash/emptyTrash` 支持空 roomId，`subscribe` 落到工作区频道；回收站路由与渲染层空归属适配 | 完成（tsc 与基线一致；bridge 新增 2 用例） |
| — | P0-2c | 渲染层：`RoomDocumentsProvider` → 工作区文稿库 Provider，`DocsPage` 改为唯一文稿入口 | 未开始 |
| — | P0-3 | 25 个工具改名 | 未开始 |
| — | P0-4 | Agent 运行时工具面重建 | 未开始 |
| — | Phase 1 | 断耦合 | 未开始 |
| — | Phase 2 | 删除模块 | 未开始 |
| — | Phase 3 | 外围清理 | 未开始 |