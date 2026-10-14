/**
 * LayoutTree：布局代理输出的递归嵌套布局树。
 * 全树只有结构与比例（方向/权重/缝隙/内边距），没有任何像素坐标。
 * 坐标由 compile.ts 确定性计算；报错文案面向模型自纠（沿用 PRESET_INVALID 风格）。
 */

export type Direction = "row" | "column";
export type TextAlign = "left" | "center" | "right";
export type TextTone = "normal" | "muted" | "inverse";
export type TableStyle = "lines" | "darkHeader" | "zebra";

export interface TextLeaf {
  type: "text";
  variant: "display" | "heading" | "subtitle" | "body" | "caption";
  text: string;
  align?: TextAlign;
  bullet?: boolean;
  tone?: TextTone;
}

export interface ImageLeaf {
  type: "image";
  url: string;
  /** true=完整放框（contain，可能留空带）；缺省=裁切填满（cover）。两种都不变形。 */
  contain?: boolean;
}

export interface CardLeaf {
  type: "card";
  /** KPI 卡：value 大数字 + label 标签（value 存在时 title/body 不用）。 */
  value?: string;
  unit?: string;
  label?: string;
  /** 文字卡：title + 可选 body/icon。 */
  title?: string;
  body?: string;
  icon?: string;
}

export interface PathLeaf {
  type: "path";
  d: string;
}

export type ChartKind = "bar" | "barStacked" | "line" | "pie" | "doughnut" | "scatter" | "comboBarLine";

export interface ChartLeaf {
  type: "chart";
  kind: ChartKind;
  categories: string[];
  series: { name: string; values: number[] }[];
  legend?: boolean;
}

export interface TableLeaf {
  type: "table";
  rows: (string | { text: string; bold?: boolean; align?: TextAlign })[][];
  colWidths?: number[];
  style?: TableStyle;
}

export type LeafNode = TextLeaf | ImageLeaf | CardLeaf | PathLeaf | ChartLeaf | TableLeaf;

export interface ContainerNode {
  direction: Direction;
  /** 子区域比例（正数，长度须等于 children 数；缺省均分）。 */
  weights?: number[];
  /** 缝隙 = gutter × gapScale（0=无缝）。 */
  gapScale?: number;
  /** 容器内边距（px）。 */
  pad?: number;
  children: TreeNode[];
}

/** 页根节点：内容区容器 + 页元数据。 */
export interface LayoutTree {
  role: string;
  /** 页标题（进固定标题带）；封面/章节等整页构图可省略，标题作为 display 文字叶子排进版面。 */
  title?: string;
  /** 深色页（封面/章节）：背景用 darkBackground，文字自动换 onDarkText。 */
  dark?: boolean;
  direction: Direction;
  weights?: number[];
  gapScale?: number;
  pad?: number;
  children: TreeNode[];
}

export type TreeNode = ContainerNode | LeafNode;

export function isLeaf(node: TreeNode): node is LeafNode {
  return typeof (node as LeafNode).type === "string";
}

const MAX_TEXT = 2000;
const MAX_CHILDREN = 12;
const MAX_TOTAL_NODES = 200;
const CHART_KINDS: ChartKind[] = ["bar", "barStacked", "line", "pie", "doughnut", "scatter", "comboBarLine"];
const TEXT_VARIANTS = ["display", "heading", "subtitle", "body", "caption"] as const;

class TreeError extends Error {}

function bad(message: string): never {
  throw new TreeError(`LAYOUT_TREE_INVALID: ${message}`);
}

function asNode(value: unknown, path: string): TreeNode {
  spendBudget(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`${path} 必须是对象`);
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") return asLeaf(node, path);
  if (node.direction === "row" || node.direction === "column") return asContainer(node, path);
  bad(`${path} 无法识别：既不是叶子（缺 type）也不是容器（缺 direction）`);
}

function asLeaf(node: Record<string, unknown>, path: string): LeafNode {
  switch (node.type) {
    case "text": {
      const text = requiredText(node.text, `${path}.text`);
      const variant = node.variant;
      if (typeof variant !== "string" || !(TEXT_VARIANTS as readonly string[]).includes(variant)) {
        bad(`${path}.variant 必须是 ${TEXT_VARIANTS.join("|")}，收到 ${String(variant)}`);
      }
      const align = node.align;
      if (align !== undefined && !["left", "center", "right"].includes(align as string)) bad(`${path}.align 必须是 left|center|right`);
      const tone = node.tone;
      if (tone !== undefined && !["normal", "muted", "inverse"].includes(tone as string)) bad(`${path}.tone 必须是 normal|muted|inverse`);
      const leaf: TextLeaf = { type: "text", variant: variant as TextLeaf["variant"], text };
      if (align) leaf.align = align as TextAlign;
      if (node.bullet === true) leaf.bullet = true;
      if (tone) leaf.tone = tone as TextTone;
      return leaf;
    }
    case "image": {
      const url = requiredText(node.url, `${path}.url`);
      if (!/^(https?:\/\/|everroom-material:\/\/)/i.test(url)) {
        bad(`${path}.url 只接受 http(s) 直链或 everroom-material:// 素材引用，收到 ${url.slice(0, 60)}`);
      }
      return { type: "image", url, ...(node.contain === true ? { contain: true } : {}) };
    }
    case "card": {
      const value = optionalText(node.value, 16);
      const title = optionalText(node.title, 30);
      if (!value && !title) bad(`${path} 卡叶子必须有 value（KPI 卡）或 title（文字卡）`);
      if (value) {
        const label = optionalText(node.label, 40);
        if (!label) bad(`${path} KPI 卡必须有 label（数字下方的标签）`);
        const unit = optionalText(node.unit, 8);
        return { type: "card", value, label: label!, ...(unit ? { unit } : {}) };
      }
      const body = optionalText(node.body, 200);
      const icon = optionalText(node.icon, 40);
      return { type: "card", title: title!, ...(body ? { body } : {}), ...(icon ? { icon } : {}) };
    }
    case "path": {
      const d = requiredText(node.d, `${path}.d`);
      return { type: "path", d };
    }
    case "chart": {
      const kind = node.kind;
      if (typeof kind !== "string" || !CHART_KINDS.includes(kind as ChartKind)) {
        bad(`${path}.kind 必须是 ${CHART_KINDS.join("|")}，收到 ${String(kind)}`);
      }
      const categories = stringArray(node.categories, `${path}.categories`, 2, 24, 24);
      const seriesRaw = node.series;
      if (!Array.isArray(seriesRaw) || seriesRaw.length < 1 || seriesRaw.length > 6) bad(`${path}.series 必须是 1~6 项的数组`);
      const series = (seriesRaw as Record<string, unknown>[]).map((s, i) => {
        const name = requiredText(s.name, `${path}.series[${i}].name`).slice(0, 20);
        const values = s.values;
        if (!Array.isArray(values) || values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          bad(`${path}.series[${i}].values 必须全是数字`);
        }
        if ((values as number[]).length !== categories.length) {
          bad(`${path}.series[${i}].values 数量（${(values as number[]).length}）必须等于 categories（${categories.length}）`);
        }
        return { name, values: values as number[] };
      });
      if (kind === "comboBarLine" && series.length < 2) bad(`${path} comboBarLine 必须至少 2 个系列`);
      return { type: "chart", kind: kind as ChartKind, categories, series, ...(node.legend === true ? { legend: true } : {}) };
    }
    case "table": {
      const rowsRaw = node.rows;
      if (!Array.isArray(rowsRaw) || rowsRaw.length < 2 || rowsRaw.length > 12) bad(`${path}.rows 必须是 2~12 行（表头+数据）`);
      const colCount = Array.isArray(rowsRaw[0]) ? (rowsRaw[0] as unknown[]).length : -1;
      if (colCount < 2 || colCount > 8) bad(`${path} 表头必须是 2~8 列`);
      const rows = (rowsRaw as unknown[][]).map((row, r) => {
        if (!Array.isArray(row) || row.length !== colCount) bad(`${path}.rows[${r}] 列数必须与表头一致（${colCount} 列）`);
        return row.map((cell) => {
          if (typeof cell === "string") return cell.slice(0, 300);
          if (typeof cell === "object" && cell !== null && typeof (cell as { text?: unknown }).text === "string") {
            const c = cell as { text: string; bold?: boolean; align?: "left" | "center" | "right" };
            return { text: c.text.slice(0, 300), ...(c.bold !== undefined ? { bold: c.bold } : {}), ...(c.align ? { align: c.align } : {}) };
          }
          bad(`${path}.rows[${r}] 的单元格必须是字符串或 {text,...}`);
        });
      });
      let colWidths: number[] | undefined;
      if (node.colWidths !== undefined) {
        const cw = node.colWidths;
        if (!Array.isArray(cw) || cw.length !== colCount || cw.some((v) => typeof v !== "number" || v <= 0)) {
          bad(`${path}.colWidths 长度必须等于列数（${colCount}）且全为正数`);
        }
        colWidths = cw as number[];
      }
      const style = node.style;
      if (style !== undefined && !["lines", "darkHeader", "zebra"].includes(style as string)) {
        bad(`${path}.style 必须是 lines|darkHeader|zebra`);
      }
      const leaf: TableLeaf = { type: "table", rows };
      if (colWidths) leaf.colWidths = colWidths;
      if (style) leaf.style = style as TableStyle;
      return leaf;
    }
    default:
      bad(`${path}.type 必须是 text|image|card|path|chart|table，收到 ${String(node.type)}`);
  }
}

function asContainer(node: Record<string, unknown>, path: string): ContainerNode {
  const direction = node.direction as Direction;
  const childrenRaw = node.children;
  if (!Array.isArray(childrenRaw) || childrenRaw.length < 1) bad(`${path}.children 至少 1 项`);
  if (childrenRaw.length > MAX_CHILDREN) bad(`${path}.children 最多 ${MAX_CHILDREN} 项，收到 ${childrenRaw.length}——拆层级或精简`);
  const children = childrenRaw.map((child, i) => asNode(child, `${path}/${i}`));
  const weights = normalizeWeights(node.weights, children.length, path);
  return {
    direction,
    ...(weights ? { weights } : {}),
    ...normalizeGapScale(node.gapScale, path),
    ...normalizePad(node.pad, path),
    children,
  };
}

function normalizeWeights(raw: unknown, count: number, path: string): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) bad(`${path}.weights 必须是数字数组`);
  if (raw.length !== count) bad(`${path}.weights 长度（${raw.length}）必须等于 children 数（${count}）`);
  return (raw as unknown[]).map((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`${path}.weights[${i}] 必须是正数`);
    if ((v as number) > 20) bad(`${path}.weights[${i}] 最大 20（比例悬殊用 pad 调呼吸感，别用 100:1）`);
    return v as number;
  });
}

function normalizeGapScale(raw: unknown, path: string): { gapScale?: number } {
  if (raw === undefined) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 4) bad(`${path}.gapScale 必须是 0~4`);
  return raw === 1 ? {} : { gapScale: raw };
}

function normalizePad(raw: unknown, path: string): { pad?: number } {
  if (raw === undefined) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 48) bad(`${path}.pad 必须是 0~48`);
  return raw === 0 ? {} : { pad: raw };
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) bad(`缺少 ${what}（非空字符串）`);
  return value.trim().slice(0, MAX_TEXT);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function stringArray(raw: unknown, what: string, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) bad(`${what} 必须是 ${min}~${max} 项的数组`);
  return (raw as unknown[]).map((item, i) => {
    if (typeof item !== "string" || !item.trim()) bad(`${what}[${i}] 必须是非空字符串`);
    return item.trim().slice(0, itemMax);
  });
}

let nodeBudget = 0;

function spendBudget(path: string): void {
  nodeBudget += 1;
  if (nodeBudget > MAX_TOTAL_NODES) {
    bad(`节点总数超过 ${MAX_TOTAL_NODES}（在 ${path} 附近）——层级过碎，合并兄弟节点`);
  }
}

/** 宽松归一：结构/类型/上限校验 + 字段清洗。错误以 LAYOUT_TREE_INVALID 开头回传模型自纠。 */
export function normalizeTree(raw: unknown): LayoutTree {
  nodeBudget = 0;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("树根必须是对象");
  const root = raw as Record<string, unknown>;
  const role = typeof root.role === "string" && root.role.trim() ? root.role.trim().slice(0, 24) : "content";
  const title = optionalText(root.title, 80);
  if (root.direction !== "row" && root.direction !== "column") bad("root.direction 必须是 row|column");
  const childrenRaw = root.children;
  if (!Array.isArray(childrenRaw) || childrenRaw.length < 1) bad("root.children 至少 1 项");
  if (childrenRaw.length > MAX_CHILDREN) bad(`root.children 最多 ${MAX_CHILDREN} 项`);
  spendBudget("root");
  const children = childrenRaw.map((child, i) => asNode(child, `root/${i}`));
  const weights = normalizeWeights(root.weights, children.length, "root");
  return {
    role,
    ...(title ? { title } : {}),
    ...(root.dark === true ? { dark: true } : {}),
    direction: root.direction,
    ...(weights ? { weights } : {}),
    ...normalizeGapScale(root.gapScale, "root"),
    ...normalizePad(root.pad, "root"),
    children,
  };
}

/** 归一失败的错误类型（validate 工具据此转缺陷）。 */
export function isTreeError(error: unknown): error is TreeError {
  return error instanceof TreeError;
}
