---
name: layout-tree-skill
description: 布局树语法与设计纪律——容器/叶子词汇表、比例与缝隙、role×density 骨架策略、data 行内格式翻译、防平庸与收敛规则
---

# 布局树（LayoutTree）

页面是一棵递归嵌套的容器树。你只写结构与比例；坐标/字号/配色由引擎按 deck 契约确定性计算。

## 语法

### 根节点（root）

```json
{
  "role": "content",
  "title": "页标题（进固定标题带）",
  "dark": false,
  "direction": "row",
  "weights": [1.6, 1],
  "gapScale": 1.5,
  "pad": 16,
  "children": []
}
```

- `role`：照抄输入的 role。
- `title`：输入有 `title` 时填上（标题带自动渲染，不算 children）。封面/章节页可省略 title、设 `dark: true`，把大标题作为 `display` 文字叶子排进版面。
- `direction` / `weights` / `gapScale` / `pad`：同容器。

### 容器节点

```json
{ "direction": "row | column", "weights": [2, 1], "gapScale": 1.5, "pad": 16, "children": [] }
```

- `direction`：row＝左右分，column＝上下分。
- `weights`：子区域比例（正数，个数＝children 数；缺省均分）。悬殊比例用 1.6/1、2/1、3/1 这一档，别超过 20。
- `gapScale`：缝隙倍率（0~4，0＝无缝贴齐，2＝呼吸感）。
- `pad`：容器内边距（0~48px）。
- `children`：1~12 个节点（容器或叶子），嵌套层级不设上限。

### 叶子节点（六种）

| 叶子 | 字段 | 说明 |
|---|---|---|
| `text` | `variant`（display/heading/subtitle/body/caption）、`text`（\n 分段）、`align?`、`bullet?`、`tone?`（normal/muted/inverse） | 字号由 variant 定档；display 用于封面主标题，body 是正文 |
| `image` | `url`、`contain?` | 缺省 cover（裁切填满）；`contain: true` 完整呈现（可能留空带）。两者都不变形；框比例尽量贴近图比例 |
| `card` | KPI 卡：`value`+`label`+`unit?`；文字卡：`title`+`body?`+`icon?` | KPI 卡给数字页用；文字卡给要点分组 |
| `path` | `d`（SVG path） | 装饰性自由路径，默认主题浅色填充 |
| `chart` | `kind`、`categories`、`series`（name+values） | kind: bar/barStacked/line/pie/doughnut/scatter/comboBarLine（≥2 系列）；values 与 categories 等长 |
| `table` | `rows`（首行表头，2~12 行、2~8 列）、`colWidths?`、`style?`（lines/darkHeader/zebra） | 单元格是字符串或 {text, bold?, align?} |

### 上限（引擎硬约束，超了 validate 会报）

元素总数 48、图片 8、路径 4、单文本 2000 字符、图表类目 2~24、表格 12 行 8 列。

## data 行内格式翻译

输入 `data` 按约定格式解析后装进对应叶子：

- 图表行「`bar | categories: 2023, 2024 | 营收: 1.2, 1.8`」→ `chart` 叶子（kind=bar）。
- 表格行「`维度 | 本品 | 竞品A`」每行一条 → `table` 叶子的 rows。
- KPI 行「`指标名: 数值 单位`」→ `card` 叶子（value=数值，unit=单位，label=指标名）。

## 设计纪律

### role 决定骨架气质

- **cover / closing**：`dark: true`，无 title 带；display 主标题 + subtitle 副题，居中或大留白不对称。
- **toc**：目录项分两列或单列加编号节奏（列容器 weights 1:1 或 62:38）。
- **section**：`dark: true`；大号章节题 + 极简（sparse）。
- **content**：变化最多的一类——图文左右分（图占 38~62）、要点分组卡、引用块、上下二段。
- **data / table**：KPI 行（card×2~4 等分）+ 图表主体上下分；表格页整幅 table 或表格+侧栏结论。
- **flow**：步骤卡横排（等分或递进 weights）、里程碑竖排。
- **quote**：大引用居中 + 署名 caption，pad 加大（32）。

### density 决定留白

- sparse：少分区（≤3 叶子）、大 pad、大 gapScale。
- standard：常规 3~6 叶子。
- dense：多分区、小缝隙，但守上限与最小区域（约 96×64px，权重太悬殊 validate 会报 min_size）。

### 防平庸

1. 禁止每页同一副骨架。常用变化轴：方向（row↔column）、权重（50/50↔62/38↔70/30）、层级（平铺↔分组嵌套）、留白位置（上紧下松↔左右不对称）。
2. 相邻页别同构；重排任务给了 `neighborSignatures` 时必须避开。
3. 数字对比页（如「31% vs 68%」）用两个 KPI 卡对置（weights 反差放大主数字）。
4. 单页只有一个孤立要点时，用大字+装饰 path 或大留白，不堆空白框。

### 收敛

validate 缺陷的典型修法：

- `overflow`（文字超出区域）：加大该子树 weights、精简 text、或把一个大 text 拆成多个小 text 装进分区。
- `min_size`：减少兄弟节点或调平 weights。
- `image_ar`：调图片叶所在区域的比例贴近图，或改用 cover。
- `element_cap`：删装饰性 path、合并碎卡。

3 轮修不完就简化整树：减叶子、减层级，朴素优先于破碎。
