/**
 * T 系预设：行线表 T1、深表头 T2、斑马清单 T3、卡片行 T4、
 * 矩阵评分 T5、财务表 T6、双栏对照 T7。
 * 表格工艺（对齐/行高/提亮/合计行）由 buildTable 统一确定性执行。
 */

import { splitByRatio } from "../grid.js";
import {
  bodyRuns,
  card,
  headingRuns,
  textElement,
  type PageSpec,
  type SpecElement,
} from "../elements.js";
import { estimateLines, estimateLineHeight, singleLineBoxHeight } from "../text-metrics.js";
import { asObject, enumValue, list, objects, str } from "../parse.js";
import { buildTable, pageTitle, parseCard, type PresetContext } from "../preset-common.js";

type Input = Record<string, unknown>;

function tablePage(input: Input, ctx: PresetContext, id: string, style: "lines" | "darkHeader" | "zebra"): PageSpec {
  const table = asObject(input.table, `${id} table`);
  return {
    background: ctx.theme.colors.background,
    elements: [
      ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
      buildTable(
        {
          rows: list(table, "rows", { required: true }),
          colWidths: table.colWidths,
          fontSize: table.fontSize,
          emphasisColumn: input.emphasisColumn ?? table.emphasisColumn,
        },
        ctx.frame,
        ctx,
        `${id} 表格`,
        style,
      ),
    ],
  };
}

function expandT1(input: Input, ctx: PresetContext): PageSpec {
  return tablePage(input, ctx, "T1", "lines");
}

function expandT2(input: Input, ctx: PresetContext): PageSpec {
  return tablePage(input, ctx, "T2", "darkHeader");
}

function expandT3(input: Input, ctx: PresetContext): PageSpec {
  return tablePage(input, ctx, "T3", "zebra");
}

function expandT5(input: Input, ctx: PresetContext): PageSpec {
  return tablePage(input, ctx, "T5", "lines");
}

function expandT6(input: Input, ctx: PresetContext): PageSpec {
  return tablePage(input, ctx, "T6", "lines");
}

function expandT4(input: Input, ctx: PresetContext): PageSpec {
  const cards = list(input, "cards", { required: true, min: 2, max: 5 }).map(parseCard);
  const rows = splitRowsLocal(ctx.frame, cards.length, ctx.G);
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  cards.forEach((c, i) => {
    elements.push(...cardInRow(c, rows[i]!, ctx, `T4 第 ${i + 1} 行卡`));
  });
  return { background: ctx.theme.colors.background, elements };
}

function splitRowsLocal(frame: { x: number; y: number; w: number; h: number }, count: number, gutter: number) {
  const total = frame.h - (count - 1) * gutter;
  const base = Math.floor(total / count);
  const rows = [];
  let y = frame.y;
  for (let i = 0; i < count; i++) {
    const h = i === count - 1 ? total - base * (count - 1) : base;
    rows.push({ x: frame.x, y, w: frame.w, h });
    y += h + gutter;
  }
  return rows;
}

/** T4 行卡：icon + 标题同行 + 正文两行，横排（不是 textCard 的居中版式）。 */
function cardInRow(input: { icon?: string; title: string; body?: string }, frame: { x: number; y: number; w: number; h: number }, ctx: PresetContext, what: string): SpecElement[] {
  const padding = ctx.theme.spacing.cardPadding;
  const iconSize = 26;
  const iconW = input.icon ? iconSize + 16 : 0;
  const titleSize = 16;
  const bodySize = 13;
  const innerW = frame.w - padding * 2 - iconW;
  const titleLines = estimateLines(input.title, titleSize, innerW);
  const bodyLines = input.body ? estimateLines(input.body, bodySize, innerW) : 0;
  const titleH = titleLines * estimateLineHeight(titleSize);
  const bodyH = bodyLines * estimateLineHeight(bodySize);
  const total = titleH + (input.body ? 8 + bodyH : 0);
  if (total > frame.h - padding * 2) {
    throw new Error(`PRESET_INVALID: ${what}内容超高——精简正文或减少卡片数`);
  }
  const elements: SpecElement[] = [card(frame, ctx.theme)];
  const top = frame.y + (frame.h - total) / 2;
  if (input.icon) {
    elements.push({ type: "icon", icon: input.icon, color: ctx.theme.colors.primary, x: Math.round(frame.x + padding), y: Math.round(top + (titleH - iconSize) / 2), w: iconSize, h: iconSize });
  }
  elements.push(textElement(
    { x: frame.x + padding + iconW, y: top, w: innerW, h: titleH + 4 },
    [{ runs: headingRuns(input.title, titleSize, ctx.theme.colors.text, ctx.theme) }],
  ));
  if (input.body) {
    elements.push(textElement(
      { x: frame.x + padding + iconW, y: top + titleH + 8, w: innerW, h: bodyH + 4 },
      [{ runs: bodyRuns(input.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }],
    ));
  }
  return elements;
}

function expandT7(input: Input, ctx: PresetContext): PageSpec {
  const left = asObject(input.left, "T7 left");
  const right = asObject(input.right, "T7 right");
  const winner = enumValue(input, "winner", ["left", "right", "none"] as const, "none");
  const ratio = enumValue(input, "ratio", ["50/50", "62/38"] as const, "50/50");
  const parseSide = (side: Record<string, unknown>, what: string) => ({
    name: str(side, "name", { required: true, max: 12 }),
    points: list(side, "points", { required: true, min: 3, max: 5 }).map((v) => String(v).slice(0, 26)),
  });
  const leftSide = parseSide(left, "left");
  const rightSide = parseSide(right, "right");
  const [leftFrame, rightFrame] = splitByRatio(ctx.frame, ratio, ctx.G, true);
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  for (const [side, frame, isWinner] of [
    [leftSide, leftFrame, winner === "left"],
    [rightSide, rightFrame, winner === "right"],
  ] as const) {
    const fill = isWinner ? ctx.theme.colors.primarySoft : ctx.theme.colors.cardSurface;
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: Math.round(frame.h),
      fill,
      ...(isWinner ? { stroke: { color: ctx.theme.colors.primary, widthPt: 1.5 } } : {}),
    });
    const nameSize = Math.min(22, Math.max(18, ctx.theme.sizes.subtitle - 2));
    const nameH = singleLineBoxHeight(nameSize);
    elements.push(textElement(
      { x: frame.x + 24, y: frame.y + 24, w: frame.w - 48, h: nameH },
      [{ runs: headingRuns(side.name, nameSize, ctx.theme.colors.text, ctx.theme) }],
    ));
    const pointSize = 14;
    const pointH = estimateLineHeight(pointSize) * 1.6;
    side.points.forEach((point, i) => {
      elements.push(textElement(
        { x: frame.x + 24, y: frame.y + 40 + nameH + i * pointH, w: frame.w - 48, h: pointH },
        [{ runs: bodyRuns(point, pointSize, ctx.theme.colors.text, ctx.theme) }],
        "middle",
      ));
    });
  }
  const badgeSize = 64;
  const badgeX = (ctx.frame.w - badgeSize) / 2 + ctx.M;
  elements.push({
    type: "shape",
    shape: "ellipse",
    x: Math.round(badgeX),
    y: Math.round(ctx.frame.y + (ctx.frame.h - badgeSize) / 2),
    w: badgeSize,
    h: badgeSize,
    fill: ctx.theme.colors.primary,
    paragraphs: [{ runs: [{ text: "VS", sizePt: 20, bold: true, color: ctx.theme.colors.onDarkText, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }], align: "center" }],
    valign: "middle",
  });
  return { background: ctx.theme.colors.background, elements };
}

export const TABLE_PRESETS = {
  "T1": expandT1,
  "T2": expandT2,
  "T3": expandT3,
  "T4": expandT4,
  "T5": expandT5,
  "T6": expandT6,
  "T7": expandT7,
} as const;
