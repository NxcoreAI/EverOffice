/**
 * 预设共享构件：页标题条、深色横幅、KPI 数字格、图文卡、表格。
 * 全部带测高适配与超预算报错——模型不再自算，错了这里直接告诉它改什么。
 */

import {
  TITLE_Y,
  contentFrame,
  splitColumns,
  splitRows,
  type Frame,
} from "./grid.js";
import {
  bodyRuns,
  card,
  headingRuns,
  textElement,
  type PageSpec,
  type SpecElement,
  type TableElement,
  type TableCell,
} from "./elements.js";
import { estimateLines, estimateTextWidth, estimateLineHeight, textBoxHeight, singleLineBoxHeight } from "./text-metrics.js";
import type { ResolvedTheme } from "./theme.js";
import { objects, str } from "./parse.js";

export interface PresetContext {
  theme: ResolvedTheme;
  /** 内容区（M/G 已从主题取）。 */
  frame: Frame;
  M: number;
  G: number;
}

export function makeContext(theme: ResolvedTheme): PresetContext {
  return { theme, frame: contentFrame(theme.spacing.margin), M: theme.spacing.margin, G: theme.spacing.gutter };
}

/** 页标题条（行动标题）：一行放下，超长直接报错并给出字数上限。 */
export function pageTitle(title: string, ctx: PresetContext): SpecElement[] {
  if (!title) return [];
  const size = ctx.theme.sizes.pageTitle;
  const width = estimateTextWidth(title, size);
  const maxChars = Math.floor(ctx.frame.w / (size * 1.35));
  if (width > ctx.frame.w) {
    throw new Error(`PRESET_INVALID: 页标题过长——${size}pt 一行最多约 ${maxChars} 个中文字，请压缩成行动标题`);
  }
  const h = singleLineBoxHeight(size);
  return [textElement(
    { x: ctx.M, y: TITLE_Y, w: ctx.frame.w, h },
    [{ runs: headingRuns(title, size, ctx.theme.colors.text, ctx.theme) }],
  )];
}

/** 深色横幅：一行主张（白）+ 可选右端大数字。 */
export function banner(text: string, value: string | undefined, frame: Frame, ctx: PresetContext, height = 72): SpecElement[] {
  const elements: SpecElement[] = [];
  const fill = ctx.theme.colors.darkBackground;
  const bar: SpecElement = {
    type: "shape",
    shape: "roundRect",
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: height,
    fill,
  };
  elements.push(bar);
  const size = Math.min(20, Math.max(16, ctx.theme.sizes.subtitle));
  const valueWidth = value ? estimateTextWidth(value, size + 8) + 48 : 0;
  const textWidth = frame.w - ctx.theme.spacing.cardPadding * 2 - valueWidth;
  const lines = estimateLines(text, size, textWidth);
  if (lines > 1) throw new Error(`PRESET_INVALID: 横幅主张过长（折成 ${lines} 行）——压缩到一行（约 ${Math.floor(textWidth / (size * 1.35))} 个中文字内）`);
  const textH = singleLineBoxHeight(size);
  const textY = frame.y + (height - textH) / 2;
  elements.push(textElement(
    { x: frame.x + ctx.theme.spacing.cardPadding, y: textY, w: textWidth, h: textH },
    [{ runs: bodyRuns(text, size, ctx.theme.colors.onDarkText, ctx.theme, true) }],
    "middle",
  ));
  if (value) {
    const vSize = size + 8;
    const vH = singleLineBoxHeight(vSize);
    elements.push(textElement(
      { x: frame.x + frame.w - valueWidth, y: frame.y + (height - vH) / 2, w: valueWidth, h: vH },
      [{ runs: bodyRuns(value, vSize, ctx.theme.colors.onDarkText, ctx.theme, true), align: "right" }],
      "middle",
    ));
  }
  return elements;
}

export interface StatInput {
  value: string;
  label: string;
  unit?: string;
}

/** KPI 数字格：大数字自适应格宽 + 下方标签，整组垂直居中。 */
export function statCell(stat: StatInput, frame: Frame, ctx: PresetContext, focus = false): SpecElement[] {
  const padding = ctx.theme.spacing.cardPadding;
  const innerW = frame.w - padding * 2;
  let size = ctx.theme.sizes.kpi;
  if (focus) size = Math.min(90, size + 12);
  const widthAt = (s: number) => {
    const unitS = Math.max(12, Math.round(s * 0.3));
    return estimateTextWidth(stat.value, s) + (stat.unit ? estimateTextWidth(stat.unit, unitS) + 4 : 0);
  };
  if (widthAt(size) > innerW) {
    size = Math.max(28, Math.floor((size * innerW) / widthAt(size)));
    if (widthAt(size) > innerW) {
      throw new Error(`PRESET_INVALID: 数字格「${stat.value}」太长，格宽装不下——精简数值或把单位并入标签`);
    }
  }
  const unitSizeFinal = Math.max(12, Math.round(size * 0.3));
  const valueRuns = [
    { text: stat.value, sizePt: size, bold: true, color: ctx.theme.colors.primary },
    ...(stat.unit ? [{ text: ` ${stat.unit}`, sizePt: unitSizeFinal, bold: true, color: ctx.theme.colors.textMuted }] : []),
  ];
  const valueH = singleLineBoxHeight(size);
  const labelSize = ctx.theme.sizes.caption;
  const labelLines = estimateLines(stat.label, labelSize, innerW);
  const labelH = textBoxHeight(stat.label, labelSize, innerW);
  const gap = 12;
  const total = valueH + gap + labelH;
  const top = frame.y + Math.max(0, (frame.h - total) / 2);
  return [
    card(frame, ctx.theme, focus ? ctx.theme.colors.primarySoft : undefined),
    textElement({ x: frame.x + padding, y: top, w: innerW, h: valueH }, [{ runs: valueRuns }]),
    textElement(
      { x: frame.x + padding, y: top + valueH + gap, w: innerW, h: labelLines * estimateLineHeight(labelSize) + 4 },
      [{ runs: bodyRuns(stat.label, labelSize, ctx.theme.colors.textMuted, ctx.theme) }],
    ),
  ];
}

export interface CardInput {
  icon?: string;
  title: string;
  body?: string;
}

/** 图文卡：卡面 + 可选 icon + 标题 + 正文；装不下报错点名。 */
export function textCard(input: CardInput, frame: Frame, ctx: PresetContext, what: string): SpecElement[] {
  const padding = ctx.theme.spacing.cardPadding;
  const inner = { x: frame.x + padding, y: frame.y + padding, w: frame.w - padding * 2, h: frame.h - padding * 2 };
  const titleSize = Math.min(18, Math.max(14, ctx.theme.sizes.body + 2));
  const bodySize = Math.min(15, Math.max(12, ctx.theme.sizes.body));
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
    throw new Error(
      `PRESET_INVALID: ${what}「${input.title.slice(0, 12)}」内容超卡高（约 ${Math.round(total)}px > ${Math.round(inner.h)}px）——精简正文或减少条目`,
    );
  }
  const elements: SpecElement[] = [card(frame, ctx.theme)];
  const top = inner.y + Math.max(0, (inner.h - total) / 2);
  if (input.icon) {
    elements.push({
      type: "icon",
      icon: input.icon,
      color: ctx.theme.colors.primary,
      x: Math.round(inner.x),
      y: Math.round(top + (titleH - iconSize) / 2),
      w: iconSize,
      h: iconSize,
    });
  }
  elements.push(textElement(
    { x: inner.x + iconW, y: top, w: textW, h: titleH + 4 },
    [{ runs: headingRuns(input.title, titleSize, ctx.theme.colors.text, ctx.theme) }],
  ));
  if (input.body) {
    elements.push(textElement(
      { x: inner.x + iconW, y: top + titleH + gap, w: textW, h: bodyH },
      [{ runs: bodyRuns(input.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }],
    ));
  }
  return elements;
}

export interface TableInput {
  rows: unknown[];
  colWidths?: unknown;
  fontSize?: unknown;
  emphasisColumn?: unknown;
}

const CHECK_CELL = /^[✓✗★☆]{1,6}$/;
const NUMERIC_CELL = /^[-+￥$€%]?[\d,.．]+[%万亿]?$/;

/** 表格构建：列对齐自动推断（勾选/星级居中、数字右对齐、首列左对齐加粗）+ 行高预算校验。 */
export function buildTable(input: TableInput, frame: Frame, ctx: PresetContext, what: string, style: "lines" | "darkHeader" | "zebra"): SpecElement {
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.length < 2) throw new Error(`PRESET_INVALID: ${what} rows 至少 2 行（表头+数据）`);
  if (rows.length > 12) throw new Error(`PRESET_INVALID: ${what} rows 超过 12 行——拆成两页，不缩字号硬塞`);
  const parsed: TableCell[][] = rows.map((row, i) => {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`PRESET_INVALID: ${what} 第 ${i + 1} 行必须是 ≥2 列的数组`);
    return row.map((cell) => {
      if (typeof cell === "string") return cell.slice(0, 300);
      if (typeof cell === "object" && cell !== null && typeof (cell as { text?: unknown }).text === "string") {
        const c = cell as { text: string; bold?: boolean; color?: string; fill?: string; align?: "left" | "center" | "right"; span?: number };
        return { text: c.text.slice(0, 300), ...(c.bold !== undefined ? { bold: c.bold } : {}), ...(c.color ? { color: c.color } : {}), ...(c.fill ? { fill: c.fill } : {}), ...(c.align ? { align: c.align } : {}), ...(c.span ? { span: c.span } : {}) };
      }
      throw new Error(`PRESET_INVALID: ${what} 第 ${i + 1} 行的单元格必须是字符串或 {text,...} 对象`);
    });
  });
  const colCount = parsed[0]!.length;
  if (colCount > 8) throw new Error(`PRESET_INVALID: ${what} 超过 8 列——拆两页`);
  for (const [i, row] of parsed.entries()) {
    if (row.length !== colCount) throw new Error(`PRESET_INVALID: ${what} 第 ${i + 1} 行列数（${row.length}）与表头（${colCount}）不一致`);
  }

  let colWidths: number[] | undefined;
  if (Array.isArray(input.colWidths) && input.colWidths.length === colCount && input.colWidths.every((v) => typeof v === "number" && v > 0)) {
    colWidths = input.colWidths as number[];
  }
  const fontSize = typeof input.fontSize === "number" ? Math.min(24, Math.max(9, input.fontSize)) : Math.min(14, Math.max(12, ctx.theme.sizes.table));

  // 列对齐推断：勾选/星级列居中；全数字列右对齐；其余左对齐。
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

  const emphasisColumn = typeof input.emphasisColumn === "number" ? input.emphasisColumn : -1;

  // 行高预算：每行按最坏列折行数估行高，超内容区直接报错（引擎还会实测兜底）。
  const widthSum = (colWidths ?? parsed[0]!.map(() => 1)).reduce((a, b) => a + b, 0);
  const lineH = fontSize * 1.8;
  let estHeight = 0;
  for (const [r, row] of parsed.entries()) {
    let maxLines = 1;
    for (let c = 0; c < colCount; c++) {
      const colW = ((colWidths ?? parsed[0]!.map(() => 1))[c]! / widthSum) * frame.w - 12;
      maxLines = Math.max(maxLines, estimateLines(cellText(row, c), fontSize, colW));
    }
    const rowFactor = r === 0 ? 1.15 : (/合计|总计|小计/.test(cellText(row, 0)) ? 1.2 : 1);
    estHeight += maxLines * lineH * rowFactor + 10;
  }
  if (estHeight > frame.h + 4) {
    throw new Error(`PRESET_INVALID: ${what} 行高预算约 ${Math.round(estHeight)}px 超过内容区 ${Math.round(frame.h)}px——砍行、精简单元格文字或拆两页`);
  }

  const styled: TableCell[][] = parsed.map((row, r) =>
    row.map((cell, c): TableCell => {
      const isHeader = r === 0;
      if (typeof cell === "string") {
        if (isHeader) {
          if (style === "darkHeader") {
            return { text: cell, bold: true, color: ctx.theme.colors.onDarkText, fill: ctx.theme.colors.darkBackground, align: "center" };
          }
          return { text: cell, bold: true, color: ctx.theme.colors.text };
        }
        const emphasized = c === emphasisColumn;
        const totalRow = /合计|总计|小计/.test(cellText(row, 0));
        return {
          text: cell,
          bold: emphasized || totalRow || (c === 0 && style === "zebra"),
          ...(emphasized || totalRow ? { color: ctx.theme.colors.primary } : {}),
          align: aligns[c]!,
        };
      }
      return cell;
    }),
  );

  const element: TableElement = {
    type: "table",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    rows: styled,
    fontSize,
    ...(colWidths ? { colWidths } : {}),
    ...(style === "lines" ? { borderColor: ctx.theme.colors.divider, horizontalBordersOnly: true, borderWidthPt: 0.5 } : {}),
    ...(style === "zebra" ? { zebra: ctx.theme.colors.cardSurface } : {}),
  };
  return element;
}

/** 整页背景 + 标题 + 主体的组装。 */
export function assemble(background: string, title: string, body: SpecElement[], ctx: PresetContext): PageSpec {
  return { background, elements: [...pageTitle(title, ctx), ...body] };
}

/** 竖向排卡片（等高，缝隙 G）。 */
export function cardColumn(cards: CardInput[], frame: Frame, ctx: PresetContext, what: string): SpecElement[] {
  const rows = splitRows(frame, cards.length, ctx.G);
  return cards.flatMap((c, i) => textCard(c, rows[i]!, ctx, `${what}第 ${i + 1} 卡`));
}

/** 横向排卡片（等宽，缝隙 G）。 */
export function cardRow(cards: CardInput[], frame: Frame, ctx: PresetContext, what: string): SpecElement[] {
  const cols = splitColumns(frame, cards.length, ctx.G);
  return cards.flatMap((c, i) => textCard(c, cols[i]!, ctx, `${what}第 ${i + 1} 卡`));
}

export function parseStat(raw: unknown): StatInput {
  const obj = objects([raw], "stats")[0]!;
  const unit = str(obj, "unit", { max: 8 });
  return { value: str(obj, "value", { required: true, max: 16 }), label: str(obj, "label", { required: true, max: 40 }), ...(unit ? { unit } : {}) };
}

export function parseCard(raw: unknown): CardInput {
  const obj = objects([raw], "cards")[0]!;
  const icon = str(obj, "icon", { max: 40 });
  const body = str(obj, "body", { max: 200 });
  return {
    ...(icon ? { icon } : {}),
    title: str(obj, "title", { required: true, max: 30 }),
    ...(body ? { body } : {}),
  };
}
