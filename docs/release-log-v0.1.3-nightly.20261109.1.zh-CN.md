# EverOffice 发版日志 · 0.1.3-nightly.20261109.1

| 项目 | 内容 |
| --- | --- |
| 版本 | `0.1.3-nightly.20261109.1`（nightly 预发布） |
| 发布时间 | 2026-11-09 22:51（UTC+8） |
| 上一版本 | `0.1.2`（2026-11-06 23:55） |
| 变更范围 | `desktop-v0.1.2` → `desktop-v0.1.3-nightly.20261109.1` |
| 变更规模 | 25 个提交 / 4 个 PR / 95 个文件（+2821 / −2585） |
| 对比链接 | https://github.com/NxcoreAI/EverOffice/compare/desktop-v0.1.2...desktop-v0.1.3-nightly.20261109.1 |
| 贡献者 | @lzp-plus、@ultralan、@21335464876、@zengjiayi819 |

**一句话总结**：本版把「新建项目空间」从「表单 + 三步引导」收成一步选目录即建，给 Agent 的长回答加了「查看详情」分层，重做了对话底栏的模型选择器，并补齐微信支付、技能 zip 导入、`.doc` 预览兜底等能力，同时修掉决策卡确认失效、模版预览标签点不动等一批阻塞问题。

---

## 一、本版亮点

1. **新建项目空间一步完成**：点「新建」直接弹系统目录选择器，选完即建；已是空间目录时自动转为「打开 / 接管」，原来的表单弹窗与三步引导整体下线。
2. **Agent 回答分层**：模型答复中的长篇细节默认折叠，气泡内出现「查看详情」，正文只留结论，长任务不再刷屏。
3. **对话底栏改版**：换成「模型 + 推理等级」两级模型选择器（DSH 式），选项行去掉小字说明与装饰图标，底栏更紧凑。
4. **充值支持微信支付**：充值弹窗顶部可切「PayPal / 微信支付」，微信渠道在弹窗内直接展示二维码扫码，不再跳出浏览器。
5. **本地文档能力补强**：macOS 未装 LibreOffice 时 `.doc` 走系统 `textutil` 兜底预览（论文模版卡恢复版式事实）；嵌入态编辑器新增 AI 快捷指令条（排版 / 润色 / 总结）。

---

## 二、新增与升级

### 2.1 工作台 / 项目空间

- **一步式新建项目空间**：新增 `useCreateSpaceFlow`（`workspace/createSpace.ts`），目录名即空间名；网关补齐 `space_path_taken` / `space_already_registered` / `space_marker_invalid` / `space_marker_unsupported` 错误映射，目录冲突返回 409 与可读中文提示，系统级目录错误（EACCES / EPERM / EROFS / ENOSPC）转 400 可读文案。移除 `CreateWorkspaceDialog`、`SetupWizard`、`setupData` 与 `pendingSetupWorkspaceId` 状态。
- **首页视觉精简**：侧栏品牌区去掉「Agent 工作台」小字、Logo 与标题放大；最近页去掉「N 个项目空间 · N 个文件」整行副标题；今日洞察卡去掉「基于 N 条记忆 · 更新于 HH:MM」；新建区合并为单行五瓦片（空白空间换成青绿渐变 squircle 图标，今日洞察改香槟暖色）；最近区去掉两个「全部」链接，「项目空间」标签可点击跳转，空间行去掉「刚刚 · N 项工作 · 描述」副行，两栏卡片等高对齐。
- **标签栏微调**：macOS 侧栏开关与红绿灯纵向对齐；空间标签定宽 148px，改名 / 切换布局不抖，过长自动省略。
- **界面文案逐项清理**：去掉连接器页副标题、设置·外观描述与「文档画布始终保持浅色」附注、设置·账号与同步的设备数提示与设备行小字、设置·软件更新的副标题 / 更新渠道 / 安装标识三处小字、项目空间新增卡副标题；「所有文件」行菜单移除「用原应用打开」，「导出定位」更名为「文件位置」；设置·模型与 Agent 的 MCP 空态、配置路径条间距与长路径断行修正。

### 2.2 Agent 对话

- **回答分层（`[[details]]` 协议）**：网关 `splitAgentAnswer` 统一解析标记：落库 `content` 存去标记全文，命中时 `displayContent` 只存默认展示层，事件流同步携带；`AgentAnswerDetails` 提供「查看详情」折叠。无标记（旧输出 / 短答复）不加字段，旧客户端与云端回看零影响；气泡侧对 `displayContent` 与 `content` 做前缀校验，校验失败保守退化整段展示，绝不丢内容；SaaS 上行继续剥离 `displayContent`。顺带补充 Markdown 的 GFM 任务列表与删除线只读样式。
- **Composer 底栏改版**：两级模型选择器，触发钮显示「模型名 + 推理等级弱化后缀」，root 面板提供「模型 / 推理等级」两行入口，子面板各自单选；原独立思考档位钮并入推理等级行。选项行统一为单行主文案，删除 9 组 hint 小字与装饰图标（渠道行保留品牌 logo / Terminal 作为身份标识）。移除会话「权限模式」四档选择（`permissionMode` props 与 i18n 全链路）与「连接器」弹窗入口（`ConnectorsDialog` 及其测试），底栏只留「+」与模型选择器。
- **主 Agent 指令精简**：`SYSTEM.md` 重写，路由表改为裁决规则；输出格式新增「六句上限」与 `[[details]]` 长答复分级纪律，工具执行期间不输出正文；office-plugin 生成类工具提示词同步收敛，文件名一句带过。

### 2.3 文档与 Office 能力

- **genoffice 子模块升级**（`18a0ea4` → `97225d1`）：新增 `EditorModeBar` AI 快捷能力——嵌入态整文档指令（排版 / 润色 / 总结）经 `agentAsk(scope: document/workbook)` 转发宿主 Agent。该指针同时把此前被 PR #13 挤掉的浮动论文排版面板合回，保证两项能力同时在位。
- **`.doc` 旧格式预览兜底**：LibreOffice 不可用时，macOS 用 `/usr/bin/textutil` 把 `.doc` 转 `docx` 预览（表格等复杂结构可能被简化，`soffice` 可用时仍优先 `soffice`）；仍无法转换时不再静默交给外部应用，而是向渲染端如实返回「不支持预览」。
- **模版预览标签点不动修复**：`NativeEditorHost` 对在途 `openOriginal` 的 promise 增加等待与激活重试，修复「激活一次错过、原生视图永远隐藏」的锁死问题；同时新增 `native-editor-host` 渲染端诊断日志，便于后续定位同类渲染端锁死。

### 2.4 技能

- **技能导入支持 zip**：点「新增技能」直接弹系统选择器，文件夹与 `.zip` 压缩包都能选；网关用 jszip 解压，兼容「压缩包根 / 单层包裹」两种形态，条目路径做穿越与边界校验，新增 `skill_archive_invalid` 错误码；`SKILL.md` 存在性校验与文件夹导入保持一致。

### 2.5 账号与支付

- **微信支付充值渠道**：`TopupModal` 顶部新增「PayPal | 微信支付」分段控件，切渠道重置购买现场；微信渠道档位卡片显示 ¥ 人民币价（`amountCnyCents/100`），下单透传 `wechatpay`，`code_url`（`weixin://`）不打开浏览器，改为弹窗内渲染 180px 二维码 + 扫码提示，复用 2s 轮询到账；取消按钮回到档位选择；PayPal 渠道不传 `channel`，行为与现状完全一致。透传链覆盖 preload → main handler → `saas-client.createTopup`。

---

## 三、问题修复

- **Agent 决策卡「确认」失效**：打包版点确认返回 404。网关 resolve 路由改为决策卡优先且与 `choice` 解耦——旧客户端只回传 `decision` 不带 `choice` 时也能落到卡片回填；`AgentDecisionCard` 的确认 / 取消同步回传 `choice` 与 `text`。
- **合并后 Agent 执行异常**：修复交互卡工具与路由合并后 Agent 任务卡住 / 无法继续执行的问题。
- **非默认空间拖入附件后 Agent 找不到文件**：`importAgentAttachments` / `pickAgentAttachments` 增加 `workspaceId` 透传，附件落入当前会话空间的资料库（此前一律落 `default`，非默认空间下 `file_search` / `library_browse` 查不到）。
- **决策卡色板被滤空**：`agent_confirm` 的 palette 解析放宽为宽容归一——兼容不带 `#` 的裸 hex 与「海军蓝 #0E1B2A」这类带名称写法（此前只认严格 `#rrggbb`，实测出现 `palette: []`）。
- **界面文案资源（i18n）修复**：补回遗漏文案键、修正表面文案 JSON 问题（`answerDetailsToggle` 等），避免部分界面显示原始 key 或文案缺失。
- **论文模版预览相关修复**：`thesis-format/normalize` 调整让模版卡能带 OOXML 版式事实（`.doc` 经 `textutil` 转换后也能出卡，优于「只能按内容重建」）；补 `.doc` 模版归一化兜底与真实用户模版回归测试。

---

## 四、行为变更与兼容性（老用户需注意）

| 变更 | 影响 | 兼容性 |
| --- | --- | --- |
| 新建空间改为「选目录即建」 | 不再出现表单弹窗与三步引导 | 纯 UI / 流程变化，无数据迁移；已建空间不受影响 |
| Composer 下线「权限模式」四档与「连接器」入口 | 底栏只剩「+」与模型选择器 | 已有会话沿用已存权限模式；默认权限策略不变 |
| 回答分层 `[[details]]` | 长答复默认折叠、可展开 | 增量协议：无标记不加字段，旧客户端 / 云端回看仍整段展示 |
| 若干入口与文案精简 | 「用原应用打开」下线、「导出定位」→「文件位置」、多处小字副标题删除 | 纯前端展示变化 |
| 技能导入方式 | 「新增技能」直接弹系统选择器，支持 zip | 文件夹导入路径与 SKILL.md 校验规则不变 |

---

## 五、工程与内部改进

- 版本号 `0.1.2` → `0.1.3`（根、`apps/desktop`、`apps/gateway` 三处同步）。
- 新增 / 扩充测试：回答分层（gateway `agent-answer-tiering.test.ts`）、Agent 详情折叠、Markdown 渲染、原生编辑器宿主激活（`native-editor-host-activate.test.tsx`）、`.doc` 旧格式转换（含真实文件用例）、`textutil` 兜底、一步式建空间（`createSpace.test.ts`）、工作区附件归属、充值面板微信扫码与取消用例。
- 删除死代码与孤儿测试：`CreateWorkspaceDialog`、`SetupWizard`、`setupData`、`tools.css`、`ConnectorsDialog`、`workbench-conversation-connectors.test.tsx` 等。
- `.gitignore` 增加 `.tmp-output-analysis/` 与一批原型探索半成品目录，避免缺兄弟依赖的拷贝文件弄红 typecheck / 测试。
- 诊断可观测性：`app:log-renderer-diagnostic` 白名单新增 `native-editor-host`。

---

## 六、发布产物与升级

| 平台 | 产物 |
| --- | --- |
| macOS（Apple Silicon） | `EverOffice-0.1.3-nightly.20261109.1-arm64.dmg` / `.zip` / `.zip.blockmap` |
| Windows x64 | `EverOffice-0.1.3-nightly.20261109.1-windows-x64.exe` / `.exe.blockmap` |

- macOS 构建已签名并公证；Windows 构建未签名，Microsoft Defender SmartScreen 首次启动可能提示。
- 已安装旧版客户端的用户可通过 `electron-updater` 差量更新（blockmap 已随包分发）。
- 完整发布页：https://github.com/NxcoreAI/EverOffice/releases/tag/desktop-v0.1.3-nightly.20261109.1

---

## 七、已知问题 / 待跟进

- 两个**合并前既有的**测试红点随本版进入 main，不影响发版功能：
  1. `apps/gateway/tests/skills.test.ts` 期望 `skillPrompts` 仅含 `document-export`，但 `agents/main/skills/pptx` 自 11-05 起已在树上；
  2. `apps/desktop/tests/ai-panel-thesis.test.ts` 期望 genoffice `AiTab.tsx` 含 `unsupported_format` / `aiThesisPreviewUnsupported` 文案，对应实现尚未推送到 genoffice 远端。
- 需上游补齐 genoffice 提交或修正断言后转绿。

---

## 附：本版 PR 清单

| PR | 内容 | 作者 |
| --- | --- | --- |
| [#13](https://github.com/NxcoreAI/EverOffice/pull/13) | 一步式建空间 + Agent 回答分层 + Composer 底栏改版（DSH 式模型选择器） | @lzp-plus |
| [#15](https://github.com/NxcoreAI/EverOffice/pull/15) | 合并 `fix/agent-file-open-loop` 新提交（zip 技能导入、首页视觉精简、`.doc` 兜底）+ genoffice 指针（浮动论文排版面板） | @lzp-plus |
| [#16](https://github.com/NxcoreAI/EverOffice/pull/16) | 标题为 `Feat/ppt`，实际内容：决策卡确认修复、色板 hex 宽容解析、i18n 修复、版本号 0.1.3 | @21335464876 |
| [#14](https://github.com/NxcoreAI/EverOffice/pull/14) | 充值弹窗微信支付渠道（分段控件 + `code_url` 弹窗内扫码） | @ultralan |

**关键提交**：`ce56f8a4` 一步式建空间 · `151fc439` 回答分层 · `aa0a99bb` Composer 改版 · `bb46a68b` 附件归属 · `ec80d712` 文案清理 + zip 技能导入 + `.doc` 兜底 · `fdaab88b` 首页视觉精简 · `5575aa54` genoffice 升级 · `3e68e61d` 决策卡确认 · `65040695` 合并后 Agent 执行 · `cb9bdf45` i18n 修复 · `e202f161` 微信支付 · `f5a466fe` 标签栏微调。
