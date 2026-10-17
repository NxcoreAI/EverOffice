/**
 * chevron 组件（editorial）。箭头改描边空心（透明填充 + 墨色发丝描边），
 * 文字压在箭头上，不再用色面交替。
 *
 * 几何（2026-10-17 修复文字压棱线）：形状收窄到 CONTENT_H 并垂直居中——
 * OOXML 尖深固定为 min(w,h)÷2，压短高度即收小尖角；列距 = (版心−尖深)÷段数、
 * 形状宽 = 列距+尖深，右尖顶点恰伸至下一形状左凹底，链条连续相扣；
 * 文字对「身体区」水平居中：homePlate 段 = [左缘, 右斜边起点]、
 * chevron 段 = [凹底, 右斜边起点]（宽 = 列距−尖深），文字不碰任何棱线。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { textBoxHeight } from "../../text-metrics.js";

export interface ChevronItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const CONTENT_H = 230;

export function expandChevron(items: ChevronItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const titleSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const textSize = theme.sizes.caption;
  const shapeH = Math.min(Math.round(frame.h), CONTENT_H);
  const y0 = Math.round(frame.y + (frame.h - shapeH) / 2);
  let tip = Math.round(shapeH / 2);
  const step = Math.max(1, Math.floor((frame.w - tip) / items.length));
  const shapeW = step + tip;
  if (shapeW < shapeH) tip = Math.round(shapeW / 2); // 极窄区域退化：短边移到宽度，尖深随之收小
  items.forEach((item, i) => {
    const first = i === 0;
    const x = Math.round(frame.x + i * step);
    const isHome = first; // 首段平左缘（homePlate），其余带左凹（chevron）
    const bodyX = isHome ? x : x + tip;
    const bodyW = isHome ? step : step - tip;
    const textW = Math.max(40, Math.min(180, bodyW - 16));
    const titleH = textBoxHeight(item.title, titleSize, textW);
    const textH = item.text ? textBoxHeight(item.text, textSize, textW) : 0;
    const need = titleH + (textH ? 4 + textH : 0) + 24;
    if (need > shapeH) {
      bad(`${what} 第 ${i + 1} 段「${item.title}」内容高约 ${Math.round(need)}px 超过 ${Math.round(shapeH)}px——精简文字或减少段数`);
    }
    elements.push({
      type: "shape",
      shape: isHome ? "homePlate" : "chevron",
      fill: "#00000000",
      stroke: { color: theme.colors.text, widthPt: 1 },
      x,
      y: y0,
      w: Math.round(shapeW),
      h: shapeH,
    });
    const top = y0 + (shapeH - need + 24) / 2;
    elements.push(
      textElement({ x: Math.round(bodyX + (bodyW - textW) / 2), y: top, w: textW, h: titleH }, [
        { runs: bodyRuns(item.title, titleSize, theme.colors.text, theme, true), align: "center" },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: Math.round(bodyX + (bodyW - textW) / 2), y: top + titleH + 4, w: textW, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme), align: "center" },
        ]),
      );
    }
  });
  return elements;
}
