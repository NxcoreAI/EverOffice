---
name: layout-tree-v2-skill
description: v2 布局语法——version 2 / composition / 12×8 slot / type token / bleed / runs / stats / chart / footer；只设计单页，坐标由引擎算
---

# LayoutTree v2（审页修订用）

审页输入带 `layoutVersion: 2` 时，当前树是 v2；修订必须继续提交 v2 页面，不得降回 v1 的 direction/weights/children。

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

- `composition` 必填：`immersive | hero-data | editorial | swiss | poster | chapter`。
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

v2 页面可包含参数化积木节点，与 text/image/stats/chart/shape 并列；审页时它已在当前树里，修订可保留或调整其 `style`：

```json
{ "type": "component", "name": "timeline",
  "style": { "surface": "none", "separator": "line" },
  "items": [ { "label": "2026", "text": "品类验证" }, { "label": "2027", "text": "渠道扩张" }, { "label": "2028", "text": "品牌溢价" } ],
  "slot": { "col": [1, 6], "row": [4, 8] } }
```

- 27 个组件名：`timeline / steps / stats / featureCards / quote / comparison / matrix2x2 / prosCons / agenda / chevron / pyramid / funnel / venn / calloutBox / cycle / progress / orgChart / persona / bentoGrid / layeredStack / teamGrid / quotes / pricingTiers / logoWall / pointList / indexHeader / eraRail`；参数与条目规则见 v1 技能 `layout-tree-skill` 的组件表。
- `style` 可选，值全部是语义枚举：`surface` none|card|tint|outline|ink|band、`separator` line|gap|none、`align` start|center、`density` tight|normal|airy、`numeral` serif|sans|none、`accent` primary|accent|muted、`motif` inherit|none。省略即继承整册风格卡默认（与当前页其它组件同源）。
- 组件专属变体：stats.layout row|column|grid、timeline.axis line|dots|none、steps.connector line|gap|none、chevron/pyramid/funnel.form outline|filled|tint、calloutBox.form bar|panel|tint、cycle.marker dot|number、progress.fill ink|primary、orgChart.connector elbow|none、teamGrid.avatar circle|initial、logoWall.monochrome true|false。
- 组件样式继承 deck 风格卡：同一 deck 的默认 surface/separator/density 由风格卡统一，per-node `style` 只是同一设计系统内的变奏。
- `style` 是改组件样式的唯一入口：不写裸色号 / 裸 pt / 裸 px；未知 style 字段直接报错。审页修订可改 `style`，但不得改写 `copy` 文案。

## Composition 硬约束（validate 会拒收）

| composition | 必须 |
|---|---|
| immersive | 至少一个 `image` 带 bleed |
| hero-data | 至少一个 `token:"hero"` 的 text 或 chart |
| editorial | 至少一个 image + 一个 h1/h2 |
| poster / chapter | 至少一个 `token:"display"` |
| swiss | 无额外要求 |

## 内容纪律

1. 文案以输入 `copy` 为准：message 做成主 text；supporting/facts/quote/source 各就各位；不改写、不加句。
2. 不重复：message 说过的不要再做 supporting。
3. 一页一个视觉锚点（emphasis）：image / 大数字 / 引语 / chart。
4. 相邻页 composition 不同；整册至少 3 种。
5. 先按 composition 定骨架，再填 slot；不要从 v1 的 weights/children 改写。

## 校验

调 `slides_layout_validate`（传 `deckToken` 与整页 JSON）。有缺陷按 `path/hint` 修，最多 3 轮；`ok=true` 后提交 `{status:"done", tree: 页面 JSON}`。

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
