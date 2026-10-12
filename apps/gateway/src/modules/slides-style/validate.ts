/**
 * StyleParams 的校验、钳制与缺省合成。
 *
 * styler 子代理的输出只信一半：结构对、值域对才收，色值归一小写、
 * 字号钳进引擎区间、字体必须是词表内。任何缺失字段用确定性缺省
 * （defaultStyleParams 从聚类角色一步合成完整基线）兜住——styler
 * 是「复核与微调」，不是唯一产出方，链路离了它也能出参数。
 */

import type {
  StyleDecoration,
  StyleParams,
  StylePalette,
  StyleTypography,
} from "./types.js";
import { normalizeStyleHex } from "./types.js";
import type { PaletteRoles } from "./extract.js";
import { hexToRgb, mix, rgbToHex } from "./extract.js";

/** 引擎可用字体词表（macOS 内置栈；styler 只能从这里选）。 */
export const STYLE_FONT_OPTIONS = [
  "PingFang SC",
  "Inter, PingFang SC",
  "Hiragino Sans GB, PingFang SC",
  "Songti SC, Georgia",
  "Georgia, Times New Roman",
  "Yuanti SC",
] as const;
const DEFAULT_FONT = "PingFang SC";

/** layout 技能预设 id 形态（P1a / T3 / D2 / F6…）。 */
const LAYOUT_HINT_PATTERN = /^[PDTF]\d[ab]?$/;

function clampNumber(value: unknown, min: number, max: number, field: string, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (parsed < min || parsed > max) {
    throw new Error(`风格字段 ${field} 越界：${String(parsed)}（允许 ${String(min)}~${String(max)}）`);
  }
  return parsed;
}

function optionalHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`风格色值 ${field} 缺失`);
  return normalizeStyleHex(value, field);
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`风格字段 ${field} 越界：${JSON.stringify(value)}`);
  }
  return value as T;
}

function font(value: unknown, field: string): string {
  if (typeof value === "string" && (STYLE_FONT_OPTIONS as readonly string[]).includes(value)) return value;
  throw new Error(`风格字体 ${field} 不在词表内：${JSON.stringify(value)}`);
}

/** 图表系列色：主色同色调渐次 + 强调色收尾（确定性推导，可被显式值覆盖）。 */
export function deriveChartSeries(primary: string, accent: string, background: string): string[] {
  const p = hexToRgb(primary);
  const bg = hexToRgb(background);
  const ac = hexToRgb(accent);
  return [
    primary,
    rgbToHex(mix(p, bg, 0.3)),
    rgbToHex(mix(p, bg, 0.55)),
    accent,
    rgbToHex(mix(ac, bg, 0.3)),
  ];
}

export function normalizeStyleParams(raw: unknown): StyleParams {
  if (!raw || typeof raw !== "object") throw new Error("风格参数必须是对象");
  const row = raw as Record<string, unknown>;

  const paletteRow = row.palette as Record<string, unknown> | undefined;
  if (!paletteRow) throw new Error("风格参数缺少 palette");
  const chartSeries = Array.isArray(paletteRow.chartSeries) && paletteRow.chartSeries.length >= 3
    ? (paletteRow.chartSeries as unknown[]).slice(0, 6).map((item, index) => optionalHex(item, `chartSeries[${String(index)}]`))
    : deriveChartSeries(
      optionalHex(paletteRow.primary, "palette.primary"),
      optionalHex(paletteRow.accent, "palette.accent"),
      optionalHex(paletteRow.background, "palette.background"),
    );
  const palette: StylePalette = {
    background: optionalHex(paletteRow.background, "palette.background"),
    surface: optionalHex(paletteRow.surface, "palette.surface"),
    primary: optionalHex(paletteRow.primary, "palette.primary"),
    accent: optionalHex(paletteRow.accent, "palette.accent"),
    text: optionalHex(paletteRow.text, "palette.text"),
    textMuted: optionalHex(paletteRow.textMuted, "palette.textMuted"),
    onDarkText: optionalHex(paletteRow.onDarkText, "palette.onDarkText"),
    chartSeries,
  };

  const typoRow = row.typography as Record<string, unknown> | undefined;
  const sizesRow = (typoRow?.sizes ?? {}) as Record<string, unknown>;
  const typography: StyleTypography = {
    fontHeading: font(typoRow?.fontHeading ?? DEFAULT_FONT, "typography.fontHeading"),
    fontBody: font(typoRow?.fontBody ?? DEFAULT_FONT, "typography.fontBody"),
    sizes: {
      coverTitle: clampNumber(sizesRow.coverTitle, 40, 110, "sizes.coverTitle", 64),
      sectionTitle: clampNumber(sizesRow.sectionTitle, 28, 60, "sizes.sectionTitle", 40),
      pageTitle: clampNumber(sizesRow.pageTitle, 20, 40, "sizes.pageTitle", 28),
      subtitle: clampNumber(sizesRow.subtitle, 14, 24, "sizes.subtitle", 18),
      body: clampNumber(sizesRow.body, 12, 18, "sizes.body", 14),
      caption: clampNumber(sizesRow.caption, 9, 13, "sizes.caption", 11),
      kpi: clampNumber(sizesRow.kpi, 28, 90, "sizes.kpi", 44),
      table: clampNumber(sizesRow.table, 9, 24, "sizes.table", 13),
    },
    headingBold: typeof typoRow?.headingBold === "boolean" ? typoRow.headingBold : true,
  };

  const spacingRow = (row.spacing ?? {}) as Record<string, unknown>;
  const spacing = {
    margin: clampNumber(spacingRow.margin, 32, 96, "spacing.margin", 60),
    gutter: clampNumber(spacingRow.gutter, 8, 40, "spacing.gutter", 20),
    cardPadding: clampNumber(spacingRow.cardPadding, 8, 32, "spacing.cardPadding", 16),
    cornerRadius: clampNumber(spacingRow.cornerRadius, 0, 32, "spacing.cornerRadius", 8),
  };

  const decoRow = (row.decoration ?? {}) as Record<string, unknown>;
  const decoration: StyleDecoration = {
    cardStroke: decoRow.cardStroke == null ? null : optionalHex(decoRow.cardStroke, "decoration.cardStroke"),
    cardStrokeWidthPt: clampNumber(decoRow.cardStrokeWidthPt ?? 0.75, 0.25, 3, "decoration.cardStrokeWidthPt", 0.75),
    cardShadow: optionalEnum(decoRow.cardShadow ?? "none", ["none", "soft", "medium", "strong"] as const, "decoration.cardShadow"),
    divider: optionalEnum(decoRow.divider ?? "line", ["line", "none"] as const, "decoration.divider"),
    imageFit: optionalEnum(decoRow.imageFit ?? "cover", ["cover", "contain"] as const, "decoration.imageFit"),
  };

  const motifRow = (row.motif ?? {}) as Record<string, unknown>;
  const motifSpecRaw = (motifRow.spec ?? {}) as Record<string, unknown>;
  const motifSpec: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(motifSpecRaw).slice(0, 6)) {
    if (typeof value === "string" || typeof value === "number") motifSpec[key] = value;
  }

  const hintsRow = (row.layoutHints ?? {}) as Record<string, unknown>;
  const layoutHints: StyleParams["layoutHints"] = {};
  for (const role of ["cover", "section", "content", "closing"] as const) {
    const value = hintsRow[role];
    if (typeof value === "string" && LAYOUT_HINT_PATTERN.test(value)) layoutHints[role] = value;
  }

  const effectLines = Array.isArray(row.effectLines)
    ? (row.effectLines as unknown[])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 120))
      .slice(0, 10)
    : [];

  return {
    palette,
    typography,
    spacing,
    decoration,
    motif: {
      kind: optionalEnum(motifRow.kind ?? "none",
        ["ghost-number", "ghost-word", "color-band", "corner-accent", "none"] as const, "motif.kind"),
      spec: motifSpec,
    },
    layoutHints,
    darkCover: typeof row.darkCover === "boolean" ? row.darkCover : true,
    effectLines,
  };
}

/** 从聚类角色一步合成完整合法基线（styler 缺省/失败时的兜底，也是自校起点）。 */
export function defaultStyleParams(
  roles: PaletteRoles,
  options: { cornerRadius?: number; shadow?: StyleDecoration["cardShadow"] } = {},
): StyleParams {
  return normalizeStyleParams({
    palette: {
      background: roles.background,
      surface: roles.surface,
      primary: roles.primary,
      accent: roles.accent,
      text: roles.text,
      textMuted: roles.textMuted,
      onDarkText: roles.onDarkText,
      chartSeries: deriveChartSeries(roles.primary, roles.accent, roles.background),
    },
    typography: {
      fontHeading: DEFAULT_FONT,
      fontBody: DEFAULT_FONT,
      sizes: {},
      headingBold: true,
    },
    spacing: {
      margin: 60,
      gutter: 20,
      cardPadding: 16,
      cornerRadius: options.cornerRadius ?? 8,
    },
    decoration: {
      cardStroke: null,
      cardStrokeWidthPt: 0.75,
      cardShadow: options.shadow ?? "none",
      divider: "line",
      imageFit: "cover",
    },
    motif: { kind: "none", spec: {} },
    layoutHints: {},
    darkCover: roles.darkCover,
    effectLines: [],
  });
}
