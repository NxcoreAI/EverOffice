/**
 * 树叶子的渲染器：把叶子 + 框 → PageSpec 元素。
 * 构件迁自旧 preset-common.ts / presets/data.ts（预设库已删，此处为唯一出处）。
 * 装不下的报错会被 compile.ts 转成缺陷清单回传布局代理自纠。
 */

import type { Frame } from "../grid.js";
import {
  bodyRuns,
  card,
  headingRuns,
  textElement,
  type ChartElement,
  type PageSpec,
  type SpecElement,
  type TableElement,
  type TableCell,
} from "../elements.js";
import type { ResolvedTheme } from "../theme.js";
import {
  estimateLineHeight,
  estimateLines,
  estimateTextWidth,
  singleLineBoxHeight,
  textBoxHeight,
} from "../text-metrics.js";
import type { CardLeaf, ChartLeaf, TableLeaf, TextLeaf } from "./schema.js";

export function isTreeErrorLike(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("LAYOUT_LEAF_INVALID");
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 页标题带（一行放下；超长报错点名压缩）。 */
export function titleBand(title: string, frame: Frame, theme: ResolvedTheme, dark = false): SpecElement[] {
  const size = theme.sizes.pageTitle;
  const width = estimateTextWidth(title, size);
  const maxChars = Math.floor(frame.w / (size * 1.35));
  if (width > frame.w) {
    bad(`页标题过长——${size}pt 一行最多约 ${maxChars} 个中文字，请压缩成行动标题`);
  }
  const h = singleLineBoxHeight(size);
  return [
    textElement(
      { x: frame.x, y: 44, w: frame.w, h },
      [{ runs: headingRuns(title, size, dark ? theme.colors.onDarkText : theme.colors.text, theme) }],
    ),
  ];
}

/** 文字叶子 → 文本元素（换行拆段，可选项目符号）。 */
export function renderTextLeaf(leaf: TextLeaf, frame: Frame, theme: ResolvedTheme, sizePt: number, dark = false): SpecElement {
  const tone = leaf.tone ?? (dark ? "inverse" : "normal");
  const color =
    tone === "muted" ? theme.colors.textMuted : tone === "inverse" ? theme.colors.onDarkText : theme.colors.text;
  const heading = leaf.variant === "display" || leaf.variant === "heading";
  const runs = heading
    ? headingRuns("", sizePt, color, theme)
    : bodyRuns("", sizePt, color, theme);
  const paragraphs = leaf.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      runs: [{ ...runs[0]!, text: line }],
      ...(leaf.align ? { align: leaf.align } : {}),
      ...(leaf.bullet ? { bullet: true } : {}),
    }));
  if (paragraphs.length === 0) bad("text 叶子内容为空");
  const valign = leaf.variant === "body" || leaf.variant === "caption" ? ("top" as const) : ("middle" as const);
  return textElement(frame, paragraphs, valign);
}

export interface StatInput {
  value: string;
  label: string;
  unit?: string;
}

/** KPI 数字格：大数字自适应格宽 + 下方标签，整组垂直居中。 */
export function statCell(stat: StatInput, frame: Frame, theme: ResolvedTheme, focus = false): SpecElement[] {
  const padding = theme.spacing.cardPadding;
  const innerW = frame.w - padding * 2;
  if (innerW < 40) bad(`KPI 卡「${stat.value}」格宽不足（${Math.round(frame.w)}px）——加大权重或减少兄弟节点`);
  let size = theme.sizes.kpi;
  if (focus) size = Math.min(90, size + 12);
  const widthAt = (s: number) => {
    const unitS = Math.max(12, Math.round(s * 0.3));
    return estimateTextWidth(stat.value, s) + (stat.unit ? estimateTextWidth(stat.unit, unitS) + 4 : 0);
  };
  if (widthAt(size) > innerW) {
    size = Math.max(28, Math.floor((size * innerW) / widthAt(size)));
    if (widthAt(size) > innerW) {
      bad(`KPI 卡「${stat.value}」数字太长，格宽装不下——精简数值或把单位并入标签`);
    }
  }
  const unitSizeFinal = Math.max(12, Math.round(size * 0.3));
  const valueRuns = [
    { text: stat.value, sizePt: size, bold: true, color: theme.colors.primary },
    ...(stat.unit ? [{ text: ` ${stat.unit}`, sizePt: unitSizeFinal, bold: true, color: theme.colors.textMuted }] : []),
  ];
  const valueH = singleLineBoxHeight(size);
  const labelSize = theme.sizes.caption;
  const labelLines = estimateLines(stat.label, labelSize, innerW);
  const labelH = textBoxHeight(stat.label, labelSize, innerW);
  const gap = 12;
  const total = valueH + gap + labelH;
  const top = frame.y + Math.max(0, (frame.h - total) / 2);
  return [
    card(frame, theme, focus ? theme.colors.primarySoft : undefined),
    textElement({ x: frame.x + padding, y: top, w: innerW, h: valueH }, [{ runs: valueRuns }]),
    textElement(
      { x: frame.x + padding, y: top + valueH + gap, w: innerW, h: labelLines * estimateLineHeight(labelSize) + 4 },
      [{ runs: bodyRuns(stat.label, labelSize, theme.colors.textMuted, theme) }],
    ),
  ];
}

export interface CardInput {
  icon?: string;
  title: string;
  body?: string;
}

/** 图文卡：卡面 + 可选 icon + 标题 + 正文；装不下报错点名。 */
export function textCard(input: CardInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const padding = theme.spacing.cardPadding;
  const inner = { x: frame.x + padding, y: frame.y + padding, w: frame.w - padding * 2, h: frame.h - padding * 2 };
  if (inner.w < 60 || inner.h < 40) {
    bad(`${what}「${input.title.slice(0, 12)}」卡框过小（${Math.round(frame.w)}×${Math.round(frame.h)}px）——加大权重`);
  }
  const titleSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const bodySize = Math.min(15, Math.max(12, theme.sizes.body));
  const iconSize = 28;
  const iconW = input.icon ? iconSize + 12 : 0;
  const textW = inner.w - iconW;
  const titleLines = estimateLines(input.title, titleSize, textW);
  const titleH = titleLines * estimateLineHeight(titleSize);
  const bodyLines = input.body ? estimateLines(input.body, bodySize, textW) : 0;
  const bodyH = input.body ? bodyLines * estimateLineHeight(bodySize) + 4 : 0;
  const gap = input.body ? 8 : 0;
  const total = titleH + gap + bodyH;
  if (total > inner.h) {
    bad(
      `${what}「${input.title.slice(0, 12)}」内容超卡高（约 ${Math.round(total)}px > ${Math.round(inner.h)}px）——精简正文或加大权重`,
    );
  }
  const elements: SpecElement[] = [card(frame, theme)];
  const top = inner.y + Math.max(0, (inner.h - total) / 2);
  if (input.icon) {
    elements.push({
      type: "icon",
      icon: input.icon,
      color: theme.colors.primary,
      x: Math.round(inner.x),
      y: Math.round(top + (titleH - iconSize) / 2),
      w: iconSize,
      h: iconSize,
    });
  }
  elements.push(
    textElement(
      { x: inner.x + iconW, y: top, w: textW, h: titleH + 4 },
      [{ runs: headingRuns(input.title, titleSize, theme.colors.text, theme) }],
    ),
  );
  if (input.body) {
    elements.push(
      textElement(
        { x: inner.x + iconW, y: top + titleH + gap, w: textW, h: bodyH },
        [{ runs: bodyRuns(input.body, bodySize, theme.colors.textMuted, theme) }],
      ),
    );
  }
  return elements;
}

export function renderCardLeaf(leaf: CardLeaf, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  if (leaf.value !== undefined) {
    return statCell({ value: leaf.value, label: leaf.label ?? "", ...(leaf.unit ? { unit: leaf.unit } : {}) }, frame, theme);
  }
  return textCard(
    { title: leaf.title ?? "", ...(leaf.body ? { body: leaf.body } : {}), ...(leaf.icon ? { icon: leaf.icon } : {}) },
    frame,
    theme,
    what,
  );
}

/** 图表叶子 → 引擎 chart 元素（沿用 D 系 buildChart 的校验与主题系列色）。 */
export function renderChartLeaf(leaf: ChartLeaf, frame: Frame, theme: ResolvedTheme): ChartElement {
  const points = leaf.categories.length;
  const element: ChartElement = {
    type: "chart",
    chart: leaf.kind,
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    categories: leaf.categories,
    series: leaf.series,
    colors: theme.colors.chartSeries.slice(
      0,
      Math.max(leaf.series.length, leaf.kind === "pie" || leaf.kind === "doughnut" ? points : leaf.series.length),
    ),
    ...(points <= 8 && leaf.kind !== "scatter" ? { dataLabels: true } : {}),
    ...(leaf.legend ? { legend: true } : {}),
  };
  return element;
}

const CHECK_CELL = /^[✓✗★☆]{1,6}$/;
const NUMERIC_CELL = /^[-+￥$€%]?[\d,.．]+[%万亿]?$/;

/** 表格叶子 → 引擎 table 元素（列对齐推断 + 行高预算，迁自 preset-common buildTable）。 */
export function renderTableLeaf(leaf: TableLeaf, frame: Frame, theme: ResolvedTheme, what: string): TableElement {
  const parsed = leaf.rows as TableCell[][];
  const colCount = parsed[0]!.length;
  const fontSize = Math.min(14, Math.max(12, theme.sizes.table));
  const style = leaf.style ?? "lines";

  const cellText = (row: TableCell[], c: number): string => {
    const cell = row[c]!;
    return typeof cell === "string" ? cell : cell.text;
  };
  const aligns: ("left" | "center" | "right")[] = [];
  for (let c = 0; c < colCount; c++) {
    const column = parsed.slice(1).map((row) => cellText(row, c));
    if (column.every((t) => CHECK_CELL.test(t))) aligns.push("center");
    else if (c > 0 && column.length > 0 && column.every((t) => NUMERIC_CELL.test(t))) aligns.push("right");
    else aligns.push("left");
  }

  const widthSum = (leaf.colWidths ?? parsed[0]!.map(() => 1)).reduce((a, b) => a + b, 0);
  const lineH = fontSize * 1.8;
  let estHeight = 0;
  for (const [r, row] of parsed.entries()) {
    let maxLines = 1;
    for (let c = 0; c < colCount; c++) {
      const colW = ((leaf.colWidths ?? parsed[0]!.map(() => 1))[c]! / widthSum) * frame.w - 12;
      maxLines = Math.max(maxLines, estimateLines(cellText(row, c), fontSize, colW));
    }
    const rowFactor = r === 0 ? 1.15 : (/合计|总计|小计/.test(cellText(row, 0)) ? 1.2 : 1);
    estHeight += maxLines * lineH * rowFactor + 10;
  }
  if (estHeight > frame.h + 4) {
    bad(`${what} 行高预算约 ${Math.round(estHeight)}px 超过区域 ${Math.round(frame.h)}px——砍行、精简单元格文字或加大权重`);
  }

  const styled: TableCell[][] = parsed.map((row, r) =>
    row.map((cell, c): TableCell => {
      const isHeader = r === 0;
      if (typeof cell === "string") {
        if (isHeader) {
          if (style === "darkHeader") {
            return { text: cell, bold: true, color: theme.colors.onDarkText, fill: theme.colors.darkBackground, align: "center" };
          }
          return { text: cell, bold: true, color: theme.colors.text };
        }
        const totalRow = /合计|总计|小计/.test(cellText(row, 0));
        return {
          text: cell,
          bold: totalRow || (c === 0 && style === "zebra"),
          ...(totalRow ? { color: theme.colors.primary } : {}),
          align: aligns[c]!,
        };
      }
      return cell;
    }),
  );

  return {
    type: "table",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    rows: styled,
    fontSize,
    ...(leaf.colWidths ? { colWidths: leaf.colWidths } : {}),
    ...(style === "lines" ? { borderColor: theme.colors.divider, horizontalBordersOnly: true, borderWidthPt: 0.5 } : {}),
    ...(style === "zebra" ? { zebra: theme.colors.cardSurface } : {}),
  };
}
