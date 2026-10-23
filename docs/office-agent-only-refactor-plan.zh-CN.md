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
| `context_room_list` | — 删除 | Room | query-plugin | ✅ 已删（Phase 2d-3） |
| `context_room_create` | — 删除 | Room | query-plugin | ✅ 已删（Phase 2d-3） |
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
| `context_room_task_start/read/update/clarify/attach` | — 删除 | Room 任务夹 | task-plugin.ts | ✅ 已删（Phase 2d-3） |

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
| 2026-10-23 | P0-2c | 渲染层 `RoomDocumentsProvider` → 工作区文稿库 Provider、`DocsPage` 去 Room 维度 | **改并入 Phase 2**：渲染层的文档 tab / 文稿页 / 产物库都以 `roomId` 为键，只有在删除 Room 时才能一次性收敛，单独改造反而要写两遍（决策记录见 §8.1） |
| 2026-10-23 | P0-3 | 18 个 Office 工具改名（`document_*` / `office_create` / `slides_*` / `sheets_create`），MCP server 名改 `everroom-office`，跨 50 文件 | 完成（gateway 测试回到基线；desktop 失败清单与基线逐行一致） |
| 2026-10-23 | P0-4 | Agent 工具面重建：运行时去掉 run 级 Room 粘滞与 knowledge/记忆注入，用户档剔除 `context_room_*` 工具；main/main-lite/main-direct/doc-writer/slides-planner 的能力声明、工具清单与人设去 Room/记忆 | 完成（gateway 套件维持基线 10 个失败） |
| 2026-10-23 | P0-2d | `document_operations.room_id` 放开为可空（迁移 0083，重建表并保全四张子表数据）；操作类型/读凭证/授权判定全链路可空；document.* 能力 manifest `requiresRoom=false`；摘除写入工具的 Room 守卫并去掉 `patch_begin` 记忆清单注入 | 完成（gateway tsc 干净、套件维持基线 10 个失败；新增工作区级端到端与升级路径回归用例各 1） |
| 2026-10-23 | Phase 1a | 断耦合（迁出 + 调度器）：`perception/vlm-client` + `reality/insight-tags` 迁至 `modules/vision/`（20 个引用点）；`diary` 运行时工厂从 `modules/agent` 挪进 `modules/diary`；时区换算迁至 `infrastructure/time/zone-time`；`agent-scheduler` 移除 `diary.daily` 内置槽位与 DiaryService 依赖（routes 死分支、schema 注释同步清理；create/update 时钟与 tick 统一） | 完成（gateway tsc 干净；全量套件 10 个失败 = 基线：190 文件 / 1963 用例） |
| 2026-10-23 | Phase 1b | 断耦合（聚类 + Room 材料）：删除 `files/clustering-service.ts`（图片聚类/embedding）与 `PATCH /v1/file-clusters/:id`、`FilesService.versionClassifier` 钩子及 create-server 装配；删除子 Agent 工具 `room_analysis` 与 `resolveRoomContext` 选项（保留纯投喂的 `content_analysis`） | 完成（tsc 干净；`subagent-tools` 48 / `room-context-digest` 8 全绿；`file-catalog` 仅基线 1 失败） |
| 2026-10-23 | Phase 1c | 断耦合（图片描述 + 连接级联）：删除 `files/image-describe.ts` 与 VLM 描述链路（ingest 改为图片占位 markdown，图片仍是一等格式）；`connection-purge` 去掉 memory/knowledge 两步清理与 `memoryDeleted` | 完成（tsc 干净；全量套件 10 个失败 = 基线：189 文件 / 1955 用例） |
| 2026-10-23 | Phase 1d | `data-migrations` 去 `memoryService`：`JobType` 只剩 `source_gc`、幂等门简化为内容 hash、删除 `indexMemory`/`afterJob`/记忆检索补全/GC 记忆清理，导入后运行直接完成（`phase` 由 `memory` 改 `finalizing`） | 完成（tsc 干净；套件维持基线 10 个失败；两个迁移测试文件 10 用例全绿，重启恢复用例改为真实崩溃路径） |
| 2026-10-23 | Phase 1e | 补最后一条静态边：`documents/core/{commit-service,lifecycle-service}` 不再 `enqueueWritingStyleExtract`（提交/回收站/恢复/清空共 6 处）——此前扫描漏了 `writing-style`，它是唯一「存活 → 将删」的遗漏模块；`doc-writer` 的风格注入为结构化 provider，无静态依赖 | 完成（tsc 干净；`document-*` 87 用例全绿；套件维持基线 10 个失败） |
| 2026-10-23 | Phase 1 闸门 | 网关「存活模块 → 将删模块」反向依赖 **18 → 0**（`data-migrations` 是最后一个）。剩余命中全部属于 Phase 2 范围：`create-server.ts` 40 处装配（§3 表逐行处理）+ 桌面 3 个自身即将删除的文件（`main/knowledge/llm-env.ts`、`shared/knowledge.ts`、`main/screenshot/window-screenshot-service.ts`，依赖方向均为将删→将删） | Phase 1 完成 |
| 2026-10-23 | Phase 2a | 连接器子包去记忆扇出：`submodules/everroom-connectors/gateway-module` 删除 `memorySink`/`projectedRowIds` 与 `connector-memory.ts`，`domain-projection.ts` 只剩域投影（去掉 `IdentityRewriteSummary`/`IDENTITY_TABLES`/`rewriteConnectorRefIdentities`），收敛出自有 `errors.ts`（`IngestError`/`ConnectorConvertErrorCode`），`ports.ts` 不再转出宿主 `IngestService`；同时删掉网关侧死代码 `server/connector-identity-rewrite.ts` | 完成（子包 tsc 维持基线 202 错、6 文件 28 用例全绿；网关 tsc 干净） |
| 2026-10-23 | Phase 2b-1 | 把文稿历史回填 worker 从 `modules/ingest/document-history-backfill-worker.ts` 迁到 `modules/documents/index-backfill/history-worker.ts`——它是 Yjs 版本快照能力，属 Office，不能随理解引擎一起删 | 完成（tsc 干净；`document-core`/`documents` 套件维持基线） |
| 2026-10-23 | Phase 2b-2 | 停掉文稿出队到统一理解引擎：删 `documents/integration-outbox.ts` 的 `document.ingest`/`document.delete` 作业与契约、`core/{commit-service,lifecycle-service}` 的 `enqueueDocumentIngest`/`enqueueDocumentDelete`、`files/service` 的 `VersionIngestResult.ingestEventId`（改 `{ parsedId, dataType }` + `touchVersionParsed`） | 完成（tsc 干净；`documents`/`document-core`/`files-*` 用例改断言「不再有 ingest 作业」后全绿） |
| 2026-10-23 | Phase 2b-3 | 删除统一理解引擎与网页剪藏：`modules/ingest/`（24 文件）、`modules/clipper/`、`apps/gateway/ingest-policy-defaults.json`、`agents/ingest-filter/`，连带 6 个专属测试。跨边界断点就地补齐：`knowledge/service` 内联 `truncateUtf8`、子包 `converters.ts` 改用自有 `errors.js`、删 `tests/memory-office-pdf-pipeline.test.ts` | 完成（tsc 干净；套件 9 个失败 = 基线：`file-catalog` 与 `sync-providers` 保留，`ingest-pipeline` 随用例删除） |
| 2026-10-23 | Phase 2c | 素材检索退役、图片对象库并入 slides-style：`modules/materials` 里只有「关键词检索截图/剪藏/文档图」该删，「按内容哈希存/取图片字节」是 Office 配图链路，迁为 `modules/slides-style/{image-store,image-routes}.ts`（`SlideImageStore`），`GET /v1/materials/:hash` 路径保持不变以兼容桌面 `everroom-material://` 回源器与已存 deck 引用；`slides-agent-tools` 去掉 `materialSearchTools` 与 `SLIDES_PLANNER_MATERIAL_TOOL_ALLOWLIST` | 完成（tsc 干净；`slides-agent-tools` 14 用例全绿，`slides-reviewer` 1 个为既有基线失败） |
| 2026-10-23 | Phase 2d-1 | 删除写作风格提炼 `modules/writing-style/*` 及 5 个测试；`create-server` 去掉服务/路由/worker/runtime 热替换与 `doc-writer` 两处 `writingStyleProvider` 注入；`subagents/{tools,doc-writer-dispatcher}` 去掉风格注入依赖；`agent-access` 的 `everroom_get_rules` 不再返回 `writing_style`。原 `createWritingStyleRuntime` 兼职文档版本摘要，改名 `createVersionSummaryRuntime`（独立 `version-summary` 会话目录）保留该 Office 能力 | 完成（tsc 干净；`document-draft-tool` 改断言不再注入 `writingStyle`；套件 9 个基线失败） |
| 2026-10-23 | Phase 2d-2 | 删除三个互相缠绕的网关模块：`modules/knowledge`（21 文件）、`modules/context-rooms`（11 文件）、`modules/memory`（4 文件）与 bundle `agents/{context-room,room-corrector,knowledge,route-planner}`、`modules/demo/context-room-demo.ts`、`documents/capabilities/route-mindmap-plugin.ts`；`create-server` 摘掉三模块全部路由/服务/定时器/事件钩子/MCP 宿主与工具注入；`FileDeletionHooks` 与 `RoomEntrySink` 及全部 call site 删除（`FileDeletionResult` 收敛为 `{fileId, blobCollected}`）；agent-access 去掉 memory 依赖与 memory/knowledge 规则条目；`BUILTIN_AGENT_IDS.knowledge` 与 knowledge agent 工厂删除。删 33 个测试文件、改写 9 个（-33810 行） | 完成（tsc 0 错误；套件 8 个失败 = 基线：143 文件 / 1442 用例） |
| 2026-10-23 | Phase 2d-3 | 摘除 Room 工具面与任务夹孤儿（Office/Agent 侧）：删除 `context_room_list` / `context_room_create`（query-plugin）与 `context_room_task_start/read/update/clarify/attach` 及其全部注册链（`capabilities/task-plugin.ts`、`documents/task-folders.ts`、`builtins.ts` 的 `taskFolders`/`issueTaskClarify` 参数、`/v1/documents/folders` 路由与 create-server 装配、`AgentService.issueTaskClarification`）；删除 `import/room-classifier.ts` 与其测试；删除 `subagents/tools.ts` 的 `room_correction_draft` 分支及 `resolveRoomCorrectionContext`/`resolveRoomMemoryItems`/`roomExists` 选项与 `roomTools` 管线，`mcp-host.roomExists()`、`runtime-factory` 的 `^context_room_` 前缀过滤、agent service 的 Room 总览/引用纠正 prompt 与 `attachRoomSelectionIntent` 一并摘除；`document_write_begin` 等描述与 `doc-writer` schema/skill 改为工作区文稿库与纯文档来源标记话术 | 完成（gateway tsc 0 错误；套件 8 个失败 = 基线） |
| — | Phase 2 | 删除模块 | 未开始 |
| — | Phase 3 | 外围清理 | 未开始 |

### 8.1 决策记录

- **P0-2d 新增（2026-10-23，本轮发现）**：`document_operations.room_id` 仍是
  `NOT NULL`（`drizzle/0011_flippant_killmonger.sql:51`），因此 Agent 的
  `document_write_begin → commit` 写入路径**仍必须绑定 Room**：`create-plugin.ts`
  的 `roomId: context.roomId!` 与 `ROOM_SELECTION_REQUIRED` 守卫、`patch_begin`
  的同类守卫都源于此。在 operations 表放开归属之前，把 Office 工具描述里的
  Room 话术改掉会造成"文档说支持工作区文档、运行时却报 ROOM_SELECTION_REQUIRED"
  的矛盾，故新增 P0-2d：迁移 `document_operations.room_id` 为可空（SQLite 需重建表）、
  `CreateDocumentOperationInput.roomId` 改 `string | null`、操作仓储按 `roomScopeId`
  分键，然后才摘除各写入工具的 Room 守卫并重写工具描述。
- **`context_room_*` 工具的删除时机（2026-10-23）**：P0-4 起用户档 runtime 已不把它们
  交给模型，但文档 MCP host 仍注册这些工具供 Room 界面与 context-room 子 Agent 使用；
  注册表层的删除随 Phase 2 的模块删除一起做。


- **P0-2c 并入 Phase 2（2026-10-23）**：渲染层的文稿标签页、`DocsPage` 列表、Room 产物库
  都以 `roomId` 作为键与分组维度（`ActiveDocumentDescriptor`、`openDocuments[{roomId, documentId}]`、
  `useRoomAgentFiles(roomIds)`）。在 Room 仍然存在时引入"工作区文稿库"会同时维护两套分组语义，
  并在 Phase 2 删除 Room 时再改一遍；因此 P0-2 的渲染层部分随"删除 Room"一起做：
  届时标签页改为 `documentId` 单键、`DocsPage` 直接消费工作区列表（网关与主进程的
  工作区级读取链路已在 P0-2a/P0-2b 就位，可直接使用）。
- **P0-3 保留 Room 工具不删（2026-10-23）**：`context_room_list/create/task_*` 仍被 Room
  agent bundle 引用，提前删除只会把 Phase 2 的删除面提前到 Phase 0；故 P0-3 只做 Office 侧改名，
  Room 工具的删除与 `document_write_*` 等描述里残留的 Room/记忆话术在 P0-4 与 Phase 2 处理。