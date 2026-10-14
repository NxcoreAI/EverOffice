/**
 * D 系预设：KPI 数字带 D1、结论横幅+数据行 D2、全宽图表 D3、
 * 散点定位 D4、图表+侧栏结论 D5。
 */

import { splitByRatio, splitColumns, splitRows, type Frame } from "../grid.js";
import {
  card,
  headingRuns,
  textElement,
  type ChartElement,
  type PageSpec,
  type SpecElement,
} from "../elements.js";
import { asObject, enumValue, list, objects, str } from "../parse.js";
import { banner, pageTitle, parseStat, statCell, type PresetContext } from "../preset-common.js";
import { estimateLines, estimateLineHeight } from "../text-metrics.js";
import { bodyRuns } from "../elements.js";

type Input = Record<string, unknown>;

/** 图表入参 → 引擎 chart 元素（系列数/点数校验 + 主题系列色）。 */
export function buildChart(raw: unknown, frame: Frame, ctx: PresetContext, what: string): ChartElement {
  const input = asObject(raw, what);
  const kind = enumValue(input, "chart", ["bar", "barStacked", "line", "pie", "doughnut", "scatter", "comboBarLine"] as const, "bar");
  const categories = list(input, "categories", { required: true, min: 2, max: 24 }).map((v) => String(v).slice(0, 24));
  const seriesRaw = objects(list(input, "series", { required: true, min: 1, max: 6 }), `${what} series`);
  const series = seriesRaw.map((s) => {
    const values = list(s, "values", { required: true }).map((v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`PRESET_INVALID: ${what} series 的 values 必须全是数字（与 categories 等长）`);
      return v;
    });
    if (values.length !== categories.length) {
      throw new Error(`PRESET_INVALID: ${what} 系列「${str(s, "name", { max: 20 })}」的 values 数量（${values.length}）必须等于 categories（${categories.length}）`);
    }
    return { name: str(s, "name", { required: true, max: 20 }), values };
  });
  if (kind === "comboBarLine" && series.length < 2) {
    throw new Error("PRESET_INVALID: comboBarLine 必须至少 2 个系列（最后一个是折线走右轴）");
  }
  const points = categories.length;
  return {
    type: "chart",
    chart: kind,
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    categories,
    series,
    colors: ctx.theme.colors.chartSeries.slice(0, Math.max(series.length, kind === "pie" || kind === "doughnut" ? points : series.length)),
    ...(points <= 8 && kind !== "scatter" ? { dataLabels: true } : {}),
  };
}

function statsArea(statsInput: unknown[], frame: Frame, ctx: PresetContext, focusFirst: boolean): SpecElement[] {
  const stats = statsInput.map(parseStat);
  if (stats.length === 4) {
    const cells = splitColumns(frame, 4, ctx.G);
    return stats.flatMap((s, i) => statCell(s, cells[i]!, ctx, focusFirst && i === 0));
  }
  if (stats.length === 2 || stats.length === 3) {
    const cells = splitColumns(frame, stats.length, ctx.G);
    return stats.flatMap((s, i) => statCell(s, cells[i]!, ctx, focusFirst && i === 0));
  }
  if (stats.length === 5 || stats.length === 6) {
    const rows = splitRows(frame, 2, ctx.G);
    const top = splitColumns(rows[0]!, Math.ceil(stats.length / 2), ctx.G);
    const bottom = splitColumns(rows[1]!, Math.floor(stats.length / 2), ctx.G);
    const cells = [...top, ...bottom];
    return stats.flatMap((s, i) => statCell(s, cells[i]!, ctx, focusFirst && i === 0));
  }
  throw new Error(`PRESET_INVALID: 数字格数量须为 2~6，收到 ${stats.length}`);
}

function expandD1(input: Input, ctx: PresetContext): PageSpec {
  const statsInput = list(input, "stats", { required: true, min: 2, max: 6 });
  const focusFirst = input.focusFirst === false ? false : true;
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  if (input.chart !== undefined) {
    const statsFrame = { x: ctx.M, y: ctx.frame.y, w: ctx.frame.w, h: 300 };
    elements.push(...statsArea(statsInput, statsFrame, ctx, focusFirst));
    elements.push(buildChart(input.chart, { x: ctx.M, y: ctx.frame.y + 320, w: ctx.frame.w, h: ctx.frame.h - 320 }, ctx, "D1 图表"));
  } else {
    elements.push(...statsArea(statsInput, ctx.frame, ctx, focusFirst));
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandD2(input: Input, ctx: PresetContext): PageSpec {
  const bannerInput = asObject(input.banner, "D2 banner");
  const bannerText = str(bannerInput, "text", { required: true, max: 40 });
  const bannerValue = str(bannerInput, "value", { max: 16 });
  const statsInput = list(input, "stats", { required: true, min: 2, max: 6 });
  const elements: SpecElement[] = [
    ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
    ...banner(bannerText, bannerValue || undefined, { x: ctx.M, y: ctx.frame.y, w: ctx.frame.w, h: 72 }, ctx),
  ];
  elements.push(...statsArea(statsInput, { x: ctx.M, y: ctx.frame.y + 100, w: ctx.frame.w, h: ctx.frame.h - 100 }, ctx, false));
  return { background: ctx.theme.colors.background, elements };
}

function expandD3(input: Input, ctx: PresetContext): PageSpec {
  return {
    background: ctx.theme.colors.background,
    elements: [
      ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
      buildChart(input.chart, ctx.frame, ctx, "D3 图表"),
    ],
  };
}

function sideCards(input: unknown, frame: Frame, ctx: PresetContext, what: string): SpecElement[] {
  const cards = objects(list(asObject({ v: input }, what), "v", { required: true, min: 2, max: 3 }), what).map((c) => ({
    title: str(c, "title", { required: true, max: 24 }),
    body: str(c, "body", { required: true, max: 90 }),
  }));
  const rows = splitRows(frame, cards.length, ctx.G);
  return cards.flatMap((c, i) => {
    const frameRow = rows[i]!;
    const padding = ctx.theme.spacing.cardPadding;
    const innerW = frameRow.w - padding * 2;
    const titleSize = 15;
    const bodySize = 13;
    const titleH = estimateLines(c.title, titleSize, innerW) * estimateLineHeight(titleSize);
    const bodyH = estimateLines(c.body, bodySize, innerW) * estimateLineHeight(bodySize);
    const total = titleH + 8 + bodyH;
    if (total > frameRow.h - padding * 2) throw new Error(`PRESET_INVALID: ${what}第 ${i + 1} 卡内容超高——精简结论文字`);
    return [
      card(frameRow, ctx.theme),
      textElement(
        { x: frameRow.x + padding, y: frameRow.y + (frameRow.h - total) / 2, w: innerW, h: titleH + 4 },
        [{ runs: headingRuns(c.title, titleSize, ctx.theme.colors.text, ctx.theme) }],
      ),
      textElement(
        { x: frameRow.x + padding, y: frameRow.y + (frameRow.h - total) / 2 + titleH + 8, w: innerW, h: bodyH + 4 },
        [{ runs: bodyRuns(c.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }],
      ),
    ];
  });
}

function expandD4(input: Input, ctx: PresetContext): PageSpec {
  const chartInput = asObject(input.chart, "D4 chart");
  const ratio = enumValue(input, "ratio", ["70/30", "62/38"] as const, "70/30");
  const [chartFrame, sideFrame] = splitByRatio(ctx.frame, ratio, ctx.G, true);
  return {
    background: ctx.theme.colors.background,
    elements: [
      ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
      buildChart({ ...chartInput, chart: "scatter" }, chartFrame, ctx, "D4 散点图"),
      ...sideCards(input.cards, sideFrame, ctx, "D4 侧栏"),
    ],
  };
}

function expandD5(input: Input, ctx: PresetContext): PageSpec {
  const ratio = enumValue(input, "ratio", ["70/30", "62/38"] as const, "70/30");
  const [chartFrame, sideFrame] = splitByRatio(ctx.frame, ratio, ctx.G, true);
  return {
    background: ctx.theme.colors.background,
    elements: [
      ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
      buildChart(input.chart, chartFrame, ctx, "D5 图表"),
      ...sideCards(input.cards, sideFrame, ctx, "D5 侧栏"),
    ],
  };
}

export const DATA_PRESETS = {
  "D1": expandD1,
  "D2": expandD2,
  "D3": expandD3,
  "D4": expandD4,
  "D5": expandD5,
} as const;
