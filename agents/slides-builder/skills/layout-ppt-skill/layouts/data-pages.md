---
name: data-pages
description: 数据页预设字段说明：D1 KPI 数字带 / D2 结论横幅 / D3 全宽图表 / D4 散点定位 / D5 图表+侧栏。填数字/图表页前必读。
---

# 数据页预设（二级）

数据页原则：**一页一个数字故事**——结论写进页标题（如「2030 年收入达 1.6 亿」），图/数字只承担证据。每页最多一张图表。

## chart 字段（D1/D3/D4/D5 共用）

```json
"chart":{"chart":"bar","categories":["Q1","Q2","Q3","Q4"],"series":[{"name":"收入","values":[120,135,150,168]}]}
```

- `chart`：bar / barStacked / line / pie / doughnut / scatter / comboBarLine（柱+折线双轴，最后一系列走右轴，须 ≥2 系列）。
- `categories` 2~24 个；`series` 1~6 个，每个 `values` 数量必须等于 categories 且全为数字。
- 系列色自动取风格卡 chartSeries；点数 ≤8 自动开数据标签。图例/轴样式引擎托管，不用管。
- 图型选择：财务（收入+增长率）→ comboBarLine；趋势 → line；结构 → pie/doughnut；对比 → bar。

## D1 KPI 数字带

```json
{"id":"D1","title":"…","stats":[{"value":"1.6亿","label":"2030 收入","unit":"元"},{"value":"31%","label":"年复合增长"}],"focusFirst":true}
```

- `stats` 2~6 个：4 个排一行，2~3 个排一行，5~6 个排两行；数字字号自动适配格宽。
- `focusFirst` 缺省 true——首格数字最大做焦点。
- 可选 `"chart":{…}`：数字带下方加一张 bar 图印证趋势（仅当图确实支撑标题结论）。

## D2 结论横幅 + 数据行

```json
{"id":"D2","title":"…","banner":{"text":"一句主张统领全页","value":"+31%"},"stats":[…同 D1…]}
```

深色横幅（一行主张 + 右端可选大数字），下方数字带同 D1。

## D3 全宽图表页

```json
{"id":"D3","title":"结论即标题","chart":{…}}
```

一张图表撑满内容区，结论由页标题承担；图表 title 留空（页面已有大标题时不填 chart.title）。

## D4 散点定位页

```json
{"id":"D4","title":"…","chart":{"chart":"scatter","categories":["199","299","499"],"series":[{"name":"产品","values":[88,92,75]}]},"cards":[{"title":"定位空白","body":"中价位高性能段无人占位"}],"ratio":"70/30"}
```

散点图占主区（categories 填 x 数值字符串，series.values 是对应 y 值）；右侧 2~3 张结论小卡（定位空白、目标区间等）。关键点位写进卡片而不是叠图标注。`ratio` 可选 "70/30"（缺省）/"62/38"。

## D5 图表 + 侧栏结论

```json
{"id":"D5","title":"…","chart":{…},"cards":[{"title":"从图上读得出的结论","body":"一两行依据"},…2~3 张],"ratio":"70/30"}
```

每卡结论必须「从图上读得出来」；读不出来的结论不要放。

## 通用

- 数字格式统一：千分位、单位进标题或标签（「收入（万元）」）、同页小数位一致。
- 底边由图或数字格自动撑满（展开器保证），不用管。
