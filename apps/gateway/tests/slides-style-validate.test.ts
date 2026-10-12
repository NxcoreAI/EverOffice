import { describe, expect, it } from "vitest";
import { defaultStyleParams, deriveChartSeries, normalizeStyleParams } from "../src/modules/slides-style/validate.js";
import type { PaletteRoles } from "../src/modules/slides-style/extract.js";

const roles: PaletteRoles = {
  background: "#f5f2ec",
  surface: "#faf9f6",
  primary: "#1e3a5f",
  accent: "#e0a03c",
  text: "#2f2b28",
  textMuted: "#8f8a81",
  onDarkText: "#f2f4f7",
  darkCover: true,
};

const validParams = {
  palette: {
    background: "#F5F2EC",
    surface: "#faf9f6",
    primary: "#1e3a5f",
    accent: "#e0a03c",
    text: "#2f2b28",
    textMuted: "#8f8a81",
    onDarkText: "#f2f4f7",
  },
  typography: {
    fontHeading: "PingFang SC",
    fontBody: "PingFang SC",
    sizes: {
      coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 18,
      body: 14, caption: 11, kpi: 44, table: 13,
    },
    headingBold: true,
  },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 12 },
  decoration: { cardStroke: "#e5e0d5", cardStrokeWidthPt: 0.75, cardShadow: "soft", divider: "line", imageFit: "cover" },
  motif: { kind: "ghost-number", spec: { alphaPercent: 15 } },
  layoutHints: { cover: "P1a", content: "T3" },
  darkCover: true,
  effectLines: ["主色 深藏青 #1E3A5F", "标题 40pt 加粗", "  ", "卡片小圆角、轻投影"],
};

describe("normalizeStyleParams", () => {
  it("normalizes hex to lowercase and sanitizes effect lines", () => {
    const params = normalizeStyleParams(validParams);
    expect(params.palette.background).toBe("#f5f2ec");
    expect(params.effectLines).toEqual(["主色 深藏青 #1E3A5F", "标题 40pt 加粗", "卡片小圆角、轻投影"]);
    expect(params.layoutHints.cover).toBe("P1a");
  });

  it("derives chart series from primary/accent/background when absent", () => {
    const params = normalizeStyleParams(validParams);
    expect(params.palette.chartSeries[0]).toBe("#1e3a5f");
    expect(params.palette.chartSeries).toHaveLength(5);
    expect(new Set(params.palette.chartSeries).size).toBe(5);
  });

  it("keeps an explicit chart series", () => {
    const params = normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, chartSeries: ["#111111", "#222222", "#333333"] },
    });
    expect(params.palette.chartSeries).toEqual(["#111111", "#222222", "#333333"]);
  });

  it("throws on out-of-range sizes and bad hex", () => {
    expect(() => normalizeStyleParams({
      ...validParams,
      typography: { ...validParams.typography, sizes: { ...validParams.typography.sizes, body: 40 } },
    })).toThrow(/sizes\.body/);
    expect(() => normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, primary: "blue" },
    })).toThrow(/palette\.primary/);
  });

  it("rejects fonts outside the vocabulary", () => {
    expect(() => normalizeStyleParams({
      ...validParams,
      typography: { ...validParams.typography, fontHeading: "Comic Sans" },
    })).toThrow(/fontHeading/);
  });

  it("rejects invalid layout hint ids", () => {
    const params = normalizeStyleParams({
      ...validParams,
      layoutHints: { cover: "Z99", content: "P1a" },
    });
    expect(params.layoutHints.cover).toBeUndefined();
    expect(params.layoutHints.content).toBe("P1a");
  });
});

describe("defaultStyleParams", () => {
  it("builds a fully valid baseline from roles", () => {
    const params = defaultStyleParams(roles, { cornerRadius: 12, shadow: "soft" });
    // 再走一遍严格归一证明自洽。
    expect(normalizeStyleParams(params)).toEqual(params);
    expect(params.spacing.cornerRadius).toBe(12);
    expect(params.decoration.cardShadow).toBe("soft");
    expect(params.palette.chartSeries[0]).toBe("#1e3a5f");
    expect(params.typography.fontHeading).toBe("PingFang SC");
  });
});

describe("deriveChartSeries", () => {
  it("keeps the primary first and stays distinguishable", () => {
    const series = deriveChartSeries("#1e3a5f", "#e0a03c", "#f5f2ec");
    expect(series[0]).toBe("#1e3a5f");
    expect(series[3]).toBe("#e0a03c");
    expect(new Set(series).size).toBe(5);
  });
});
