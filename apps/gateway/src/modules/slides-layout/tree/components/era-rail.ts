/**
 * eraRail 组件（editorial，fork xEraRail 转正）。脊线压区域顶，刻度下挂衬线年代
 * 与静音短注；年代限 8 字、短注限 12 字且各限一行，混排折行与基线错乱在归一层拦下。
 * highlight 条目刻度与年代换主色。
 */

import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface EraRailItem {
  era: string;
  note: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 年代字号：16~20pt 自适应。 */
function eraSizeFor(theme: ResolvedTheme): number {
  return Math.min(20, Math.max(16, Math.round(theme.sizes.subtitle)));
}

/** 年代一行：宽了先降档（至 14pt），仍超宽报错——折行会打乱整排基线。 */
function fitEraSize(era: string, cellW: number, theme: ResolvedTheme): number {
  for (let size = eraSizeFor(theme); size >= 14; size -= 2) {
    if (estimateTextWidth(era, size) <= cellW - 20) return size;
  }
  bad(`「${era}」年代超宽（每格可用 ${cellW}px）——统一短年代格式（如「2026」「唐代」「1610 年」）`);
}

export function expandEraRail(
  items: EraRailItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  highlight?: number,
): SpecElement[] {
  const noteSize = theme.sizes.caption;
  const eraFont = numeralFont(theme);
  const railY = frame.y;
  const cellW = frame.w / items.length;
  const noteW = cellW - 16;
  const noteHs = items.map((item) => textBoxHeight(item.note, noteSize, noteW));
  const eraSizes = items.map((item) => fitEraSize(item.era, cellW, theme));
  const eraH = singleLineBoxHeight(Math.max(...eraSizes));
  const need = 12 + eraH + 5 + Math.max(...noteHs);
  if (need > frame.h + 2) {
    bad(`${what} 内容高约 ${Math.round(need)}px 超过区域 ${frame.h}px——精简短注或加大该子树权重`);
  }
  const elements: SpecElement[] = [];
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: Math.round(frame.x),
    y: Math.round(railY),
    w: Math.round(frame.w),
    h: 1,
  });
  items.forEach((item, i) => {
    const cx = frame.x + cellW * i;
    const eraSize = eraSizes[i]!;
    const eraH = singleLineBoxHeight(eraSize);
    const hot = highlight === i;
    elements.push({
      type: "shape",
      shape: "rect",
      fill: hot ? theme.colors.primary : theme.colors.divider,
      x: Math.round(cx),
      y: Math.round(railY),
      w: hot ? 4 : 3,
      h: hot ? 18 : 14,
    });
    elements.push(
      textElement({ x: cx + 12, y: railY + 12, w: cellW - 16, h: eraH }, [
        {
          runs: [
            {
              text: item.era,
              sizePt: eraSize,
              bold: true,
              color: hot ? theme.colors.primary : theme.colors.text,
              ...(eraFont ? { font: eraFont } : {}),
            },
          ],
        },
      ]),
    );
    elements.push(
      textElement({ x: cx + 12, y: railY + 12 + eraH + 5, w: noteW, h: noteHs[i]! }, [
        { runs: bodyRuns(item.note, noteSize, theme.colors.textMuted, theme) },
      ]),
    );
  });
  return elements;
}
