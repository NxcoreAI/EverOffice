---
name: layout-tree-v2-skill
description: v2 布局语法——version 2 / composition / 12×8 slot / type token / bleed / runs / stats / chart / footer；只设计单页，坐标由引擎算
---

# LayoutTree v2

输入带 `layoutVersion: 2` 时用本语法。你的产出是一页 v2 页面 JSON，不是 v1 树。

## 根

```json
{
  "version": 2,
  "role": "content",
  "composition": "editorial",
  "safeArea": "content",
  "grid": { "cols": 12, "rows": 8, "gutter": 24, "rowGutter": 16, "margin": 64 },
  "footer": { "left": "数据来源：…", "pageNumbers": true },
  "nodes": []
}
```

- `composition` 必填，且**必须等于输入 `composition`**：`immersive | hero-data | editorial | swiss | poster | chapter`；不得自行换 recipe。
- `safeArea`：`content`（默认）或 `full`；图片/色块用 node `bleed` 出血。
- `grid` 可省略，用主题默认；`footer` 可选，`pageNumbers` 由网关注入页码。
- 页面不写标题带；message/标题都做成 text 节点。

## 节点通用

- `slot`：`{col:[c1,c2], row:[r1,r2]}`，1 起、闭区间；`c1≤c2≤cols`、`r1≤r2≤rows`。
- `bleed`：`true` 或 `"left"|"right"|"top"|"bottom"|"x"|"y"|"all"` 或数组，出血到画布边缘。
- 每页节点 ≤ 48；图 ≤ 8；文字必须用 type token。

## text

```json
{
  "type": "text", "token": "h1", "text": "从 2.7 亿到 3.87 万亿元",
  "tone": "text", "align": "left", "valign": "top",
  "lineHeightPct": 110, "letterSpacing": 0,
  "slot": { "col": [1, 8], "row": [2, 3] }
}
```

- `token`：display/hero/h1/h2/h3/lead/body/label/kicker/caption。
- `tone`：text/muted/primary/accent/inverse/inverseMuted/surface/primarySoft/divider/chart1~6。
- 混排用 `runs` 或 `paragraphs`；run 可带 `token/bold/tone/font(heading|body|serif)/letterSpacing`。
- 不写任意 pt、字号、颜色；不写 emoji。

## image

```json
{
  "type": "image", "url": "everroom-material://…", "fit": "cover",
  "focus": { "x": 38, "y": 55 }, "caption": "蛇口 · 1979",
  "slot": { "col": [8, 12], "row": [2, 8] }, "bleed": ["right"]
}
```

- `cover` 默认裁切填满；`contain` 不变形但可能留空带。
- 框比例尽量贴近素材；`caption` 只留一处。

## icon / path（图形与图标）

```json
{ "type": "icon", "name": "bolt", "tone": "primary",
  "slot": { "col": [1, 1], "row": [4, 4] } }
{ "type": "path", "d": "M0 0 H160", "stroke": { "color": "tone:primary", "widthPt": 2 },
  "slot": { "col": [1, 4], "row": [3, 3] } }
```

- `icon` 名称必须来自引擎图标集：`check-circle`、`bolt`、`shield-check`、`users`、`chart-bar`、`globe-alt`、`rocket-launch`、`light-bulb`、`map-pin`、`clock`、`arrow-trending-up` 等。
- 每页 1~3 个 icon 足够：门槛页给三项各一个，团队页给人/团队，流程页给节点；不要整页铺图标。
- `path` 用于细线、箭头、时间轴基线、图表装饰；`d` 只写简单 SVG path，不写文字。
- 图形是第二层：先保证 message，再用 icon/path/shape 做“信息图形”，不要把页面做成纯文字白底。

## 底色与标题

- 章节/金句/收尾页用 `dark:true` 或 `background:"tone:primarySoft"`，内容页可用 `background:"tone:surface"` 做区块，不要整册纯白。
- 标题不要只放一行裸 h1：kicker 前加一条 24~40px 的 primary 短线（shape），或把 kicker 放进 primarySoft 色块；标题区与内容区用一条 divider 分开。
- 数据/表格页在标题右侧放一个“结论数字/关键词”小色块，避免左侧一大片空白。

## table

```json
{
  "type": "table", "header": true, "style": "banded", "fontSize": 10,
  "colWidths": [1.6, 1, 1, 1.6],
  "rows": [
    ["厂商", "构型 / 路线", "单价", "市场情况"],
    ["Jetson ONE", "多旋翼", "约 12 万美元", "订单排到 2027 年"],
    ["Opener Helix", "复合翼", "19–26 万美元", "2025 年 5 月发货"],
    ["小鹏汇天", "汽车 + 飞行器", "约 200 万元", "在手订单超 4000 台（待核实）"]
  ],
  "slot": { "col": [1, 8], "row": [4, 8] }
}
```

- `rows` 2~12 行、每行 1~8 列；首行默认表头（primary 底反白）。
- 表格页优先用 table，不要把 5 行以上表格拆成 facts 卡片。
- 单元格可写对象：`{"text":"2025","bold":true,"tone":"muted","align":"right","span":2}`。
- `zebra` 默认浅色隔行；密集 BP 页用 `fontSize:9~10`，不要低于 8。
- `style` 三选一：`banded`（蓝底表头+隔行，默认）、`outline`（白底+主色边框，适合轻页）、`minimal`（无底色，仅横线，适合密集财务表）。
- 表头用 primary 底反白（banded）或 primary 字（outline）；第一列加粗、数值列右对齐；`colWidths` 按内容分配，不要等宽。
- 表格不要孤零零放页面中央：标题区 + 表格 + 一条 source 脚注，必要时右侧/下方补一个结论数字或 icon。

## group（v1 flex 岛，找回自由布局）

slot 栅格表达不了的自由版式，用 `group` 把一块 slot 交给 v1 容器语法：

```json
{
  "type": "group",
  "slot": { "col": [1, 6], "row": [2, 7] },
  "panel": "tint",
  "tree": {
    "direction": "row",
    "weights": [1.4, 1],
    "gapScale": 1.2,
    "children": [
      { "type": "text", "variant": "heading", "text": "左栏" },
      { "direction": "column", "children": [
        { "type": "text", "variant": "body", "text": "自由嵌套" },
        { "type": "icon", "icon": "bolt" }
      ] }
    ]
  }
}
```

- `tree` 是完整的 v1 树：`direction / weights / gapScale / pad / justify / overlay+place / panel / 27 组件` 全部可用。
- `panel` 可选：`surface / tint / dark / outline`，作为 group 的底板。
- 只把 group 用在 slot 无法表达的自由版式（架构图、拼贴、复杂嵌套卡）；普通页面先走 slot。
- `tree` 内不能再嵌套 v2 页面；需要 v2 原子时用 v1 的 text/image/icon/path/component。

## connector（连线/箭头）

```json
{ "type": "connector", "from": { "x": 18, "y": 34 }, "to": { "x": 72, "y": 62 },
  "tone": "primary", "widthPt": 1.5, "arrow": true }
```

- 坐标是画布百分比 0~100；`arrow:false` 只画线。
- 用于 group 内元素之间、时间轴节点、架构图连线；不要用它替代正文分隔线。

## stats / chart / shape

```json
{ "type": "stats", "items": [{ "value": "2.83", "unit": "万亿元", "label": "2020 年 GDP" }],
  "slot": { "col": [9, 12], "row": [2, 8] } }
{ "type": "chart", "kind": "bar", "categories": ["2020 年", "2025 年"],
  "series": [{ "name": "GDP", "values": [2.83, 3.87] }], "dataLabels": true,
  "slot": { "col": [9, 12], "row": [2, 6] } }
{ "type": "shape", "shape": "rect", "fill": "#0e0d0c66",
  "slot": { "col": [1, 12], "row": [1, 8] }, "bleed": true }
```

- stats 2~4 条；chart 2~24 类目；shape 需要 fill/gradient/stroke 之一。
- chart 只在真正支撑 message 时用；数据页优先 hero 数字 + stats。

## 组件节点（component）

v2 页面可把参数化积木当节点用，与 text/image/stats/chart/shape 并列：

```json
{ "type": "component", "name": "timeline",
  "style": { "surface": "none", "separator": "line" },
  "items": [ { "label": "2026", "text": "品类验证" }, { "label": "2027", "text": "渠道扩张" }, { "label": "2028", "text": "品牌溢价" } ],
  "slot": { "col": [1, 6], "row": [4, 8] } }
```

- 37 个通用组件名：`timeline / steps / stats / featureCards / quote / comparison / matrix2x2 / prosCons / agenda / chevron / pyramid / funnel / venn / calloutBox / cycle / progress / orgChart / persona / bentoGrid / layeredStack / teamGrid / quotes / pricingTiers / logoWall / pointList / indexHeader / eraRail / sectionHeader / founderProfile / radialFunnel / kpiRows / categoryCards / featureRail / photoTriptych / competitorBoard / fullBleedQuote / financialBoard`。
- 这些页面原子只读 `frame/theme/skin`，不包含客户名、品牌色或参考页文案；样式由 deck 的 styleTokens 决定。
- 常用条目：`timeline.items[{label,text}]`、`steps.items[{title,text?}]`、`stats.items[{value,unit?,label}]`、`quote{text,author?}`、`calloutBox{text,icon?}`、`cycle.items[{title,text?}]`、`comparison.sides[]`、`matrix2x2.quadrants[]`。字段名照抄；未知字段报错。
- `style` 可选，值全部是语义枚举：`surface` none|card|tint|outline|ink|band、`separator` line|gap|none、`align` start|center、`density` tight|normal|airy、`numeral` serif|sans|none、`accent` primary|accent|muted、`motif` inherit|none。省略即继承整册风格卡（`styleTokens.componentDefaults`）。
- 组件专属变体：stats.layout row|column|grid、timeline.axis line|dots|none、steps.connector line|gap|none、chevron/pyramid/funnel.form outline|filled|tint、calloutBox.form bar|panel|tint、cycle.marker dot|number、progress.fill ink|primary、orgChart.connector elbow|none、teamGrid.avatar circle|initial、logoWall.monochrome true|false。
- 组件样式继承 deck 风格卡：同一 deck 的默认 surface/separator/density 由风格卡统一，per-node `style` 只是同一设计系统内的变奏。母题只落在有底面的组件上（`surface:"none"` 不重复画），页级母题由引擎统一铺。
- `style` 是改组件样式的唯一入口：不写裸色号 / 裸 pt / 裸 px；未知 style 字段直接报错。`slot` / `bleed` 与其它节点相同。

## Composition 硬约束（validate 会拒收）

| composition | 必须 |
|---|---|
| immersive | 至少一个 `image` 带 bleed |
| hero-data | 至少一个 `token:"hero"` 的 text 或 chart |
| editorial | 至少一个 image + 一个 h1/h2 |
| poster / chapter | 至少一个 `token:"display"` |
| swiss | 无额外要求 |

## 内容纪律

1. 文案以输入 `copy` 为准：**主标题必须用 `copy.message`**（v2 输入不提供 planner 标题）；supporting/facts/quote/source 各就各位；不改写、不加句。
2. 不重复：message 说过的不要再做 supporting。
3. 一页一个视觉锚点（emphasis）：image / 大数字 / 引语 / chart / table。
4. 全出血 cover/quote 图必须叠 60~80% 深色 scrim 或压暗图，保证反白标题在亮天空/浅背景上仍可读。
5. 相邻页 composition 不同；整册至少 3 种。
6. 先按 composition 定骨架，再填 slot；不要从 v1 的 weights/children 改写。
7. 表格页用 `table`，不要把多行表拆成 facts 卡片；参数表、成本表、竞品表、财务表都走 table。

## 页面密度与骨架（通用）

内容页至少 4 个模块：页眉/标题、主内容、证据（图/表/图）、底部结论或导航。普通页优先 slot；slot 表达不了的自由版式用 `group`，元素关系用 `connector`。

无图片时用 icon/path/shape/table/chart/component 建立视觉锚点；有图片时优先让图片承担证据，文字只做结论和注释。具体用哪种页眉、色彩和图片处理，由 `styleTokens` 与当前 style pack 决定；不要把任何客户风格写进本 skill。

## 视觉丰富度闸门

内容/数据/表格/流程页不能只有文字 + 白底。validate 会要求至少一个 `icon / path / image / chart / table / stats / component`，或一条**非全屏**的 shape（短线/色块/分隔）。如果输入带 `revisionFeedback`，按它补视觉锚点后重新 validate。

## 校验

调 `slides_layout_validate`（传 `deckToken` 与整页 JSON）。有缺陷按 `path/hint` 修，最多 3 轮；`ok=true` 后再调一次 `slides_page_preview`（传 deckToken/pageIndex/当前树）：

- 返回 `defects` 先按 hint 修；
- `visual.issues` 里 major 项（weak_hierarchy / flat_background / no_visual_anchor / text_wall / cramped / empty_space）要改树；
- 最多预览 2 次，然后提交 `{status:"done", tree: 页面 JSON}`。

预览是临时单页渲染，不写当前 deck；多页并发不会互相踩。

## 示例（hero-data）

```json
{
  "version": 2, "role": "data", "composition": "hero-data",
  "footer": { "pageNumbers": true },
  "nodes": [
    { "type": "text", "token": "kicker", "text": "45 年 · 经济总量", "tone": "primary",
      "slot": { "col": [1, 6], "row": [1, 1] } },
    { "type": "text", "token": "h1", "text": "从 2.7 亿到 3.87 万亿元",
      "slot": { "col": [1, 8], "row": [2, 3] } },
    { "type": "text", "token": "hero",
      "paragraphs": [
        { "runs": [{ "text": "2.7", "token": "hero", "bold": true, "tone": "primary" }, { "text": " 亿元", "token": "lead", "tone": "muted" }] },
        { "spaceBeforePt": 10, "runs": [{ "text": "1980 年地区生产总值", "token": "label", "tone": "muted" }] }
      ],
      "slot": { "col": [1, 4], "row": [4, 6] } },
    { "type": "stats", "items": [
      { "value": "21.38", "unit": "万元", "label": "2025 年人均 GDP" },
      { "value": "5.5", "unit": "%", "label": "“十四五”年均增速" }
    ], "slot": { "col": [9, 12], "row": [2, 8] } }
  ]
}
```
