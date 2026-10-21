/**
 * v2 编译器：slot 栅格 → PageSpec。只消费 normalizeV2Page 的产物；
 * v1 flex 树不经过本文件。输出与 v1 相同的 CompileResult，measure/落页链路无需分叉。
 */

import { CANVAS_H, CANVAS_W, type Frame } from "../../grid.js";
import { darkPageTheme, mixHex, withAlpha, type ResolvedTheme } from "../../theme.js";
import type { SpecElement, SpecParagraph, SpecRun, TableElement } from "../../elements.js";
import { estimateLineHeight, estimateTextWidth } from "../../text-metrics.js";
import type { LayoutContract } from "../layout-contract.js";
import { normalizeTree } from "../schema.js";
import { compileV1Subtree } from "../compile.js";
import type { CompileDefect, CompileResult, LeafPlacement } from "../compile.js";
import type { V2Bleed, V2Node, V2Page, V2Run, V2Slot, V2TableNode, V2TextNode } from "./schema.js";
import { expandComponent } from "../components/index.js";
import { DARK_COVER_ROLES, pageMotifElements } from "../components/kit.js";
import { isTreeErrorLike } from "../leaf-renderers.js";

const HEADING_TOKENS = new Set(["display", "hero", "h1", "h2", "h3"]);
const SERIF_FONT = "Songti SC, Georgia";

interface CompileOptions {
  pageIndex?: number;
  pageCount?: number;
}

function toneColor(tone: string | undefined, theme: ResolvedTheme): string {
  const colors = theme.colors;
  switch (tone) {
    case "primary": return colors.primary;
    case "accent": return colors.accent;
    case "muted": return colors.textMuted;
    case "inverse": return colors.onDarkText;
    case "inverseMuted": return mixHex(colors.onDarkText, colors.darkBackground, 0.45);
    case "surface": return colors.cardSurface;
    case "primarySoft": return colors.primarySoft;
    case "divider": return colors.divider;
    case "chart1": case "chart2": case "chart3": case "chart4": case "chart5": case "chart6": {
      const index = Number(tone.slice(5)) - 1;
      return colors.chartSeries[index] ?? colors.primary;
    }
    default: return colors.text;
  }
}

function resolvePaint(value: string | undefined, theme: ResolvedTheme): string | undefined {
  if (!value) return undefined;
  return value.startsWith("tone:") ? toneColor(value.slice(5), theme) : value;
}

function bleedSides(bleed: V2Bleed | undefined): Set<string> {
  if (bleed === undefined || bleed === false) return new Set();
  if (bleed === true) return new Set(["left", "right", "top", "bottom"]);
  const list = Array.isArray(bleed) ? bleed : [bleed];
  const out = new Set<string>();
  for (const item of list) {
    if (item === "all") ["left", "right", "top", "bottom"].forEach((side) => out.add(side));
    else if (item === "x") { out.add("left"); out.add("right"); }
    else if (item === "y") { out.add("top"); out.add("bottom"); }
    else out.add(item);
  }
  return out;
}

function areaFor(page: V2Page, theme: ResolvedTheme): Frame {
  if (page.safeArea === "full") return { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  const margin = page.grid?.margin ?? theme.spacing.margin;
  return { x: margin, y: margin, w: CANVAS_W - 2 * margin, h: CANVAS_H - 2 * margin };
}

function frameFor(page: V2Page, node: { slot: V2Slot; bleed?: V2Bleed }, theme: ResolvedTheme): Frame {
  const grid = {
    cols: page.grid?.cols ?? 12,
    rows: page.grid?.rows ?? 8,
    gutter: page.grid?.gutter ?? theme.spacing.gutter,
    rowGutter: page.grid?.rowGutter ?? 16,
    margin: page.grid?.margin ?? theme.spacing.margin,
  };
  const area = areaFor(page, theme);
  const cw = (area.w - (grid.cols - 1) * grid.gutter) / grid.cols;
  const rh = (area.h - (grid.rows - 1) * grid.rowGutter) / grid.rows;
  const [c1, c2] = node.slot.col;
  const [r1, r2] = node.slot.row;
  let x = area.x + (c1 - 1) * (cw + grid.gutter);
  let w = (c2 - c1 + 1) * cw + (c2 - c1) * grid.gutter;
  let y = area.y + (r1 - 1) * (rh + grid.rowGutter);
  let h = (r2 - r1 + 1) * rh + (r2 - r1) * grid.rowGutter;
  const sides = bleedSides(node.bleed);
  if (sides.has("left")) { w += x; x = 0; }
  if (sides.has("right")) w = CANVAS_W - x;
  if (sides.has("top")) { h += y; y = 0; }
  if (sides.has("bottom")) h = CANVAS_H - y;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function runSize(run: V2Run, node: V2TextNode, theme: ResolvedTheme): number {
  return theme.typeScale[run.token ?? node.token];
}

function runColor(run: V2Run, node: V2TextNode, theme: ResolvedTheme): string {
  return toneColor(run.tone ?? node.tone ?? "text", theme);
}

function runFont(run: V2Run, node: V2TextNode, theme: ResolvedTheme): string | undefined {
  const font = run.font;
  if (font === "serif") return SERIF_FONT;
  if (font === "heading") return theme.fonts.heading;
  if (font === "body") return theme.fonts.body;
  return HEADING_TOKENS.has(node.token) ? theme.fonts.heading : theme.fonts.body;
}

function buildRun(run: V2Run, node: V2TextNode, theme: ResolvedTheme): SpecRun {
  const size = runSize(run, node, theme);
  const bold = run.bold ?? node.bold ?? ["display", "hero", "h1", "h2", "h3", "kicker", "label"].includes(node.token);
  const letterSpacing = run.letterSpacing ?? node.letterSpacing;
  const font = runFont(run, node, theme);
  return {
    text: run.text,
    sizePt: size,
    color: runColor(run, node, theme),
    ...(bold ? { bold: true } : {}),
    ...(font ? { font } : {}),
    ...(letterSpacing !== undefined ? { letterSpacing } : {}),
  };
}

function textParagraphs(node: V2TextNode, theme: ResolvedTheme): SpecParagraph[] {
  const paragraphs = node.paragraphs
    ?? [{ runs: node.runs ?? [{ text: node.text ?? "" }] }];
  return paragraphs.map((paragraph) => ({
    align: paragraph.align ?? node.align ?? "left",
    ...(paragraph.lineSpacingPct !== undefined || node.lineHeightPct !== undefined
      ? { lineSpacingPct: paragraph.lineSpacingPct ?? node.lineHeightPct }
      : {}),
    ...(paragraph.spaceBeforePt !== undefined ? { spaceBeforePt: paragraph.spaceBeforePt } : {}),
    ...(paragraph.spaceAfterPt !== undefined ? { spaceAfterPt: paragraph.spaceAfterPt } : {}),
    runs: paragraph.runs.map((run) => buildRun(run, node, theme)),
  }));
}

function textNeededHeight(paragraphs: SpecParagraph[], width: number): number {
  let height = 0;
  for (const paragraph of paragraphs) {
    const size = Math.max(9, ...paragraph.runs.map((run) => run.sizePt ?? 12));
    // 混排按每个 run 自己的字号累加宽度（hero + 单位 20pt 不能按 72pt 全算）。
    const runWidth = paragraph.runs.reduce((sum, run) => sum + estimateTextWidth(run.text, run.sizePt ?? size), 0);
    const lines = Math.max(1, Math.ceil(runWidth / Math.max(1, width)));
    height += lines * estimateLineHeight(size, paragraph.lineSpacingPct ?? 110);
    height += (paragraph.spaceBeforePt ?? 0) * 1.33 + (paragraph.spaceAfterPt ?? 0) * 1.33;
  }
  return Math.ceil(height);
}

/** 竖排：逐字成段，交给 PPT 的普通文本框纵向堆叠；不依赖 OOXML vert 写回。 */
function verticalParagraphs(paragraphs: SpecParagraph[]): SpecParagraph[] {
  const out: SpecParagraph[] = [];
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) {
      for (const char of Array.from(run.text)) {
        if (char === "\n" || char === " ") continue;
        out.push({ runs: [{ ...run, text: char }], align: "center", lineSpacingPct: paragraph.lineSpacingPct ?? 100 });
      }
    }
  }
  return out;
}

function buildText(node: V2TextNode, frame: Frame, theme: ResolvedTheme): { element: SpecElement; neededHeight: number } {
  const source = textParagraphs(node, theme);
  const paragraphs = node.direction === "vertical" ? verticalParagraphs(source) : source;
  const element: SpecElement = {
    type: "text",
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    paragraphs,
    valign: node.valign ?? "top",
  };
  return { element, neededHeight: textNeededHeight(paragraphs, frame.w) };
}

function buildImage(node: Extract<V2Node, { type: "image" }>, frame: Frame, theme: ResolvedTheme): { element: SpecElement; extra: SpecElement[] } {
  const radiusAdj = (node.radius || node.mask === "rounded") && theme.spacing.cornerRadius > 0
    ? Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(frame.w, frame.h))) * 100000))
    : undefined;
  const element: SpecElement = {
    type: "image",
    url: node.url,
    fit: node.fit ?? "cover",
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    ...(node.focus ? { focus: { x: node.focus.x ?? 50, y: node.focus.y ?? 50 } } : {}),
    ...(node.grayscale ? { grayscale: true } : {}),
    ...(node.duotone ? { duotone: [theme.colors.darkBackground, theme.colors.onDarkText] as [string, string] } : {}),
    ...(node.mask === "circle" ? { circle: true } : {}),
    ...(radiusAdj !== undefined ? { radiusAdj } : {}),
  };
  const extra: SpecElement[] = [];
  if (node.scrim) {
    extra.push({
      type: "shape",
      shape: "rect",
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      fill: withAlpha(node.scrim.color ?? theme.colors.darkBackground, node.scrim.opacity ?? 0.55),
    });
  }
  if (node.caption) {
    const width = Math.min(frame.w - 32, Math.max(72, Math.round(estimateTextWidth(node.caption, 10) + 24)));
    const height = 26;
    extra.push({
      type: "shape",
      shape: "roundRect",
      x: frame.x + 16,
      y: frame.y + frame.h - height - 16,
      w: width,
      h: height,
      fill: withAlpha(theme.colors.darkBackground, 0.55),
      adj: 50000,
      paragraphs: [{ runs: [{ text: node.caption, sizePt: 10, color: theme.colors.onDarkText }] }],
      valign: "middle",
    });
  }
  return { element, extra };
}

function buildShape(node: Extract<V2Node, { type: "shape" }>, frame: Frame, theme: ResolvedTheme): SpecElement {
  const radiusAdj = node.radius && node.shape !== "rect"
    ? Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(frame.w, frame.h))) * 100000))
    : undefined;
  return {
    type: "shape",
    shape: node.shape ?? "rect",
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    ...(node.gradient
      ? { gradient: node.gradient }
      : { fill: resolvePaint(node.fill, theme) ?? theme.colors.cardSurface }),
    ...(node.stroke
      ? { stroke: { color: resolvePaint(node.stroke.color, theme) ?? theme.colors.divider, widthPt: node.stroke.widthPt } }
      : {}),
    ...(radiusAdj !== undefined ? { adj: radiusAdj } : {}),
  };
}

function buildStats(node: Extract<V2Node, { type: "stats" }>, frame: Frame, theme: ResolvedTheme): { elements: SpecElement[]; heights: number[] } {
  const count = Math.max(1, node.items.length);
  // 竖排在 4 项、槽高不足时会让 h2 数字与下一项贴死（genoffice 会按 ink 重叠拒页）。
  // 宽槽自动转 2×N 网格，给每项真正的盒高；窄槽仍保持单列。
  const columns = count >= 3 && frame.w >= 420 && frame.h / count < 140 ? 2 : 1;
  const rows = Math.ceil(count / columns);
  const cellWidth = frame.w / columns;
  const cellHeight = frame.h / rows;
  const boxHeight = Math.max(24, Math.round(cellHeight - 8));
  const elements: SpecElement[] = [];
  const heights: number[] = [];
  node.items.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = Math.round(frame.x + column * cellWidth);
    const y = Math.round(frame.y + row * cellHeight + 4);
    const paragraphs: SpecParagraph[] = [
      {
        runs: [
          { text: item.value, sizePt: theme.typeScale.h2, bold: true, color: theme.colors.primary, font: theme.fonts.heading },
          ...(item.unit ? [{ text: ` ${item.unit}`, sizePt: theme.typeScale.label, color: theme.colors.textMuted, font: theme.fonts.body }] : []),
        ],
      },
      { spaceBeforePt: 4, runs: [{ text: item.label, sizePt: theme.typeScale.caption, color: theme.colors.textMuted, font: theme.fonts.body }] },
    ];
    elements.push({
      type: "text",
      x,
      y,
      w: Math.round(cellWidth),
      h: boxHeight,
      valign: "middle",
      paragraphs,
    });
    heights.push(textNeededHeight(paragraphs, cellWidth));
  });
  return { elements, heights };
}

function buildTable(node: V2TableNode, frame: Frame, theme: ResolvedTheme): TableElement {
  const header = node.header !== false;
  const style = node.style ?? "banded";
  const fontSize = node.fontSize ?? theme.typeScale.caption;
  const rows = node.rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const isHeader = header && rowIndex === 0;
    const headerFill = style === "banded" ? theme.colors.primary : style === "outline" ? theme.colors.background : undefined;
    return {
      text: cell.text,
      ...(isHeader || cell.bold || (style !== "minimal" && columnIndex === 0) ? { bold: true } : {}),
      ...(cell.align ? { align: cell.align } : {}),
      ...(cell.span ? { span: cell.span } : {}),
      ...(cell.fill
        ? { fill: resolvePaint(cell.fill, theme) ?? theme.colors.primary }
        : isHeader && headerFill
          ? { fill: headerFill }
          : {}),
      color: cell.tone
        ? toneColor(cell.tone, theme)
        : isHeader
          ? style === "banded" ? theme.colors.onDarkText : theme.colors.primary
          : theme.colors.text,
    };
  }));
  return {
    type: "table",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    rows,
    fontSize,
    borderColor: node.borderColor
      ? resolvePaint(node.borderColor, theme) ?? theme.colors.divider
      : style === "outline" ? theme.colors.primary : theme.colors.divider,
    horizontalBordersOnly: style !== "outline",
    borderWidthPt: style === "outline" ? 0.75 : 0.5,
    ...(node.colWidths ? { colWidths: node.colWidths } : {}),
    ...(node.rowHeights ? { rowHeights: node.rowHeights } : {}),
    ...(style === "banded" && node.zebra !== false ? { zebra: theme.colors.cardSurface } : {}),
  };
}

function buildChart(node: Extract<V2Node, { type: "chart" }>, frame: Frame, theme: ResolvedTheme): SpecElement {
  const colors = (node.colors ?? theme.colors.chartSeries).map((color) => resolvePaint(color, theme) ?? color);
  return {
    type: "chart",
    chart: node.kind,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    categories: node.categories,
    series: node.series,
    colors,
    ...(node.pointColors ? { pointColors: node.pointColors.map((row) => row.map((color) => resolvePaint(color ?? undefined, theme) ?? null)) } : {}),
    ...(node.dataLabels ? { dataLabels: true } : {}),
    ...(node.legend !== undefined ? { legend: node.legend } : {}),
    ...(node.gridlines ? { gridlines: true } : {}),
    axis: {
      labelColor: theme.colors.textMuted,
      labelSizePt: theme.typeScale.caption,
      lineColor: theme.colors.divider,
      gridColor: theme.colors.divider,
      legendColor: theme.colors.textMuted,
      legendSizePt: theme.typeScale.caption,
      dataLabelColor: theme.colors.text,
      dataLabelSizePt: theme.typeScale.caption,
    },
  };
}

function buildFooter(page: V2Page, theme: ResolvedTheme, options: CompileOptions): SpecElement[] {
  const footer = page.footer;
  if (!footer) return [];
  const margin = page.grid?.margin ?? theme.spacing.margin;
  const inverse = footer.tone === "inverse";
  const color = footer.tone === "inverse" ? mixHex(theme.colors.onDarkText, theme.colors.darkBackground, 0.35) : theme.colors.textMuted;
  const elements: SpecElement[] = [];
  if (!inverse) {
    elements.push({ type: "shape", shape: "rect", x: margin, y: 672, w: CANVAS_W - 2 * margin, h: 1, fill: theme.colors.divider });
  }
  const text = (x: number, w: number, value: string, align: "left" | "center" | "right"): SpecElement => ({
    type: "text",
    x,
    y: 684,
    w,
    h: 24,
    paragraphs: [{ align, runs: [{ text: value, sizePt: 10, color }] }],
    valign: "top",
  });
  if (footer.left) elements.push(text(margin, 380, footer.left, "left"));
  if (footer.center) elements.push(text((CANVAS_W - 380) / 2, 380, footer.center, "center"));
  if (footer.right) elements.push(text(CANVAS_W - margin - 260, 260, footer.right, "right"));
  if (footer.pageNumbers && options.pageIndex !== undefined && options.pageCount !== undefined) {
    elements.push(text(CANVAS_W - margin - 160, 160, `${String(options.pageIndex).padStart(2, "0")} / ${String(options.pageCount).padStart(2, "0")}`, "right"));
  }
  return elements;
}

function groupPanelElement(node: Extract<V2Node, { type: "group" }>, frame: Frame, theme: ResolvedTheme): SpecElement | null {
  if (!node.panel) return null;
  const fill = node.panel === "tint" ? theme.colors.primarySoft
    : node.panel === "dark" ? theme.colors.darkBackground
      : node.panel === "surface" ? theme.colors.cardSurface
        : undefined;
  return {
    type: "shape",
    shape: "roundRect",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    ...(fill ? { fill } : {}),
    ...(node.panel === "outline" ? { stroke: { color: theme.colors.divider, widthPt: 0.75 } } : {}),
  };
}

function buildConnector(node: Extract<V2Node, { type: "connector" }>, theme: ResolvedTheme): SpecElement[] {
  const x1 = (node.from.x / 100) * CANVAS_W;
  const y1 = (node.from.y / 100) * CANVAS_H;
  const x2 = (node.to.x / 100) * CANVAS_W;
  const y2 = (node.to.y / 100) * CANVAS_H;
  const color = node.tone ? toneColor(node.tone, theme) : theme.colors.primary;
  const width = node.widthPt ?? 1.5;
  const bbox = (points: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } => {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: Math.round(minX),
      y: Math.round(minY),
      w: Math.max(1, Math.round(Math.max(...xs) - minX)),
      h: Math.max(1, Math.round(Math.max(...ys) - minY)),
    };
  };
  const line: SpecElement = {
    type: "path",
    d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    fill: "#00000000",
    stroke: { color, widthPt: width },
    ...bbox([{ x: x1, y: y1 }, { x: x2, y: y2 }]),
  };
  if (node.arrow === false) return [line];
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 9;
  const left = { x: x2 - Math.cos(angle - 0.48) * size, y: y2 - Math.sin(angle - 0.48) * size };
  const right = { x: x2 - Math.cos(angle + 0.48) * size, y: y2 - Math.sin(angle + 0.48) * size };
  return [
    line,
    {
      type: "path",
      d: `M ${x2.toFixed(1)} ${y2.toFixed(1)} L ${left.x.toFixed(1)} ${left.y.toFixed(1)} L ${right.x.toFixed(1)} ${right.y.toFixed(1)} Z`,
      fill: color,
      ...bbox([{ x: x2, y: y2 }, left, right]),
    },
  ];
}

export function compileV2Page(page: V2Page, contract: LayoutContract, options: CompileOptions = {}): CompileResult {
  const dark = page.dark === true
    || (contract.theme.design.darkCover && DARK_COVER_ROLES.has(page.role));
  const theme = dark ? darkPageTheme(contract.theme) : contract.theme;
  const background = page.background
    ? resolvePaint(page.background, theme) ?? theme.colors.background
    : dark ? theme.colors.darkBackground : theme.colors.background;
  const elements: SpecElement[] = [];
  const placements: LeafPlacement[] = [];
  const defects: CompileDefect[] = [];
  const stats = { elements: 0, leaves: 0, depth: 1, images: 0, paths: 0 };
  const push = (element: SpecElement): void => {
    elements.push(element);
    stats.elements += 1;
  };
  // 风格卡母题：压在所有节点之下（形状级，不参与墨迹闸门）。
  for (const element of pageMotifElements(theme, { role: page.role })) push(element);

  for (const [index, node] of page.nodes.entries()) {
    const path = `nodes/${index}`;
    if (node.type === "connector") {
      for (const element of buildConnector(node, theme)) push(element);
      stats.paths += 1;
      continue;
    }
    const frame = frameFor(page, node, theme);
    if (node.type === "group") {
      let subtree;
      try {
        subtree = normalizeTree(node.tree);
      } catch (error) {
        defects.push({ path, type: "overflow", detail: `group 内 v1 树非法：${error instanceof Error ? error.message : String(error)}`, hint: "按 v1 容器语法修正 group.tree" } as CompileDefect);
        continue;
      }
      if (subtree.version === 2) {
        defects.push({ path, type: "overflow", detail: "group.tree 必须是 v1 flex 子树，不能嵌套 v2 页面", hint: "group 内使用 direction/weights/children 的 v1 树" } as CompileDefect);
        continue;
      }
      const panelElement = groupPanelElement(node, frame, theme);
      if (panelElement) push(panelElement);
      const sub = compileV1Subtree(subtree, contract, frame, dark);
      sub.elements.forEach(push);
      sub.defects.forEach((defect) => defects.push(defect));
      stats.leaves += sub.stats.leaves;
      stats.images += sub.stats.images;
      stats.paths += sub.stats.paths;
      placements.push({ path, kind: "component", frame, flexible: true });
    } else if (node.type === "text") {
      const { element, neededHeight } = buildText(node, frame, theme);
      push(element);
      stats.leaves += 1;
      placements.push({ path, kind: "text", frame, label: node.token, sizePt: theme.typeScale[node.token], neededHeight, flexible: true });
    } else if (node.type === "image") {
      const { element, extra } = buildImage(node, frame, theme);
      push(element);
      for (const item of extra) push(item);
      stats.leaves += 1;
      stats.images += 1;
      placements.push({ path, kind: "image", frame, url: node.url, contain: node.fit === "contain", flexible: true });
    } else if (node.type === "shape") {
      push(buildShape(node, frame, theme));
    } else if (node.type === "stats") {
      const { elements: statElements, heights: statHeights } = buildStats(node, frame, theme);
      statElements.forEach((element, itemIndex) => {
        push(element);
        stats.leaves += 1;
        placements.push({
          path: `${path}/stats/${itemIndex}`,
          kind: "text",
          frame: { x: element.x, y: element.y, w: element.w, h: element.h },
          sizePt: theme.typeScale.h2,
          neededHeight: statHeights[itemIndex] ?? 0,
          flexible: true,
        });
      });
    } else if (node.type === "icon") {
      push({
        type: "icon",
        icon: node.name,
        ...(node.tone ? { color: toneColor(node.tone, theme) } : {}),
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
      });
      stats.leaves += 1;
      placements.push({ path, kind: "icon", frame, flexible: true });
    } else if (node.type === "path") {
      push({
        type: "path",
        d: node.d,
        ...(node.fill ? { fill: resolvePaint(node.fill, theme) ?? node.fill } : {}),
        ...(node.stroke
          ? { stroke: { color: resolvePaint(node.stroke.color, theme) ?? node.stroke.color, widthPt: node.stroke.widthPt } }
          : {}),
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
      });
      stats.leaves += 1;
      placements.push({ path, kind: "path", frame, flexible: true });
    } else if (node.type === "table") {
      push(buildTable(node, frame, theme));
      stats.leaves += 1;
      placements.push({ path, kind: "table", frame, flexible: true });
    } else if (node.type === "chart") {
      push(buildChart(node, frame, theme));
      stats.leaves += 1;
      placements.push({ path, kind: "chart", frame, flexible: true });
    } else if (node.type === "component") {
      try {
        const componentElements = expandComponent(node.component, frame, theme, `${path} ${node.name}`);
        componentElements.forEach(push);
        stats.leaves += 1;
        placements.push({ path, kind: "component", frame, flexible: true });
      } catch (error) {
        // 组件装不下（LAYOUT_LEAF_INVALID）在 v1 转缺陷；v2 同样不中断整页，回给 layouter 自纠。
        if (isTreeErrorLike(error)) {
          defects.push({ path, type: "overflow", detail: (error as Error).message.replace(/^LAYOUT_LEAF_INVALID: /, "") });
        } else {
          throw error;
        }
      }
    }
  }
  for (const element of buildFooter(page, theme, options)) push(element);

  return {
    spec: { background, ...(page.notes ? { notes: page.notes } : {}), elements },
    placements,
    defects,
    stats,
  };
}
