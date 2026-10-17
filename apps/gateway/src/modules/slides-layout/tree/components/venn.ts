/**
 * venn 组件（editorial）。双圆 8% 主色透明填充 + 墨色发丝描边：
 * 交叠处自然叠深一档，交集区可见。圆心距按透镜宽反推（d = 2r − lens），
 * 标签各归其位：两侧对月牙中心、交集对透镜中心，不压弧线。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface VennInput {
  a: string;
  b: string;
  both?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandVenn(input: VennInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const labelSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const labelH = singleLineBoxHeight(labelSize);
  const rx = Math.min(frame.w * 0.3, frame.h * 0.42);
  const ry = Math.min(frame.h * 0.4, rx * 1.05);
  if (ry < 60) {
    bad(`${what} 区域过小（高 ${Math.round(frame.h)}px）——加大该子树权重`);
  }
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  // 透镜宽：目标 140px，小区域按半径收缩（0.6r 下限由上方 ry 闸兜底）
  const lens = Math.min(140, Math.round(rx * 0.6));
  const d = 2 * rx - lens;
  const ax = cx - d / 2;
  const bx = cx + d / 2;
  const labelW = Math.min(frame.w * 0.24, 200);
  const bothW = Math.min(lens - 8, 160);
  if (input.both && bothW < 40) {
    bad(`${what} 交集标签放不下（透镜 ${Math.round(lens)}px 宽）——缩短标签或加大该子树权重`);
  }
  // 标签框：两侧对月牙中心（跨度 = 圆心距 d），交集对透镜中心
  const aBox = { x: Math.round(cx - rx - labelW / 2), y: Math.round(cy - labelH / 2), w: Math.round(labelW), h: labelH };
  const bBox = { x: Math.round(cx + rx - labelW / 2), y: Math.round(cy - labelH / 2), w: Math.round(labelW), h: labelH };
  const bothBox = input.both
    ? { x: Math.round(cx - bothW / 2), y: Math.round(cy - labelH / 2), w: Math.round(bothW), h: labelH }
    : undefined;
  if (aBox.x + aBox.w > (bothBox ?? bBox).x - 8 || (bothBox !== undefined && bothBox.x + bothBox.w > bBox.x + 8)) {
    bad(`${what} 标签放不下（区域 ${Math.round(frame.w)}px 宽）——缩短两侧与交集标签`);
  }

  const circle = (x: number): SpecElement => ({
    type: "shape",
    shape: "ellipse",
    fill: `${theme.colors.primary}14`,
    stroke: { color: theme.colors.text, widthPt: 1.25 },
    x: Math.round(x),
    y: Math.round(cy - ry),
    w: Math.round(rx * 2),
    h: Math.round(ry * 2),
  });
  const elements: SpecElement[] = [circle(ax - rx), circle(bx - rx)];
  elements.push(textElement(aBox, [{ runs: bodyRuns(input.a, labelSize, theme.colors.text, theme, true), align: "center" }]));
  if (input.both !== undefined && bothBox !== undefined) {
    elements.push(textElement(bothBox, [{ runs: bodyRuns(input.both, theme.sizes.caption, theme.colors.primary, theme, true), align: "center" }]));
  }
  elements.push(textElement(bBox, [{ runs: bodyRuns(input.b, labelSize, theme.colors.text, theme, true), align: "center" }]));
  return elements;
}
