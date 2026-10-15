---
name: layout-tree-skill
description: 布局树语法与硬约束——容器/叶子词汇表、比例/缝隙/justify 打包、data 行内格式翻译、多样性与收敛规则
---

# 布局树（LayoutTree）

页面是一棵递归嵌套的容器树。你只写结构与比例；坐标/字号/配色由引擎按 deck 契约确定性计算。每页版式由这页的内容决定——信息密度、数字量级、图文关系、对比结构，都应反映到你给的分区方式上。

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

- `role`：照抄输入的 role（内容语义标签）。
- `title`：填输入的 `title`（标题带自动渲染，不算 children）。需要整页构图时可省略 title、设 `dark: true`，把大标题作为 `display` 文字叶子排进版面。
- `direction` / `weights` / `gapScale` / `pad` / `justify`：同容器。

### 容器节点

```json
{ "direction": "row | column", "weights": [2, 1], "gapScale": 1.5, "pad": 16, "justify": "center", "children": [] }
```

- `direction`：row＝左右分，column＝上下分。
- `weights`：子区域比例（正数，个数＝children 数；缺省均分）。悬殊比例用 1.6/1、2/1、3/1 这一档，别超过 20。
- `gapScale`：缝隙倍率（0~4，0＝无缝贴齐，2＝呼吸感）。
- `pad`：容器内边距（0~48px）。
- `justify`（仅 column）：主轴打包 start/center/end。设置后子节点按内容排：text 叶子取自然高、其余叶子均分剩余空间，整组按 start/center/end 落位——适合「一组内容居中或沉底」。缺省按 weights 分满全高。
- `children`：1~12 个节点（容器或叶子），嵌套层级不设上限。

### 叶子节点（六种）

| 叶子 | 字段 | 说明 |
|---|---|---|
| `text` | `variant`（display/heading/subtitle/body/caption）、`text`（\n 分段）、`align?`、`bullet?`、`tone?`（normal/muted/inverse） | 字号由 variant 定档；display 最大、body 是正文 |
| `image` | `url`、`contain?` | 缺省 cover（裁切填满）；`contain: true` 完整呈现（可能留空带）。两者都不变形；框比例尽量贴近图比例 |
| `card` | KPI 卡：`value`+`label`+`unit?`；文字卡：`title`+`body?`+`icon?` | 两种卡按内容选用 |
| `path` | `d`（SVG path） | 装饰性自由路径，默认主题浅色填充 |
| `chart` | `kind`、`categories`、`series`（name+values） | kind: bar/barStacked/line/pie/doughnut/scatter/comboBarLine（≥2 系列）；values 与 categories 等长 |
| `table` | `rows`（首行表头，2~12 行、2~8 列）、`colWidths?`、`style?`（lines/darkHeader/zebra） | 单元格是字符串或 {text, bold?, align?} |

### 上限与硬约束（引擎限制，超了 validate 会报）

元素总数 48、图片 8、路径 4、单文本 2000 字符、图表类目 2~24、表格 12 行 8 列。

**文本只写文字**：emoji（含符号表情字符）会被引擎整页拒绝——装饰图形用 path 叶子。

## data 行内格式翻译

输入 `data` 按约定格式解析后装进对应叶子：

- 图表行「`bar | categories: 2023, 2024 | 营收: 1.2, 1.8`」→ `chart` 叶子（kind=bar）。
- 表格行「`维度 | 本品 | 竞品A`」每行一条 → `table` 叶子的 rows。
- KPI 行「`指标名: 数值 单位`」→ `card` 叶子（value=数值，unit=单位，label=指标名）。

## 设计纪律

### 输入信号

`role` 与 `density` 是 planner 对这页的内容语义与密度意图：这页在讲什么、信息量多大。设计分区时消化它们。

### 多样性

1. 每页一副新骨架。变化轴任选：方向（row↔column）、权重（50/50↔62/38↔70/30↔更悬殊）、层级（平铺↔分组嵌套）、留白位置、justify 打包。
2. 相邻页不同构；重排任务给了 `neighborSignatures` 时避开其中每一个。

### 收敛

validate 缺陷的典型修法：

- `overflow`（文字超出区域 / justify 打包超高）：加大该子树 weights、精简 text、把大 text 拆成多个小 text、或调整 justify。
- `min_size`：减少兄弟节点或调平 weights。
- `image_ar`：调图片叶所在区域的比例贴近图，或改用 cover。
- `element_cap`：删装饰性 path、合并碎卡。

3 轮修不完就简化整树：减叶子、减层级，朴素优先于破碎。
