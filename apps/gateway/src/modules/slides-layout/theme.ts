/**
 * 预设展开的主题解析：styleParams（slides-styler 风格卡，键名以
 * agents/slides-styler/schemas/output.schema.json 为真源）→ 展开器直接可用的
 * 主题对象。styleParams 缺失时用与 layout 技能文档口径一致的缺省主题。
 * 坐标、字号、配色全部在这里定：预设描述符只管结构，不管取值。
 */

export interface StyleParamsInput {
  palette?: {
    background?: string;
    surface?: string;
    primary?: string;
    accent?: string;
    text?: string;
    textMuted?: string;
    onDarkText?: string;
    chartSeries?: string[];
  };
  typography?: {
    fontHeading?: string;
    fontBody?: string;
    sizes?: Partial<Record<
      "coverTitle" | "sectionTitle" | "pageTitle" | "subtitle" | "body" | "caption" | "kpi" | "table",
      number
    >>;
    headingBold?: boolean;
  };
  spacing?: Partial<{ margin: number; gutter: number; cardPadding: number; cornerRadius: number }>;
  decoration?: Partial<{
    cardStroke: string | null;
    cardStrokeWidthPt: number;
    cardShadow: "none" | "soft" | "medium" | "strong";
    divider: "line" | "none";
    imageFit: "cover" | "contain";
  }>;
  darkCover?: boolean;
}

export interface ResolvedTheme {
  colors: {
    background: string;
    surface: string;
    primary: string;
    accent: string;
    text: string;
    textMuted: string;
    onDarkText: string;
    chartSeries: string[];
    /** 分隔线/行线：文字色向底色混 82%。 */
    divider: string;
    /** 深色页（封面/章节）背景：主色向近黑压深。 */
    darkBackground: string;
    /** 卡面：底色提亮一档（深底页略提亮）。 */
    cardSurface: string;
    /** 主色浅档（我方列提亮/当前阶段底）。 */
    primarySoft: string;
  };
  fonts: { heading: string; body: string; headingBold: boolean };
  sizes: {
    coverTitle: number;
    sectionTitle: number;
    pageTitle: number;
    subtitle: number;
    body: number;
    caption: number;
    kpi: number;
    table: number;
  };
  spacing: { margin: number; gutter: number; cardPadding: number; cornerRadius: number };
  decoration: {
    cardStroke: string | null;
    cardStrokeWidthPt: number;
    cardShadow: "none" | "soft" | "medium" | "strong";
    divider: "line" | "none";
    imageFit: "cover" | "contain";
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(hex: string | undefined, fallback: string): string {
  if (typeof hex !== "string") return fallback;
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1]!.toLowerCase()}` : fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/** a 向 b 混 mix 比例（0=a，1=b）。 */
export function mixHex(a: string, b: string, mix: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex([r1 + (r2 - r1) * mix, g1 + (g2 - g1) * mix, b1 + (b2 - b1) * mix]);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.35;
}

/** 卡面从页底推导：浅底提亮一档，深底略提亮（SYSTEM.md 卡片底色口径）。 */
export function deriveCardSurface(background: string): string {
  return isDarkColor(background)
    ? mixHex(background, "#FFFFFF", 0.12)
    : mixHex(background, "#FFFFFF", 0.55);
}

const DEFAULTS = {
  palette: {
    background: "#FFFFFF",
    surface: "#F3F4F6",
    primary: "#1E5A8A",
    accent: "#C2703D",
    text: "#1F2430",
    textMuted: "#6B7280",
    onDarkText: "#F5F7FA",
    chartSeries: ["#1E5A8A", "#C2703D", "#5B8C5A", "#8A6FB1", "#B34040", "#3E7C8C"],
  },
  fonts: { heading: "", body: "", headingBold: true },
  sizes: { coverTitle: 64, sectionTitle: 44, pageTitle: 32, subtitle: 20, body: 14, caption: 12, kpi: 64, table: 14 },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 12 },
  decoration: {
    cardStroke: null,
    cardStrokeWidthPt: 0.75,
    cardShadow: "soft" as const,
    divider: "line" as const,
    imageFit: "cover" as const,
  },
};

/** 把 4 的倍数取整（layout 技能：全篇间距只取 4 的倍数）。 */
export function snap4(value: number): number {
  return Math.round(value / 4) * 4;
}

export function resolveTheme(styleParams?: StyleParamsInput | null): ResolvedTheme {
  const palette = styleParams?.palette ?? {};
  const typography = styleParams?.typography ?? {};
  const spacing = styleParams?.spacing ?? {};
  const decoration = { ...DEFAULTS.decoration, ...(styleParams?.decoration ?? {}) };

  const background = normalizeHex(palette.background, DEFAULTS.palette.background);
  const primary = normalizeHex(palette.primary, DEFAULTS.palette.primary);
  // 深底色板未显式给 text 时回落亮色，避免深底黑字。
  const defaultText = isDarkColor(background) ? "#F5F7FA" : DEFAULTS.palette.text;
  const text = normalizeHex(palette.text, defaultText);
  const textMuted = normalizeHex(palette.textMuted, mixHex(text, background, 0.45));
  const chartSeries = (palette.chartSeries ?? DEFAULTS.palette.chartSeries)
    .slice(0, 6)
    .map((hex) => normalizeHex(hex, primary));

  const sizes = { ...DEFAULTS.sizes, ...(typography.sizes ?? {}) };
  sizes.coverTitle = clamp(sizes.coverTitle, 40, 110);
  sizes.sectionTitle = clamp(sizes.sectionTitle, 28, 60);
  sizes.pageTitle = clamp(sizes.pageTitle, 20, 40);
  sizes.subtitle = clamp(sizes.subtitle, 14, 24);
  sizes.body = clamp(sizes.body, 12, 18);
  sizes.caption = clamp(sizes.caption, 9, 13);
  sizes.kpi = clamp(sizes.kpi, 28, 90);
  sizes.table = clamp(sizes.table, 9, 24);

  const margin = clamp(Math.round(spacing.margin ?? DEFAULTS.spacing.margin), 32, 96);
  const gutter = clamp(Math.round(spacing.gutter ?? DEFAULTS.spacing.gutter), 8, 40);

  return {
    colors: {
      background,
      surface: normalizeHex(palette.surface, deriveCardSurface(background)),
      primary,
      accent: normalizeHex(palette.accent, DEFAULTS.palette.accent),
      text,
      textMuted,
      onDarkText: normalizeHex(palette.onDarkText, DEFAULTS.palette.onDarkText),
      chartSeries,
      divider: mixHex(text, background, 0.82),
      darkBackground: mixHex(primary, "#0C1017", 0.68),
      cardSurface: normalizeHex(palette.surface, deriveCardSurface(background)),
      primarySoft: mixHex(primary, background, 0.82),
    },
    fonts: {
      heading: typography.fontHeading ?? DEFAULTS.fonts.heading,
      body: typography.fontBody ?? DEFAULTS.fonts.body,
      headingBold: typography.headingBold ?? DEFAULTS.fonts.headingBold,
    },
    sizes,
    spacing: {
      margin: snap4(margin),
      gutter: snap4(gutter),
      cardPadding: clamp(Math.round(spacing.cardPadding ?? DEFAULTS.spacing.cardPadding), 8, 32),
      cornerRadius: clamp(Math.round(spacing.cornerRadius ?? DEFAULTS.spacing.cornerRadius), 0, 32),
    },
    decoration,
  };
}
