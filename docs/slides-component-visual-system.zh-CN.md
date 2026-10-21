# 组件视觉系统 v2：从「能排」到「高级」

- 日期：2026-10-19
- 目标：27 个组件的真实渲染都要达到「可上商业提案」的视觉质量；仍然只读 `ComponentSkin`，不写裸像素。
- 验收：`component-beauty` 快速回路（27 页基线 → LibreOffice 渲染 → 联系表）逐轮目检；`component-variants-gallery` 全量变体不回归。

## 1. 上一版为什么丑（联系表诊断）

1. **字号太小**：正文 12–14pt、标题 16–20pt，在 1280×720 页面上像文档缩略图；数字/年份没有成为视觉主体。
2. **内容不占版面**：大量组件把内容丢进 576px 高的框里垂直居中，上下留白各 100–200px，卡片像空纸。
3. **卡片是「白纸」**：卡面与页底几乎同色、描边过浅、内边距小，卡内文字贴边或悬空，没有卡片应有的重量。
4. **层级平**：标签、标题、正文、数字经常同一字重/字号；没有 eyebrow、序号、规则线等结构件。
5. **图形太轻**：金字塔/箭头/漏斗/循环用 1pt 空心线，文字 13pt，视觉骨架感强于内容。
6. **颜色缺席**：唯一强调色只出现在 24×3 的小刻标上，主色/强调色没有承担结构。

## 2. 设计语言

**基调**：暖纸（`palette.background`）+ 墨色正文 + 一个结构主色 + 一个强调色。留白是版式的一部分，不是内容太小的结果。

### 2.1 字号阶梯（按 frame 高推导，`skin.metrics(frame)`）

| 角色 | 公式（h=576 时） | 用途 |
|---|---|---|
| `display` | clamp(64, h×0.19, 132) → 109 | KPI、价格、年份、引文主语 |
| `title` | clamp(22, h×0.052, 38) → 30 | 条目/卡片标题、象限标题 |
| `body` | clamp(15, h×0.031, 21) → 18 | 正文、要点 |
| `label` | clamp(11, h×0.023, 14) → 13 | 全大写微标签（eyebrow） |
| `serial` | clamp(28, h×0.075, 60) → 43 | 序号、章节号 |
| `caption` | clamp(11, h×0.021, 14) → 12 | 单位、注脚、元信息 |

- 数字/年份/价格一律 **衬线（`skin.fonts.numeral`）**；标签/正文用无衬线。
- 标签一律大写 + 字距 1.6pt（`skin.micro`）；中文标签走 12–13pt 加字距。
- 正文行距 120%（如引擎支持），标题 100%。

### 2.2 间距与卡片

- 组件内边距 `metrics.pad` ≈ 短边 5%（576 → 29px）。
- 栏距/条目距 `metrics.gap` ≈ 短边 5.5%（→ 32px），紧距 `tightGap` ≈ 12–18px。
- 卡面：`surface` 填充 + 1px 描边（`decoration.cardStroke`）+ 柔影 + `cornerRadius`；卡内边距 ≥ 28px。
- 卡内内容 **顶对齐 + 底部元信息** 或 **整体居中**，不允许「上不沾天下不着地」的悬浮。
- 分隔线 1px，颜色取 `skin.colors.divider`；需要分量时用 2px 墨线（页眉/表头式）。

### 2.3 结构件

- **eyebrow**：一列微标签 + 2–3px 强调色短规则（`skin.accentRule`）。
- **序号**：衬线大号 01/02，强调色；不是灰色小字。
- **卡片索引**：微标签放左上角，序号放右上角（或反之），形成「标本卡」节奏。
- **反白块**：每个 deck 至少允许一个 ink 面板承担最强对比（featured 档、首格、根部）。

### 2.4 默认底面策略

- **无底面语义组件**（stats/timeline/steps/agenda/pointList/indexHeader/eraRail/progress/venn/cycle/chevron/pyramid/funnel/quote）：风格卡即使有卡面 token，也默认平铺；只有 agent 显式写 `style.surface` 时才铺底。
- **卡片语义组件**（featureCards/comparison/matrix2x2/prosCons/quotes/teamGrid/persona/bentoGrid/layeredStack/pricingTiers/logoWall/calloutBox）：默认使用风格卡卡面；卡内必须填满或均分，不留大片空纸。

## 3. 逐组件艺术方向（实现时按 frame 比例缩放）

| 组件 | 结构 | 关键尺寸/细节 |
|---|---|---|
| stats | eyebrow 规则 + 全大写标签 + 衬线巨数字 + 单位基线 | display 109；规则 32×3 强调色；列间 1px 竖线 |
| timeline | 轴线 + 节点圆点 + 衬线年份 + 说明 | 年份 40–44 serif；说明 16；节点 10px 强调色；轴线 1px |
| steps | 幽灵大序号 + 标题 + 正文 + 连接线 | 序号 display×0.9 低透明；标题 title；连接线 2px 强调色 |
| agenda | 衬线大序号 + 条目 + 行规则 | 序号 serial 43 强调色；条目 24；行高均分 |
| pointList | 序号 + 粗标签 + 正文 + 分隔 | 标签 title 30；正文 body；序号 serial/2 |
| featureCards | 卡面 + 图标徽章/图槽 + 标题 + 正文 | 徽章 48 tinted；标题 title；正文 body；卡内 28 |
| comparison | 多方列 + featured 面板 + 三态标记 | 标题 title；要点 body；featured 4px 顶条 + 徽章 |
| matrix2x2 | 四象限 + 主色十字/轴标 | 象限标题 24；要点 16；轴标 label |
| prosCons | 两栏 + 图标 + 标题 | 标题 title；条目 body；中央 1px 线 |
| quote | 大号衬线引文 + 强调规则 + 署名 | 引文 display×0.45；署名 label |
| quotes | 卡面 + 星级 + 引文 + 首字头像 | 星级 16 强调色；引文 19；姓名 16 |
| teamGrid | 首字头像 + 姓名 + 职位 + 简介 | 头像 72 tinted；姓名 20；职位 label 强调色 |
| persona | 大头像 + 姓名 + 要点 | 头像 150；姓名 32；要点 body |
| bentoGrid | 拼贴卡 + 索引 + 标题 + 正文 | 首格 ink 反白；标题 title；索引 label |
| layeredStack | 行带 + 大序号 + 标题 + 正文 | 序号 serial；行高均分；交替 tint |
| pricingTiers | 卡面 + 价格 + 特性 + CTA | 价格 display×0.55；featured 反白；CTA 40px |
| logoWall | 字标墙 + 均匀网格 | 字标 26–28、字距 2.4；灰度图 contain |
| indexHeader | 大序号 + 标题 + 小注 + 2px 底线 | 序号 display×0.6；标题 title；底线 2px |
| eraRail | 脊线 + 年代 + 短注 | 年代 30 serif；高亮条强调色 |
| chevron | 实心箭头链 | 高度 60% frame；标题 22 反白/墨 |
| pyramid | 实心层级 | 层级填充明度渐变；文字反白 22 |
| funnel | 实心收窄条 | 阶段 24、数值 15；墨色渐隐 |
| venn | 双圆 + 交集标签 | 圆 260–300；标签 24 粗；1.5px 描边 |
| calloutBox | 强调条 + 图标徽章 + 一句结论 | 结论 26–30 粗；条 6px 强调色 |
| cycle | 环 + 编号节点 + 标签 | 节点 36 强调色底反白数字；环 2px |
| progress | 标签 + 大数值 + 粗轨道 | 轨道 12px；数值 24 强调色；目标刻度 2px |
| orgChart | 反白根节点 + 描边子节点 + 连线 | 根 title 20 反白；子 18；连线 1.5px |

## 4. 实现记录（2026-10-19）

- `ComponentSkin.metrics(frame)`：`display/title/body/label/caption/serial/pad/gap` 全部以风格卡
  `typeScale/spacing` 为锚，按 `frame.h/576` 等比放大（0.48–1.4），`density` 只乘间距不乘字号。
- 27 个组件全部重写：无底面语义组件只在 `skin.surfaceExplicit` 时铺底；卡片组件用
  `skin.paint(cell)` + `contentBox`；`skin.micro/accentRule/initials/numeralRun` 统一结构件。
- 默认形态升级：chevron/pyramid/funnel 实心；cycle 编号节点；pricing featured 反白 ink 卡；
  teamGrid/persona/quotes 用衬线首字徽章替代 user 图标；bento 首格反白、wide 整行。
- 小框降级：`expandComponent` 捕获 `LAYOUT_LEAF_INVALID` 后，以 0.85/0.72/0.6 三档缩放
  `theme.typeScale/sizes` 重试（颜色/间距不变）；仍失败才抛给 layouter 重排。
- 视觉验收：`component-beauty` 回路 27 页联系表；全量变体目录 `component-variants-gallery`
  397 个有效变体、0 不可用。
- 尺寸边界：单栏/多栏复杂组件建议最小槽位约 `半页宽 × 半页高`（≥560×280）；三分页下的
  4–6 项网格类组件会报 overflow（这是有意的可读性底线，由 layouter 加大槽位）。
