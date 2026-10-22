<!-- description: 幻灯片布局语法——v2 是唯一写入格式：version 2 / composition / 12×8 slot / bleed / type token / text / image / icon / path / table / stats / chart / shape / connector / group 分区 / 37 个组件参数 / 内容纪律与硬约束；只设计单页，坐标由引擎计算 -->

# 缺陷自纠手册

validate 与预览返回的每条缺陷都带 `path` 与 `hint`。按 `path` 定位节点，按 `hint` 改一处，再重交整页。

## 常见缺陷与改法

| 缺陷 | 典型改法 |
|---|---|
| `schema`（含 `V2_INVALID`） | 字段名、枚举、必填项写错，或写了自造字段。照权威正文改字段名与取值。 |
| `overflow`（文字超出 slot） | 精简文案；加大该节点的 slot 行区间；把一个大 text 拆成两个 text。`fit: "shrink"` 只用在标题类节点上。 |
| `min_size`（区域过小） | 缩小相邻 slot、减少同页节点数，或把内容挪进 `group` 用 `weight` 分比例。 |
| `element_cap`（元素/图片/路径超限） | 删装饰 path，合并碎卡，把多个 icon 换成一个 `component`。 |
| `image_ar`（图片比例失真） | 让图片 slot 贴近素材长宽比；或改 `fit: "contain"`。 |
| `contrast`（压图文字不可读） | 给图片节点加 `scrim`（`opacity` 0.6~0.8），压图文字改 `tone: "inverse"`。 |
| `emoji` | 删除 emoji。装饰用 `path`，图标用 `icon`。 |
| 预览 major（weak_hierarchy / flat_background / no_visual_anchor / text_wall / cramped / empty_space） | 按名改树：补视觉锚点（icon/path/shape/table/chart/component）、拉开层级（token 降档）、拆文字墙、给空白区补内容或收窄 slot。 |

## 顺序

1. 先修 `schema` 与硬约束，再修 `overflow`、`min_size`。
2. 一次只改被指出的节点，其余结构不动。
3. 3 轮修不完就简化整页：减节点、减层级、减 group 嵌套。朴素优先于破碎。
