# 幻灯片布局语法（v2 唯一写入格式）

状态：权威正文 · 2026-10-21

本文件是幻灯片布局的唯一语法正文。layouter 与 reviewer 的技能文件 `skills/layout-tree-skill/SKILL.md` 由 `scripts/render-layout-skills.mjs` 从本文件生成。只改本文件，不要直接改生成物。

布局只有一种写入格式：**v2 页面**（`version: 2` + `composition` + `nodes`）。v1 树的编译代码只服务历史 deck 的读，不再有写入路径。`group.tree` 已删除；`group` 是 v2 原生分区容器。

## 根

```json
{
  "version": 2,
  "role": "content",
  "composition": "editorial",
  "safeArea": "content",
  "grid": { "cols": 12, "rows": 8, "gutter": 24, "rowGutter": 16, "margin": 64 },
  "footer": { "left": "数据来源：…", "pageNumbers": true },
  "notes": "演讲备注",
  "nodes": []
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `version` | `2` | 必填。 |
| `role` | 照抄输入的 `role` | 内容语义标签，不改写。 |
| `composition` | `immersive / hero-data / editorial / swiss / poster / chapter` | 必填，必须等于输入的 `composition`；不得自行换 recipe。 |
| `safeArea` | `content`（默认）/ `full` | 图片与色块用节点 `bleed` 出血。 |
| `grid` | `cols 1~12`、`rows 1~12`、`gutter 0~48`、`rowGutter 0~48`、`margin 0~96` | 可省略，用风格卡默认（12 列 × 8 行）。 |
| `footer` | `left? / center? / right?` 各 ≤120 字；`pageNumbers?`；`tone?` `text \| muted \| inverse` | 可省略；`pageNumbers` 由网关注入页码。 |
| `background` | 色号，≤9 字符（如 `"#0E0D0C"`） | 可省略，缺省用主题底色。 |
| `dark` | `true` | 整页深色口径。封面/收尾角色在风格卡 `darkCover` 下自动深色。 |
| `notes` | 字符串，≤2000 字 | 演讲备注，原样放输入的 `copy.speakerNotes`。 |
| `nodes` | 1~64 个页面级节点 | 含 group 子节点后总数 ≤64。 |

页面不写标题带；message 与标题都做成 text 节点。

## 节点通用

- 节点类型 11 种：`text / image / shape / stats / chart / table / component / icon / path / group / connector`。其它类型报错。
- 页面级节点必须写 `slot`：`{ "col": [c1, c2], "row": [r1, r2] }`。编号 1 起、闭区间；`c1 ≤ c2 ≤ cols`、`r1 ≤ r2 ≤ rows`。
- `bleed`：`true`、`"left" | "right" | "top" | "bottom" | "x" | "y" | "all"`，或这些值的数组。出血到画布边缘。
- `group` 子节点不写 `slot`、不写 `bleed`。
- 文字只用 type token。不写任意 pt、字号、颜色、字体。
- 不写 emoji：引擎直接拒页。装饰图形用 `path`，图标用 `icon`。
- 页面预算（引擎硬限制，超了 validate 报）：元素总数 ≤48、图片 ≤8、路径 ≤4、单条文本 ≤2000 字符。

## text

```json
{
  "type": "text", "token": "h1", "text": "从 2.7 亿到 3.87 万亿元",
  "tone": "text", "align": "left", "valign": "top",
  "lineHeightPct": 110, "letterSpacing": 0,
  "slot": { "col": [1, 8], "row": [2, 3] }
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `token` | `display / hero / h1 / h2 / h3 / lead / body / label / kicker / caption` | 必填。字号由 token 定档。 |
| `text` | 字符串 ≤2000 字 | `text`、`runs`、`paragraphs` 三者至少一个。 |
| `runs` | `[{ text, token?, bold?, tone?, font?, letterSpacing? }]` | 行内混排。`font` 取 `heading / body / serif`。 |
| `paragraphs` | `[{ runs, align?, lineSpacingPct?, spaceBeforePt?, spaceAfterPt? }]` | 多段混排；`runs` 非空。 |
| `tone` | `text / muted / primary / accent / inverse / inverseMuted / surface / primarySoft / divider / chart1~chart6` | 缺省 `text`。 |
| `align` | `left / center / right` | 缺省 `left`。 |
| `valign` | `top / middle / bottom` | 缺省 `top`。 |
| `letterSpacing` | -4~12 | 可省略。 |
| `lineHeightPct` | 60~160 | 缺省 110。 |
| `fit` | `none / shrink / ellipsis` | 缺省 `none`；`shrink` 自动缩字。 |
| `maxLines` | 1~4 | 配合 `ellipsis` 截断。 |
| `direction` | `horizontal`（默认）/ `vertical` | `vertical` 是中文单字竖排。 |

## image

```json
{
  "type": "image", "url": "everroom-material://…", "fit": "cover",
  "focus": { "x": 38, "y": 55 }, "caption": "蛇口 · 1979",
  "slot": { "col": [8, 12], "row": [2, 8] }, "bleed": ["right"]
}
```

- `url` 必填，≤500 字符，只接受 `http(s)://` 直链或 `everroom-material://` 素材引用。
- `fit`：`cover`（默认，裁切填满）或 `contain`（完整呈现，可能留空带）。两者都不变形；框比例尽量贴近素材。
- `focus`：`{ x?, y? }`（0~100）把 cover 裁切对准画面主体。
- `caption` ≤40 字，只留一处。
- `grayscale / duotone / radius`：`true` 才生效；`mask` 取 `circle / rounded`。
- `scrim`：`{ color?, opacity? }`（`color` 是色号，`opacity` 0~1，缺省 0.55），给压图文字留可读底。

## icon / path

```json
{ "type": "icon", "name": "bolt", "tone": "primary",
  "slot": { "col": [1, 1], "row": [4, 4] } }
{ "type": "path", "d": "M0 0 H160", "stroke": { "color": "tone:primary", "widthPt": 2 },
  "slot": { "col": [1, 4], "row": [3, 3] } }
```

- `icon.name` 必须来自引擎图标集：`check-circle`、`check`、`bolt`、`shield-check`、`users`、`chart-bar`、`chart-pie`、`globe-alt`、`rocket-launch`、`light-bulb`、`map-pin`、`clock`、`arrow-trending-up`、`sparkles` 等。名字不在集合内报错。
- `icon.tone` 与 text 的 `tone` 同源。
- 每页 1~3 个 icon 足够：门槛页给三项各一个，团队页给人/团队，流程页给节点。不要整页铺图标。
- `path.d` 只写简单 SVG path（4~3000 字符），不写文字。
- `path.fill` / `path.stroke.color` 可写语义色（如 `tone:primary`）或色号；`stroke.widthPt` 0.25~12。
- 图形是第二层：先保证 message，再用 icon/path/shape 做「信息图形」，不要把页面做成纯文字白底。

## table

```json
{
  "type": "table", "header": true, "style": "banded", "fontSize": 10,
  "colWidths": [1.6, 1, 1, 1.6],
  "rows": [
    ["厂商", "构型 / 路线", "单价", "市场情况"],
    ["Jetson ONE", "多旋翼", "约 12 万美元", "订单排到 2027 年"],
    ["Opener Helix", "复合翼", "19–26 万美元", "2025 年 5 月发货"]
  ],
  "slot": { "col": [1, 8], "row": [4, 8] }
}
```

- `rows` 2~12 行、每行 1~8 列；各行总列宽（含 `span`）必须一致，否则报错。
- 首行默认表头（primary 底反白）；`header: false` 时按普通行。
- 单元格是字符串，或对象 `{ "text", "bold"?, "tone"?, "fill"?, "align"?, "span"? }`；单元格 ≤120 字。
- `style` 三选一：`banded`（蓝底表头 + 隔行，默认）、`outline`（白底 + 主色边框）、`minimal`（无底色，仅横线）。
- `colWidths` 按内容分配，不要等宽。`fontSize` 8~20，密集页用 9~10。
- 表格页优先用 table，不要把 5 行以上表格拆成卡片。
- 表格不要孤零零放页面中央：标题区 + 表格 + 一条 source 脚注，必要时补一个结论数字或 icon。

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

- `stats.items` 2~4 条；每条 `value` ≤14 字、`unit` ≤8 字、`label` ≤20 字。这是 `stats` 节点（页面级）的口径；`stats` 组件的上限见「组件参数」表。
- `chart.kind`：`bar / barStacked / line / area / waterfall / pie / doughnut / scatter / comboBarLine`。
- `chart.categories` 2~24 个；`series` 1~6 组，每组 `values` 与 `categories` 等长且都是数字。
- `chart` 可选 `colors`（≤6 个色）、`pointColors`、`dataLabels`、`legend`、`gridlines`。
- `shape.shape`：`rect / roundRect / ellipse / line / lineArrow`。`fill`、`gradient`、`stroke` 至少给一个。
- `shape.fill` 写色号（≤9 字符，如 `"#0e0d0c66"`）。`gradient` 需要 2~3 个 stop：`{ stops: [{ pos, color }], angle }`。
- chart 只在真正支撑 message 时用；数据页优先 hero 数字 + stats。

## connector（连线 / 箭头）

```json
{ "type": "connector", "from": { "x": 18, "y": 34 }, "to": { "x": 72, "y": 62 },
  "tone": "primary", "widthPt": 1.5, "arrow": true }
```

- 坐标是画布百分比 0~100：`from` / `to` 都是 `{ x, y }`。
- `tone` 与 text 的 `tone` 同源，缺省用主题主色；`widthPt` 0.5~6，缺省 1.5。
- `arrow: false` 只画线，缺省带箭头。
- **只允许出现在页面级**。`group` 内不允许 `connector`：group 子节点只放内容区块。
- 用于时间轴节点、架构图连线、页级元素之间的关系。不要用它替代正文分隔线。

## group（v2 原生分区）

slot 栅格表达不了的自由版式，用 `group` 把一块 slot 切成 v2 原生子节点：

```json
{
  "type": "group",
  "slot": { "col": [1, 6], "row": [2, 7] },
  "direction": "row",
  "weights": [1.4, 1],
  "gapScale": 1.2,
  "pad": 16,
  "panel": "tint",
  "children": [
    { "type": "text", "token": "h3", "text": "左栏", "weight": 1 },
    { "type": "component", "name": "pointList", "weight": 2,
      "items": [{ "label": "要点", "body": "说明" }, { "label": "要点二", "body": "说明" }] }
  ]
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `direction` | `row / column / overlay` | 必填。主轴方向。 |
| `weights` | 正数数组，0.1~20，个数 = children 数 | 仅 row/column；缺省均分。悬殊比例用 1.6/1、2/1 这一档。 |
| `gapScale` | 0~4 | 缝隙 = 主题 gutter（row）/ rowGutter（column）× gapScale。overlay 不写。 |
| `pad` | 0~48 | 帧内边距（px）。先扣内边距再分区。 |
| `justify` | `start / center / end` | 仅 column。子区域划分不变，内容未铺满时整组按 justify 平移。 |
| `panel` | `surface / tint / dark / outline` | 底板垫在所有子节点下面（先铺板再排内容）：卡面 / 主色浅档 / 墨面 / 细线框。用 `dark` 板时子节点文字用 `inverse`、`inverseMuted` 保对比。 |
| `children` | 1~12 个 v2 节点 | 子节点不写 `slot`、不写 `bleed`。 |

- 子节点写 `weight`（row/column）或 `place`（overlay），不写 `slot`、不写 `bleed`。
- overlay 的 `place` 是父区域百分比 `{ x, y, w, h }`：0~100，`x+w ≤ 100`、`y+h ≤ 100`。row/column 分组不写 `place`。
- overlay 分组不写 `weights`、不写 `gapScale`：子节点间距用 `place` 自己留出。
- 子节点类型与页面级完全相同：`text / image / shape / stats / chart / table / component / icon / path / group`。group 内不允许 `connector`。
- 嵌套深度 ≤3 层（`group` 套 `group` 套 `group` 为止）。第 4 层报错。
- group 子节点同样不写 px/pt/字号。色号只有 `shape.fill`、`path.stroke`、`image.scrim.color` 三处例外，按各自规则。
- 只把 group 用在 slot 表达不了的自由版式（架构图、拼贴、复杂嵌套卡）。普通页面先走 slot。
- `tree` 已废弃：收到即报错「group 不再接受 v1 树：把 tree 拆成 children 的 v2 节点，用 weight 表达比例」。

## component（组件节点）

组件是参数化积木：只给文案与条目，内部结构与绘制由引擎确定性生成。参数错误报归一缺陷，装不下报叶子缺陷。

```json
{ "type": "component", "name": "timeline",
  "style": { "surface": "none", "separator": "line" },
  "items": [ { "label": "2026", "text": "品类验证" },
             { "label": "2027", "text": "渠道扩张" },
             { "label": "2028", "text": "品牌溢价" } ],
  "slot": { "col": [1, 6], "row": [4, 8] } }
```

- `name` 必须是 `COMPONENT_NAMES` 里的名字（清单见下节）。未知名字报错。
- 组件只读 `frame / theme / skin`：不含客户名、品牌色或参考页文案。样式由 deck 的 `styleTokens` 决定。
- 字段名照抄本文档；未知字段报错。
- `style` 可选，见下节「组件样式」。

## 组件样式（style）与 styleTokens

`style` 是改组件样式的唯一入口。值全部是语义枚举，缺省从风格卡推导（输入 `styleTokens.componentDefaults`）。不写裸色号、裸 pt、裸 px；未知字段报错。

| 字段 | 取值 | 语义 |
|---|---|---|
| `surface` | `none \| card \| tint \| outline \| ink \| band` | 底面语言：无底 / 卡面（描边 + 阴影 + 圆角）/ 主色浅档 / 透明描边 / 墨面反白 / 强调色顶条 |
| `separator` | `line \| gap \| none` | 条目之间：1px 分隔线 / 只留间距 / 什么都不留（风格卡关掉分隔线时 `line` 自动降为 `gap`） |
| `align` | `start \| center` | 文本对齐与整组水平落位 |
| `density` | `tight \| normal \| airy` | 内部间距密度：间距与内边距 ×0.75 / 1 / 1.4 |
| `numeral` | `serif \| sans \| none` | 装饰性序号/年份/大数字：标题字体 / 正文字体 / 去掉装饰序号 |
| `accent` | `primary \| accent \| muted` | 唯一强调位（刻标、顶条、星、目标刻度）取色 |
| `motif` | `inherit \| none` | 是否在有底面的组件上画风格卡母题（色带 / 角标 / 幽灵块）；`inherit` 跟随风格卡，`surface:"none"` 时不重复画 |

**组件专属变体**（每个组件至多一个，全部枚举）：

| 组件 | 变体 | 取值 |
|---|---|---|
| `stats` | `layout` | `row \| column \| grid` |
| `timeline` | `direction` / `axis` | `h \| v` / `line \| dots \| none` |
| `steps` | `connector` | `line \| gap \| none` |
| `chevron` / `pyramid` / `funnel` | `form` | `outline \| filled \| tint` |
| `calloutBox` | `form` | `bar \| panel \| tint` |
| `cycle` | `marker` | `dot \| number` |
| `progress` | `fill` | `ink \| primary` |
| `orgChart` | `connector` | `elbow \| none` |
| `teamGrid` | `avatar` | `circle \| initial` |
| `logoWall` | `monochrome` | `true \| false` |

**styleTokens 语义**（输入字段，是像素口径的唯一真源）：

- `composition`：构图家族（`swiss / editorial / poster / immersive`），决定页面骨架倾向。
- `darkCover`：封面/收尾是否自动深色。
- `motif`：页级母题（色带 / 角标 / 幽灵块）。母题由引擎统一铺，`surface:"none"` 的组件不重复画。
- `palette` / `typeScale` / `fonts` / `spacing` / `decoration`：色板、字号档、字体、间距、装饰口径。所有像素由它们决定。
- `componentDefaults`：组件 `style` 的默认值。省略即继承。

输入里的 `styleBrief` 只是风格意图的散文说明。像素口径与冲突时一律以 `styleTokens` 为准。

**组件语义子集**（哪些 style 真的有差）。组件只表达与自己语义相关的维度，未列出的组合对该组件是 no-op：不报错，也没有视觉变化。默认底面写「卡片」的组件用风格卡卡面；写「平铺」的组件只有显式 `style.surface` 才铺底。

| 组件 | 默认底面 | separator | accent | numeral | 图槽 |
|---|---|---|---|---|---|
| stats | 平铺 | ✓ | ✓ | ✓ | — |
| timeline | 平铺 | 轴线独立控制 | ✓ | ✓（年份字体） | — |
| steps | 平铺 | connector 独立控制 | ✓ | ✓ | — |
| agenda | 平铺 | ✓ | ✓ | ✓ | — |
| pointList | 平铺 | ✓ | ✓ | ✓ | — |
| featureCards | 卡片 | — | ✓ | — | ✓ |
| comparison | 卡片 | ✓ | ✓ | — | — |
| matrix2x2 | 卡片 | ✓ | — | — | — |
| prosCons | 卡片 | ✓ | ✓ | ✓ | — |
| quote | 平铺 | — | ✓（刻标） | ✓（引文字体） | — |
| quotes | 卡片 | — | ✓ | — | ✓ |
| teamGrid | 卡片 | ✓ | ✓ | ✓ | ✓ |
| persona | 卡片 | ✓ | ✓ | ✓ | ✓ |
| bentoGrid | 卡片 | — | ✓ | — | ✓ |
| layeredStack | 卡片 | ✓ | ✓ | ✓ | — |
| pricingTiers | 卡片 | ✓ | ✓ | ✓ | — |
| logoWall | 卡片 | ✓ | — | — | ✓（灰度 contain） |
| indexHeader | 平铺 | ✓ | ✓ | ✓ | — |
| eraRail | 平铺 | ✓（脊线/刻度） | ✓ | ✓ | — |
| progress | 平铺 | — | ✓ | — | — |
| cycle | 平铺 | — | ✓ | ✓ | — |
| chevron / pyramid / funnel | 平铺 | — | ✓ | — | — |
| venn | 平铺 | — | ✓ | — | — |
| calloutBox | 卡片 | — | ✓ | — | — |
| orgChart | 平铺 | — | ✓ | — | — |

## 组件清单

37 个组件 = 27 个核心组件 + 10 个页面原子。名字与引擎 `COMPONENT_NAMES` 一一对应。

| 组件 | 类别 |
|---|---|
| `timeline` | 核心 |
| `steps` | 核心 |
| `stats` | 核心 |
| `featureCards` | 核心 |
| `quote` | 核心 |
| `comparison` | 核心 |
| `matrix2x2` | 核心 |
| `prosCons` | 核心 |
| `agenda` | 核心 |
| `chevron` | 核心 |
| `pyramid` | 核心 |
| `funnel` | 核心 |
| `venn` | 核心 |
| `calloutBox` | 核心 |
| `cycle` | 核心 |
| `progress` | 核心 |
| `orgChart` | 核心 |
| `persona` | 核心 |
| `bentoGrid` | 核心 |
| `layeredStack` | 核心 |
| `teamGrid` | 核心 |
| `quotes` | 核心 |
| `pricingTiers` | 核心 |
| `logoWall` | 核心 |
| `pointList` | 核心 |
| `indexHeader` | 核心 |
| `eraRail` | 核心 |
| `founderProfile` | 原子 |
| `radialFunnel` | 原子 |
| `kpiRows` | 原子 |
| `categoryCards` | 原子 |
| `featureRail` | 原子 |
| `sectionHeader` | 原子 |
| `photoTriptych` | 原子 |
| `competitorBoard` | 原子 |
| `fullBleedQuote` | 原子 |
| `financialBoard` | 原子 |

## 组件参数

「约几元素」是排页时的元素预算参考。同排并列栏共用 `indexHeader` 做栏头；年代/进程序列用 `eraRail`，页脚节奏带优先于零散 caption。

### 27 个核心组件

| 组件 | 形态与语义 | 参数 | 条目与上限 | 约几元素 |
|---|---|---|---|---|
| `timeline` | 轴线串节点，上标签下说明——进程与先后 | `direction?`（`h`/`v`，缺省 h）、`axis?`（`line`/`dots`/`none`）、`items: [{ label, text }]` | 3~6 条；`label` ≤24 字、`text` ≤80 字 | 10~19 |
| `steps` | 大编号 + 标题 + 说明横排——有序步骤 | `connector?`（`line`/`gap`/`none`）、`items: [{ title, text? }]` | 3~5 步；`title` ≤24 字、`text` ≤80 字 | 6~15 |
| `stats` | 大数字 + 标签的指标卡横排——量化基本面 | `layout?`（`row`/`column`/`grid`）、`items: [{ value, unit?, label }]` | 2~4 项；`value` ≤16 字、`unit` ≤8 字、`label` ≤40 字 | 6~12 |
| `featureCards` | 图标或图片 + 标题 + 正文的卡片行——并列卖点 | `items: [{ title, body?, icon?, image? }]` | 2~4 张；`title` ≤30 字、`body` ≤200 字；给 `image`（http(s) 直链或 `everroom-material://`）时顶部画圆角图块，`icon` 不画 | 4~16 |
| `quote` | 大引号 + 居中引文 + 署名——引用定调 | `text`、`author?` | `text` ≤200 字、`author` ≤40 字 | 2~3 |
| `comparison` | 2~4 方对照，中央分隔随 `style.separator`——多方横评 | `sides: [{ title, tag?, points }]`、`featured?`（重点列下标，0 起） | 2~4 方；`title` ≤24 字、`tag` ≤8 字；每方 2~5 点，单点 ≤60 字；点是字符串或 `{ text, mark: "yes"\|"mid"\|"no" }` | 6~20 |
| `matrix2x2` | 四块面板田字格 + 四边轴标——双维度交叉定位 | `quadrants: [{ title, points? }] ×4`、`axes?: { top?, right?, bottom?, left? }` | 象限固定 4 个；`title` ≤24 字；每象限 1~4 点，单点 ≤40 字；轴标各 ≤20 字 | 8~20 |
| `prosCons` | 左优势右风险两栏，钩/叉图标打头——利弊清单 | `pros`、`cons`: 字符串数组 | 各 2~5 条，单条 ≤60 字 | 4+2×条数 |
| `agenda` | 大编号 + 条目纵列，超四条分两栏——目录 | `items`: 字符串数组 | 4~8 条，单条 ≤24 字 | 2×条数 |
| `chevron` | 箭头形横排相扣，文字压箭头上——单向推进 | `form?`、`items: [{ title, text? }]` | 3~5 段；`title` ≤16 字、`text` ≤40 字 | 6~15 |
| `pyramid` | 顶三角 + 梯形逐层加宽——层级与体量 | `form?`、`items: [{ title, text? }]`（顶到底） | 3~5 层；`title` ≤16 字、`text` ≤40 字 | 6~15 |
| `funnel` | 横条逐级收窄，每级阶段 + 数值——转化收窄 | `form?`、`items: [{ stage, value? }]` | 3~4 级；`stage` ≤16 字、`value` ≤16 字 | 6~12 |
| `venn` | 两交叠圆 + 两侧与交集标签——交集关系 | `a`、`b`、`both?` | 各 ≤10 字 | 3~4 |
| `calloutBox` | 主题色底板 + 一句加粗结论——单点强调 | `text`、`icon?`、`form?` | `text` ≤120 字 | 2~3 |
| `cycle` | 中央圆环 + 节点圆均匀分布——循环互驱 | `marker?`、`items: [{ title }]` | 3~5 个；每题 ≤6 字 | 1+2×个数 |
| `progress` | 标签行 + 轨道条与前景条——完成度 | `fill?`、`items: [{ label, value, unit?, target? }]` | 2~4 项；`label` ≤24 字、`unit` ≤8 字；`value` / `target` 是 0~100 数字 | 4×项数 |
| `orgChart` | 根在上、子横排、细线连接——隶属结构 | `connector?`、`root`、`children`: `{ title, subtitle? }` | 子节点 2~4 个；`title` ≤20 字、`subtitle` ≤30 字 | 10~16 |
| `persona` | 左头像圆 + 右姓名/角色/要点——人物画像 | `person: { name, role? }`、`points`、`image?` | 要点 2~5 条，单条 ≤40 字；`name` ≤24 字、`role` ≤40 字 | 4~6 |
| `bentoGrid` | 两列格子拼版，`wide` 占整行——信息拼贴 | `items: [{ title, body?, icon?, image?, wide? }]` | 3~5 格；`title` ≤24 字、`body` ≤120 字；`wide: true` 占整行 | 6~20 |
| `layeredStack` | 整宽横条逐层堆叠，左标题右说明——分层堆叠 | `items: [{ title, text? }]` | 3~5 层；`title` ≤16 字、`text` ≤60 字 | 6~15 |
| `teamGrid` | 圆头像 + 姓名 + 职位（主色）+ 两行简介——团队网格 | `avatar?`、`members: [{ name, role?, bio?, image? }]` | 2~6 人（≤4 人单行，5~6 人两行各 3）；`name` ≤16 字、`role` ≤24 字、`bio` ≤48 字 | ~4×人数 |
| `quotes` | 星级 + 引文 + 条目分隔（随 `style.separator`）+ 头像署名——评价墙 | `items: [{ text, name, role?, avatar?, rating? }]` | 2~3 条；`text` ≤90 字、`name` ≤16 字、`role` ≤28 字；`rating` 是 1~5 整数 | 6~10×条数 |
| `pricingTiers` | 套餐定价卡，`featured` 档垫板描边上浮 + 实心按钮 | `tiers: [{ name, price, unit?, features, cta? }]`、`featured`（必填，恰一个） | 2~4 档；`name` ≤12 字、`price` ≤12 字、`unit` ≤10 字、`cta` ≤8 字；每档 2~4 条特性，单条 ≤24 字 | ~7×档数+3 |
| `logoWall` | 灰度图标/文字字标网格——客户墙 | `monochrome?`、`logos: [{ image?, text? }]`（二选一，至少一个） | 4~8 个；`text` ≤20 字；图自动灰度 contain | ≤8 |
| `pointList` | 刻度要点纵列：可选衬线序号 + 粗标签 + 静音正文，条目分隔随 `style.separator`——分类词条、要点清单 | `items: [{ label, body }]`、`numbered?: true` | 2~5 条；`label` ≤12 字、`body` ≤140 字；`numbered` 只接受 `true` | 5~17 |
| `indexHeader` | 衬线序号（主色）+ 标题 + 右侧小注，底部分隔随 `style.separator`——并列栏统一栏头 | `num`（1~2 字，如 壹/儒/01）、`title`、`note?` | `title` ≤12 字、`note` ≤12 字 | 3~4 |
| `eraRail` | 脊线压区域顶，刻度下挂衬线年代 + 静音短注，`highlight` 条目主色——年代轴、节奏带 | `items: [{ era, note }]`、`highlight?`（重点条下标） | 3~6 条；`era` ≤8 字、`note` ≤12 字，各限一行 | 1+3×条数 |

### 10 个页面原子

页面原子只用下表的字段。它们不走核心组件的参数校验：内容放不下时报叶子缺陷（`LAYOUT_LEAF_INVALID`），提示要精简的字段写在括号里。`style` 语义同核心组件。

| 组件 | 形态与语义 | 参数 | 条目与上限 |
|---|---|---|---|
| `founderProfile` | 创始人履历：左轨节点 + 章节正文 + 底部技能条 | `personName`（必填）、`role?`、`subtitle?`、`variant?`（`timeline` 默认 / `resume` 左轨更宽）、`showHeader?`（`false` 时只画正文，页面已有 `sectionHeader`）、`sections: [{ label?, heading, bullets?, columns?, timeline?, weight? }]`、`skills?: [{ title, text }]` | `sections` 每段给 `bullets` 或 `columns: [{ title, meta?, text }]`（columns 画横向公司时间轴，`timeline: false` 关掉）；`weight` 0.5~2.2（引擎夹取）；正文每行不足 44px 报错——减 `sections`；单栏文字超高报错——精简 `columns` 或 `bullets` |
| `radialFunnel` | 中心辐射 → 漏斗汇聚 → 结论 | `centerTitle`（必填）、`centerSubtitle?`、`satellites: string[]`、`bridge?`、`conclusionTitle`（必填）、`conclusionBody?`、`footnote?` | `satellites` 最多画 6 个（超出丢弃）；`bridge` 是中心与结论之间的桥接字 |
| `kpiRows` | 左标签胶囊 + 大数字 + 注脚，逐行列出 | `rows: [{ label, value, note? }]` | 行高不足 28px 报错——减少 `rows` |
| `categoryCards` | 四栏「标题条 + 图形 + 指标」卡，无照片时的图像卡替代 | `items: [{ title, metric, note?, imageUrl? }]` | `title` 画顶部标题条；给 `imageUrl` 时卡片下半画图，否则画 `metric` 大数字 |
| `featureRail` | 产品特征页：左侧参数块 + 中间曲线节点 + 右侧说明 | `params: [{ label, value }]`、`features: [{ title, text }]`、`imageUrl?` | 每行不足 54px 报错——减少 `features`；说明文字超高报错——精简 `text`；给 `imageUrl` 时左上画图与同心圆注记 |
| `sectionHeader` | 三枚 chevron + 标题 + 副标题的章节头 | `title`（必填）、`subtitle?`、`marker?` | `marker: false` 不画 chevron；标题超宽报错——缩短标题 |
| `photoTriptych` | 三张满版图片并排，标签压在图上 | `images: [{ url, label? }]`、`overlay?`、`labelMode?`（`overlay` 默认 / `none`） | `images` 最多画 3 张（超出丢弃）；`overlay: true` 压一层深色罩 |
| `competitorBoard` | 竞品行：厂商 / 产品图 / 特点胶囊 / 市场数据 | `competitors: [{ name, imageUrl?, tags: string[], facts: string[] }]` | 最多画 3 家（超出丢弃）；表头固定为厂商/产品/特点/市场情况；行高不足 60px 报错——减少 `competitors`；`facts` 超高报错——精简 `facts` |
| `fullBleedQuote` | 满版图片 + 居中大字，文字位置由组件锁住 | `imageUrl`（必填）、`kicker?`、`titleLines: string[]`、`subtitle?`、`caption?`、`overlay?` | `titleLines` 逐行居中，引擎按最长行自动缩字；`overlay: false` 关掉压暗罩（默认压） |
| `financialBoard` | 财务页：左财务表 + 右销量柱 + 底部资金用途 | `columns: string[]`、`rows: string[][]`、`chart: { categories: string[], values: number[] }`、`funding: [{ label, value }]`、`caption?` | `rows` 首列左对齐、其余居中；`chart.values` 与 `chart.categories` 一一对应；`funding` 每项一条底部格子 |

## Composition 硬约束（validate 会拒收）

| composition | 必须 |
|---|---|
| immersive | 至少一个 `image` 节点带 bleed（页面级） |
| hero-data | 至少一个 `token:"hero"` 的 text 或一个 chart |
| editorial | 至少一个 image + 一个 `h1`/`h2` |
| poster / chapter | 至少一个 `token:"display"` |
| swiss | 无额外要求 |

约束统计递归到 group 子节点。

## 内容纪律

1. 文案以输入 `copy` 为准：主标题必须用 `copy.message`（v2 输入不提供 planner 标题）；`kicker` / `supporting` / `facts` / `quote` / `source` 各就各位；不改写、不加句。
2. 不重复：message 说过的不要再做 supporting。
3. 一页一个视觉锚点（emphasis）：image / 大数字 / 引语 / chart / table。
4. 全出血 cover、quote 图必须叠 60~80% 深色 scrim 或压暗图。反白标题在亮天空、浅背景上仍要可读。
5. 相邻页 composition 不同；整册至少 3 种。
6. 先按 composition 定骨架，再填 slot。分区从大块到小块，一次只切一层。
7. 表格页用 `table`：参数表、成本表、竞品表、财务表都走 table。

## 页面密度与骨架

内容页至少 4 个模块：标题、结论标题、主内容、底部结论或导航。

普通页优先 slot；slot 表达不了的自由版式用 `group`，页面级元素关系用 `connector`。

无图片时用 icon/path/shape/table/chart/component 建立视觉锚点。有图片时优先让图片承担证据，文字只做结论和注释。具体用哪种页眉、色彩和图片处理，由 `styleTokens` 与当前 style pack 决定；不要把任何客户风格写进本技能。

标题不要只放一行裸 h1：kicker 前加一条 24~40px 的 primary 短线（shape），或把 kicker 放进 primarySoft 色块；标题区与内容区用一条细分隔线（shape）分开。数据/表格页在标题右侧放一个「结论数字/关键词」小色块，避免左侧一大片空白。

## 视觉丰富度闸门

内容/数据/表格/流程页不能只有文字 + 白底。validate 要求至少一个 `icon / path / image / chart / table / stats / component`，或一条**非全屏**的 shape（短线/色块/分隔）。group 是分区容器，不是视觉锚点：统计递归到子节点，只有 text 的 group 不算有图形。

输入带 `revisionFeedback` 时，按它补视觉锚点后重新 validate。

## 校验

调 `slides_layout_validate`，传 `deckToken` 与整页 JSON。有缺陷按每条缺陷的 `path` 定位节点、按 `hint` 修，重交整页。最多 3 轮。

`ok=true` 后调 `slides_page_preview`（传 deckToken/pageIndex/当前树）。它临时渲染单页，返回确定性 defects 与设计审阅。预览只读，不写当前 deck；多页并发不会互相踩。

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
      { "value": "5.5", "unit": "%", "label": "「十四五」年均增速" }
    ], "slot": { "col": [9, 12], "row": [2, 8] } }
  ]
}
```
