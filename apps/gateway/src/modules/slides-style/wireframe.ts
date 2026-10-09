/**
 * 骨架线框：布局配方数据 → SVG（给风格卡展示，参数的可视化）。
 *
 * 方案纪律：线框从数据渲染、不经过生图与提取；每个页型一套具名配方，
 * 盒子比例与 spacing.margin/gutter 联动。前端拿 SVG 字符串直接内联。
 */

import type { StyleSpacing } from "./types.js";

export type WireframeFillKind = "title" | "content" | "media" | "chart" | "accent";

export interface WireframeBox {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: WireframeFillKind;
}

export type WireframeRole =
  | "cover"
  | "section"
  | "content"
  | "data"
  | "table"
  | "flow"
  | "closing";

const CANVAS_W = 1280;
const CANVAS_H = 720;
const TITLE_H = 64;

/** 每个页型的默认配方（与 layout 技能的网格约定同源：内容区 1160×540）。 */
export function wireframeForRole(role: WireframeRole, spacing: StyleSpacing): WireframeBox[] {
  const m = spacing.margin;
  const gutter = spacing.gutter;
  const contentW = CANVAS_W - m * 2;
  const titleY = Math.max(84, m);
  const bodyY = titleY + TITLE_H + gutter * 2;
  const bodyH = CANVAS_H - bodyY - m;

  switch (role) {
    case "cover":
      return [
        { label: "大标题", x: m, y: 260, w: Math.round(contentW * 0.62), h: 96, kind: "title" },
        { label: "副标题", x: m, y: 380, w: Math.round(contentW * 0.4), h: 28, kind: "content" },
        { label: "色块/母题", x: 0, y: 0, w: CANVAS_W, h: 240, kind: "accent" },
      ];
    case "section":
      return [
        { label: "章节号", x: m, y: 250, w: 72, h: 72, kind: "accent" },
        { label: "章节标题", x: m + 72 + gutter, y: 262, w: Math.round(contentW * 0.5), h: 56, kind: "title" },
      ];
    case "content":
      return [
        { label: "页标题", x: m, y: titleY, w: Math.round(contentW * 0.55), h: TITLE_H, kind: "title" },
        { label: "要点 1", x: m, y: bodyY, w: Math.round(contentW * 0.55), h: Math.round((bodyH - gutter * 2) / 3), kind: "content" },
        { label: "要点 2", x: m, y: bodyY + (bodyH - gutter * 2) / 3 + gutter, w: Math.round(contentW * 0.55), h: Math.round((bodyH - gutter * 2) / 3), kind: "content" },
        { label: "要点 3", x: m, y: bodyY + ((bodyH - gutter * 2) / 3) * 2 + gutter * 2, w: Math.round(contentW * 0.55), h: Math.round((bodyH - gutter * 2) / 3), kind: "content" },
        { label: "配图", x: m + Math.round(contentW * 0.55) + gutter, y: bodyY, w: Math.round(contentW * 0.45) - gutter, h: bodyH, kind: "media" },
      ];
    case "data":
      return [
        { label: "页标题", x: m, y: titleY, w: Math.round(contentW * 0.55), h: TITLE_H, kind: "title" },
        { label: "图表", x: m, y: bodyY, w: Math.round(contentW * 0.6), h: bodyH, kind: "chart" },
        { label: "KPI", x: m + Math.round(contentW * 0.6) + gutter, y: bodyY, w: Math.round(contentW * 0.4) - gutter, h: Math.round(bodyH * 0.42), kind: "accent" },
        { label: "结论卡", x: m + Math.round(contentW * 0.6) + gutter, y: bodyY + Math.round(bodyH * 0.42) + gutter, w: Math.round(contentW * 0.4) - gutter, h: Math.round(bodyH * 0.58) - gutter, kind: "content" },
      ];
    case "table":
      return [
        { label: "页标题", x: m, y: titleY, w: Math.round(contentW * 0.55), h: TITLE_H, kind: "title" },
        { label: "表格", x: m, y: bodyY, w: contentW, h: bodyH, kind: "chart" },
      ];
    case "flow":
      return [
        { label: "页标题", x: m, y: titleY, w: Math.round(contentW * 0.55), h: TITLE_H, kind: "title" },
        { label: "步骤 1", x: m, y: bodyY, w: Math.round((contentW - gutter * 2) / 3), h: bodyH * 0.6, kind: "content" },
        { label: "步骤 2", x: m + Math.round((contentW - gutter * 2) / 3) + gutter, y: bodyY, w: Math.round((contentW - gutter * 2) / 3), h: bodyH * 0.6, kind: "content" },
        { label: "步骤 3", x: m + Math.round((contentW - gutter * 2) / 3) * 2 + gutter * 2, y: bodyY, w: Math.round((contentW - gutter * 2) / 3), h: bodyH * 0.6, kind: "content" },
      ];
    case "closing":
      return [
        { label: "结语大字", x: m, y: 300, w: Math.round(contentW * 0.7), h: 88, kind: "title" },
      ];
  }
}

const KIND_FILL: Record<WireframeFillKind, string> = {
  title: "#3d4a5c",
  content: "#aeb6bf",
  media: "#c9cfd6",
  chart: "#8f9ba8",
  accent: "#5f6f84",
};

/** 渲染成 320×180 的 SVG 字符串（内联给风格卡；label 用固定词表，无转义风险）。 */
export function renderWireframeSvg(boxes: WireframeBox[]): string {
  const scaleX = 320 / CANVAS_W;
  const scaleY = 180 / CANVAS_H;
  const parts = boxes.map((box) => {
    const x = (box.x * scaleX).toFixed(1);
    const y = (box.y * scaleY).toFixed(1);
    const w = (box.w * scaleX).toFixed(1);
    const h = (box.h * scaleY).toFixed(1);
    const label = box.label;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="${KIND_FILL[box.kind]}"/>`
      + `<text x="${x}" y="${(box.y * scaleY + 11).toFixed(1)}" font-size="7" fill="#f6f7f9" font-family="system-ui">${label}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180" role="img">`
    + `<rect width="320" height="180" fill="#eef0f3"/>${parts.join("")}</svg>`;
}
