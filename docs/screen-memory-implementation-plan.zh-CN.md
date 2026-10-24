# 屏幕记忆（PRD 6.9）实施拆解

> **已废弃（Phase 2/3 已移除）**：本地屏幕记忆（PRD 6.9）已在 Office + Agent 收敛重构（Phase 2/3）中整体移除；本文记录的是移除前的设计，仅作历史留存，不代表现行架构。现行范围见 `docs/office-agent-only-refactor-plan.zh-CN.md`。

日期：2026-10-12
前置文档：docs/screen-memory-prd-deviation.zh-CN.md（PRD 偏差说明，待产品确认）
状态：P0–P6 代码全部落地（2026-10-12），单测 42 项全绿；待真机回归（另一会话占用 dev 环境，浏览器/UI 实弹与断网四项验收清单待跑）

## 零、定案速查（本次会话已拍板，不再重议）

1. OCR：Apple Vision，Swift 助手二进制侧车形态，extraResources 内置。PoC 已实测：0.7s/113MB@生产规格，准确率 99%+。
2. 摘要：远程中转 LLM（纯文本），三重保护：每日调用上限、仅空闲时段、断网/额度尽降级显示等待。无本地模型。
3. 存储：消费后压缩（长边 1600px JPEG q55，实测可读性 99.2%），全部永久保留，无删除策略，设置页仅显示占用。
4. 去重：文本差异为主判据（行级相似度 ≥0.9，忽略时间戳样式行），dHash 降级为辅助（自适应心跳 + 时序记录）。OCR 每拍必跑。
5. 采集：自适应心跳（基础 30–60s，无变化拉长至 300s，变化/系统事件复位）。
6. 应用识别：采集时系统窗口元数据（bundle ID + 窗口标题），不做图像识别。
7. VLM：默认零调用，仅「按需视觉增强」时使用。
8. 四层数据去向：原始层（全量可搜）→ 日记层（应用会话聚合）→ 记忆层（新颖度精选）→ Room 层（手动）。

## 一、阶段总览与依赖

```
P0 Swift 助手 ──→ P1 采集层 ──→ P2 本地处理管线 ──→ P3 摘要层（可与 P4 并行）
                                        └──────→ P4 检索与 UI ──→ P5 融入层 ──→ P6 补处理与收尾
```

| 阶段 | 内容 | 工作量估算 | 可独立验证 |
|---|---|---|---|
| P0 | Vision 助手工程化 | 1–2 天 | 是 |
| P1 | 跨应用采集+系统事件+权限 | 3–5 天 | 是 |
| P2 | 本地识别/聚合/压缩/落库 | 4–6 天 | 是 |
| P3 | 远程摘要+三重保护 | 2–3 天 | 是 |
| P4 | 检索 API+活动卡 UI+设置 | 4–6 天 | 是 |
| P5 | 日记/记忆/Room/Agent 融入 | 3–4 天 | 部分 |
| P6 | 历史补处理+设备适配+收尾 | 2–3 天 | 是 |

单人全链路约 3–4 周。P0+P1+P2 构成最小可演示闭环（断网采集+落库）。

## 二、P0：Vision 助手工程化

基于 /tmp/vision-ocr-poc PoC 升级（PoC 数据见记忆 everroom-screen-memory-vision-ocr）。

1. 源码落位 `apps/desktop/vendor/vision-ocr/`（或 scripts/，随现有 vendor 惯例）。
2. 功能升级：
   - 双模式：单次（argv 传图）+ 常驻（stdin 逐行收图路径，stdout 逐行回 JSON，会话期间不退出）。
   - OCR 输出：行文本、归一化位置框、置信度。
   - 消费后压缩：识别完成同进程重编码长边 1600px JPEG q55，输出压缩路径；原始图由调用方删除。
   - `frontmost` 子命令：返回前台应用 bundle ID + 窗口标题（NSWorkspace），供 P1 轮询。
3. 构建脚本 `scripts/build-vision-ocr.sh`：swiftc -O，`-arch arm64 -arch x86_64` 出通用二进制，产物进 `build/vision-ocr/`。
4. 打包：electron-builder extraResources 加一段（照抄 lark-cli 条目）；签名随主 app 自动覆盖。
5. 桌面封装：主进程 wrapper（复用 index.ts:1732 区域 vendored 二进制查找模式）——拉起、健康检查、崩溃重启、JSON 契约解析。
6. 测试：JSON 契约单测 + 真图金样本回归（PoC 的测试图与结果直接转为测试资产）。

验收：真机跑通「spawn → 喂图 → 收 JSON+压缩图 → frontmost 查询」。

## 三、P1：采集层

1. 新建 `screen-capture-service.ts`（主进程）：
   - desktopCapturer 整屏采集（MVP 只采主屏，多屏列后续版本）。
   - 屏幕录制权限：`systemPreferences.getMediaAccessStatus('screen')` 检测；未授权时设置页给引导入口（复用现有 openExternal 跳系统设置的模式）。
2. 系统事件四触发器：
   - powerMonitor：suspend/resume/lock-screen/unlock-screen（Electron 内置，全仓库首次引入）。
   - 空闲：`powerMonitor.getSystemIdleTime()` 轮询，连续 5 分钟结束区间。
   - 应用切换：心跳时经助手 frontmost 命令取前台应用，变化即结束区间。
3. 应用授权模型：扩展 `PerceptionSettings`（apps/desktop/src/shared/sources.ts）：`screenMemory: { enabled, allowedApps, excludedApps, paused }`。采集前按前台应用过滤；排除应用在采集层拦截，数据不落任何层。
4. 自适应心跳调度器：新写，不复用旧固定间隔调度器（旧 window-screenshot-service 保持原样服务原功能）。dHash 复用 `calculateDHash`。
5. 候选帧策略：每拍采集→算哈希→交 P2 判定（文本差异）。

验收：开启后，授权应用的前台内容按心跳采集；切应用/锁屏/休眠/空闲 5 分钟正确断区间；排除应用零采集。

## 四、P2：本地处理管线（核心）

架构原则：桌面主进程负责采集与助手调度；识别结果、区间数据、检索落本地网关 SQLite（better-sqlite3 已内置），复用 supervisor 回环通道。断网全链路可用。

1. 网关新模块 `screen-memory`：
   - 表：`screen_intervals`（startAt/endAt/app/bundleId/windowTitle/title/textUnion/status）、`screen_keyframes`（intervalId/capturedAt/textLines JSON/boxes JSON/perceptualHash/compressedImagePath）。
   - capturedAt 一律取采集时刻，后续任何处理不改写（验收要求）。
2. 文本差异判定（去重主判据）：
   - 行归一化后与上一关键帧比对：行级相似度 ≥0.9 视为同行；时间戳样式行（正则）忽略。
   - 文本无变化 → 丢帧（仅更新区间 endAt）；有变化 → 新关键帧，压缩图落盘 `userData/screen-memory/images/YYYY-MM/`，文本并入区间 textUnion。
3. 区间状态机：首帧开区间；四触发器关区间；关区间时选代表帧（文本量最大帧）、生成 title（窗口标题+首行大字规则）。
4. 轻量整理（纯规则，零模型）：行合并去重、空白清理、标题提取。
5. 存储统计 API：图片目录体积合计，供设置页显示。

验收：断网跑 8 小时真实使用，区间/关键帧/文本落库正确；看视频场景 0 新增关键帧；滚屏场景每屏一帧；单字变化被捕获（微小关键文字变化验收项）。

## 五、P3：摘要层

1. 摘要任务表 + 调度（照抄 visualProcessingJobs 的 lease+指数退避模式，并发 1–2）：区间关闭后入队。
2. 调用现有中转 LLM 通道，纯文本 prompt（textUnion 截断 + 应用 + 标题），输出摘要与要点。
3. 三重保护：
   - 每日调用计数上限（默认 50，常量表），超限任务顺延次日。
   - 仅空闲派发：getSystemIdleTime > 60s。
   - 失败/断网/额度尽：卡片状态置 waiting，恢复后自动重试。
4. 卡片状态机：processing → ready / waiting。

验收：有网空闲时摘要自动补齐；断网期间卡片显示等待、恢复后补齐；单日调用不超过上限。

## 六、P4：检索与 UI

1. 检索 API（网关）：关键词子串匹配 + 应用/日期过滤（十万行级子串扫百毫秒级，FTS5 分词留作量大后优化）。
2. RealityPage 扩展：
   - 顶部搜索框 + 筛选（应用、日期范围）。
   - 活动卡列表：观察起止时间、应用、页面标题、原文片段、摘要、处理状态。
   - 卡片动作：打开原图（关键词位置框高亮——Vision boxes 兑现「原图定位及引用」）、纠正（弹层改文本，写回并标记用户编辑）、加入 Room、交给 Agent。
3. 设置页（现实感知区扩展）：屏幕记忆开关、应用授权/排除管理、实际覆盖范围清单（授权且当前可采的应用）、存储占用数字、屏幕录制权限状态与引导。
   - UI 纪律：无占位禁用项、无功能说明小字（全局规范）。
4. 原图查看器：复用现有图片查看组件，叠加高亮框图层。

验收：搜索「三天前看过的一句话」命中卡片，点开原图并高亮；纠正后文本更新；状态筛选可见 waiting 卡。

## 七、P5：融入层

1. 日记：区间按应用会话聚合（同应用连续区间合并为一条会话事件，如「14:02–15:31 Safari · 12 个片段」），经 markDiaryStale 通道进日记时间轴，可展开。数量控制在每天 10–30 条。
2. 记忆：新颖度三规则（新应用会话、长阅读会话、用户触碰过的卡）经现有 ingest 过滤规则入口下沉；记忆条目存摘要+卡片引用，不复制原文。
3. Room：卡片「加入 Room」→ 现有素材注册链路（perception 注册模式）；描述生成按需，不在加入时自动跑 VLM。
4. Agent 工具 `screen_memory_search`：
   - 入参：关键词、可选应用/时间过滤；返回：时间、应用、标题、片段、原图路径。
   - 注册坑位提前避开：必须声明进 agent.yaml；agents/ 改动须重启网关。
5. 「交给 Agent」：卡片上下文（文本+摘要）注入当前对话。

验收：日记出现屏幕会话条目并可展开；Agent 对话中通过工具检索到卡片并正确引用；加入 Room 后素材可检索。

## 八、P6：历史补处理与收尾

1. 补处理源：网关文件库中 assetKind=screenshot 的存量 blob（现管线上传过的截图）。
2. UI：选日期范围与数量 → 展示预计处理量（按 3.7 新口径：LLM 调用次数）→ 分批执行，保留原 capturedAt。
3. 补处理复用 P2 管线（Vision OCR + 聚合），摘要走 P3 配额。
4. 设备适配检测（无模型下载，替代原 PRD 条款）：芯片架构、内存 ≥8GB、磁盘剩余空间检查；不满足则引导不开启。
5. 真机回归清单 + PRD 验收逐条自测（断网、静止省推理、微小变化、历史日期四项）。

## 九、横切约束（全程有效）

1. 隐私红线：默认 local_only；外发仅摘要纯文本；排除应用数据物理不存在；暂停期间零采集。
2. 复用清单：dHash（window-screenshot-service）、队列模式（screenshot-outbox/visualProcessingJobs）、二进制内置模式（lark-cli 等）、日记通道（markDiaryStale）、素材注册链路、设置入口（SettingsPage 现实感知区）。
3. 新建清单：Vision 助手、整屏采集、四系统事件钩子、应用授权模型、文本差异判定、区间状态机、screen-memory 模块、检索、活动卡 UI、Agent 工具、补处理。
4. 测试基线：分支既有失败（vendor/genoffice/context-room 在飞工作）不混入；验证只跑受影响模块；UI 用 mock-room 浏览器复现配方，真机清单单独跑。
5. PRD 偏差文档随产品确认结果同步修订。

## 十、显式不做（本版）

1. 多显示器采集。
2. HEIC 压缩（Electron 显示兼容未验证，留作优化）。
3. FTS5 全文分词索引。
4. 区间回放（视频聚合）。
5. 无障碍接口取文本（提取链第二步，原生权限链路成本高，本版 OCR 覆盖；后续版本评估）。
6. 文档理解链路切 Vision（后续顺手优化）。
7. Intel 机型实测优化（通用二进制先出，实测排 P6 真机清单）。
