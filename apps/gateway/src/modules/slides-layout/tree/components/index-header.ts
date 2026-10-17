/**
 * indexHeader 组件（editorial，fork xIndexHeader 转正）。衬线序号 + 标题一行 +
 * 可选右侧小注，发丝线贴区域下缘——同排多个栏头的线天然对齐，并列栏的秩序感来源。
 */

import { bodyRuns, headingRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface IndexHeaderInput {
  num: string;
  title: string;
  note?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** LibreOffice/PowerPoint 实测字宽普遍比估算宽 10~20%：小注宽度按 88% 收。 */
const NOTE_WIDTH_FACTOR = 0.88;

export function expandIndexHeader(
  input: IndexHeaderInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const numSize = 24;
  const titleSize = Math.min(18, Math.max(14, theme.sizes.subtitle));
  const noteSize = theme.sizes.caption;
  const numFont = numeralFont(theme);
  const numW = Math.round(estimateTextWidth(input.num, numSize)) + 10;
  const titleW = Math.round(estimateTextWidth(input.title, titleSize)) + 4;
  if (numW + titleW > frame.w) {
    bad(`${what}「${input.num} ${input.title}」栏头超宽（框 ${frame.w}px）——缩短标题`);
  }
  const noteAvail = frame.w - (numW + titleW + 28);
  if (input.note && estimateTextWidth(input.note, noteSize) > noteAvail * NOTE_WIDTH_FACTOR) {
    bad(`${what}「${input.title}」右侧小注「${input.note}」放不下（可用 ${Math.round(noteAvail)}px）——缩短小注`);
  }
  const rowH = singleLineBoxHeight(numSize);
  if (rowH + 8 > frame.h) {
    bad(`${what} 区域高 ${frame.h}px 不够一行栏头（需约 ${Math.round(rowH) + 8}px）——加大该子树权重`);
  }
  const noteY = rowY(rowH, noteSize);
  const elements: SpecElement[] = [];
  elements.push(
    textElement({ x: frame.x, y: frame.y, w: numW, h: rowH }, [
      {
        runs: [
          {
            text: input.num,
            sizePt: numSize,
            bold: true,
            color: theme.colors.primary,
            ...(numFont ? { font: numFont } : {}),
          },
        ],
      },
    ]),
  );
  elements.push(
    textElement(
      { x: frame.x + numW + 12, y: frame.y + (rowH - singleLineBoxHeight(titleSize)), w: titleW, h: singleLineBoxHeight(titleSize) },
      [{ runs: headingRuns(input.title, titleSize, theme.colors.text, theme) }],
    ),
  );
  if (input.note) {
    elements.push(
      textElement(
        { x: frame.x + numW + titleW + 28, y: frame.y + noteY, w: noteAvail, h: singleLineBoxHeight(noteSize) },
        [{ runs: bodyRuns(input.note, noteSize, theme.colors.textMuted, theme), align: "right" }],
      ),
    );
  }
  // 发丝线贴区域下缘：同排栏头只要等高，线就对齐
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: Math.round(frame.x),
    y: Math.round(frame.y + frame.h - 1),
    w: Math.round(frame.w),
    h: 1,
  });
  return elements;
}

function rowY(rowH: number, sizePt: number): number {
  return (rowH - singleLineBoxHeight(sizePt)) / 2;
}
