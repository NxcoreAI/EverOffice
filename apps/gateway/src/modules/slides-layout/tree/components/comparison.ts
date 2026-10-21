/**
 * comparison：多方对照。每方一张卡（风格卡卡面），featured 用浅色底 + 强调描边 +
 * 顶部色条 + 徽章；标题/要点字号按 frame 推导，卡片填满高度。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, estimateTextWidth } from "../../text-metrics.js";

export interface ComparisonPoint {
  text: string;
  mark?: "yes" | "mid" | "no";
}

export interface ComparisonSide {
  title: string;
  tag?: string;
  points: Array<string | ComparisonPoint>;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const MARK_ICONS: Record<"yes" | "mid" | "no", string> = {
  yes: "check-circle",
  mid: "minus",
  no: "x-mark",
};

export function expandComparison(
  sides: ComparisonSide[],
  featured: number | undefined,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const m = skin.metrics(frame);
  const cells = splitColumns(frame, sides.length, m.gap);
  const elements: SpecElement[] = [];
  const titleSize = Math.round(m.title * 0.86);
  const pointSize = m.body;
  const iconSize = Math.max(16, Math.round(pointSize * 0.95));
  const hasFeatured = featured !== undefined;
  const rendered = sides.map((side, i) => {
    const cell = cells[i]!;
    const isFeatured = featured === i;
    const box = skin.contentBox(cell);
    const titleH = estimateLines(side.title, titleSize, box.w) * estimateLineHeight(titleSize, 108) + 4;
    const pointsH = side.points.map((point) => {
      const text = typeof point === "string" ? point : point.text;
      return estimateLines(text, pointSize, box.w - iconSize - 10) * estimateLineHeight(pointSize, 122) + Math.round(m.tightGap * 1.1);
    });
    return { side, cell, isFeatured, box, titleH, pointsH };
  });
  rendered.forEach(({ side, cell, isFeatured, box, titleH, pointsH }) => {
    if (isFeatured) {
      const radius = Math.min(50000, Math.round((skin.radius / Math.max(1, Math.min(cell.w, cell.h))) * 100000));
      elements.push({
        type: "shape", shape: "roundRect", fill: skin.colors.tint,
        stroke: { color: skin.colors.emphasis, widthPt: 1.5 },
        x: Math.round(cell.x), y: Math.round(cell.y), w: Math.round(cell.w), h: Math.round(cell.h),
        ...(radius ? { adj: radius } : {}),
      });
      elements.push({
        type: "shape", shape: "rect", fill: skin.colors.emphasis,
        x: Math.round(box.x), y: Math.round(cell.y), w: Math.round(box.w), h: 4,
      });
      const badgeText = side.tag ?? "推荐";
      const badgeW = Math.max(58, Math.round(estimateTextWidth(badgeText, 10) + 26));
      elements.push({
        type: "shape", shape: "roundRect", fill: skin.colors.emphasis,
        x: Math.round(box.x + box.w - badgeW), y: Math.round(box.y),
        w: badgeW, h: 26, adj: 50000,
        paragraphs: [{ runs: [{ text: badgeText, sizePt: 10, bold: true, color: skin.colors.inverse }], align: "center" }],
        valign: "middle",
      });
    } else {
      elements.push(...skin.paint(cell));
    }
    if (side.tag && !isFeatured) {
      elements.push(
        textElement({ x: box.x, y: box.y, w: box.w, h: 22 }, [
          { runs: [skin.micro(side.tag, skin.colors.emphasis)] },
        ]),
      );
    }
    const titleY = box.y + (isFeatured ? 40 : side.tag ? 36 : 12);
    elements.push(
      textElement({ x: box.x, y: titleY, w: box.w, h: titleH }, [
        { runs: skin.heading(side.title, titleSize, skin.colors.text) },
      ]),
    );
    const ruleY = titleY + titleH + Math.round(m.tightGap * 0.8);
    const rule = skin.dividerH(box, ruleY);
    if (rule) elements.push(rule);
    const pointsTop = ruleY + Math.round(m.gap * 0.7);
    const sum = pointsH.reduce((a, b) => a + b, 0);
    const gap = Math.max(Math.round(m.tightGap * 0.9), Math.min(48, Math.round((box.y + box.h - pointsTop - sum) / Math.max(1, pointsH.length))));
    if (pointsTop + sum + gap * Math.max(0, pointsH.length - 1) > box.y + box.h + 2) {
      bad(`${what}「${side.title}」内容高约 ${Math.round(pointsTop + sum - box.y)}px 超过区域 ${Math.round(box.h)}px——精简要点或减少列`);
    }
    let y = pointsTop;
    side.points.forEach((point, j) => {
      const h = pointsH[j]!;
      if (typeof point === "string") {
        elements.push(
          textElement({ x: box.x, y, w: box.w, h }, [
            { runs: skin.body(`—　${point}`, pointSize, skin.colors.muted) },
          ]),
        );
      } else {
        const markColor = point.mark === "yes"
          ? skin.colors.emphasis
          : point.mark === "no"
            ? mixHex(skin.colors.text, skin.colors.background, 0.55)
            : skin.colors.muted;
        elements.push({
          type: "icon", icon: MARK_ICONS[point.mark ?? "mid"], color: markColor,
          x: Math.round(box.x), y: Math.round(y + 3), w: iconSize, h: iconSize,
        });
        elements.push(
          textElement({ x: box.x + iconSize + 10, y, w: box.w - iconSize - 10, h }, [
            { runs: skin.body(point.text, pointSize, skin.colors.text) },
          ]),
        );
      }
      y += h + gap;
    });
  });
  return elements;
}
