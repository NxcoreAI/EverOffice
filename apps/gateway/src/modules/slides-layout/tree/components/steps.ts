/**
 * steps 组件：幽灵衬线大序号 + 标题 + 正文，步骤之间用强调色进度轨道连接。
 * 无底面语义：默认直接落在页面上（不铺底、不画卡），只有 agent 显式写
 * style.surface 时才铺底——避免「白卡里飘着一条小字」。
 *
 * 版面：序号是整列的视觉锚点（display×0.9 的低透明衬线数字），标题与正文
 * 贴底对齐、各列共用一条基线；连接轨道压在顶部刻标高度上，形成「进度条」。
 * 所有字号/间距来自 skin.metrics，颜色只取 ComponentSkin。
 */

import { splitColumns, type Frame } from "../../grid.js";
import { isDarkColor, mixHex, withAlpha, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, textBoxHeight } from "../../text-metrics.js";

export interface StepItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 与引擎墨迹闸门同口径的内容高（行高按 min 18pt 估）。 */
function inkHeight(sizePt: number, lines = 1): number {
  return Math.round(estimateLineHeight(Math.max(18, sizePt)) * lines);
}

export function expandSteps(
  items: StepItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  connector: "line" | "gap" | "none" = "line",
): SpecElement[] {
  void theme;
  const cells = splitColumns(frame, items.length, skin.looseGap);
  const boxes = cells.map((cell) => (skin.surfaceExplicit ? skin.contentBox(cell) : cell));
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...cells.flatMap((cell) => skin.paint(cell)), ...skin.motifDecor(frame, "corner")]
    : [];

  const m = skin.metrics(boxes[0]!);
  const titleSize = m.title;
  const bodySize = m.body;
  const ruleH = 4;
  const ruleW = Math.max(36, Math.round(m.serial * 0.9));
  const bottomPad = Math.max(10, Math.round(m.pad * 0.6));
  const titleGap = Math.max(14, Math.round(m.tightGap * 1.1));
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";

  const built = items.map((item, index) => {
    const box = boxes[index]!;
    const titleLines = estimateLines(item.title, titleSize, box.w);
    const bodyLines = item.text ? estimateLines(item.text, bodySize, box.w) : 0;
    return {
      item,
      box,
      titleH: textBoxHeight(item.title, titleSize, box.w),
      bodyH: item.text ? textBoxHeight(item.text, bodySize, box.w) : 0,
      titleInk: inkHeight(titleSize, titleLines),
      bodyInk: inkHeight(bodySize, bodyLines),
    };
  });
  const maxTitleInk = Math.max(...built.map((entry) => entry.titleInk));
  const maxBodyInk = Math.max(...built.map((entry) => entry.bodyInk));

  // 标题/正文贴底：所有列共用一条正文基线，标题压在其上，形成整齐的「脚注带」。
  const bodyTop = (box: Frame) => box.y + box.h - bottomPad - maxBodyInk;
  const titleTop = (box: Frame) => bodyTop(box) - titleGap - maxTitleInk;
  const microGap = Math.max(10, Math.round(m.tightGap * 0.6));
  const microTop = (box: Frame) => box.y + ruleH + microGap;
  const ghostTop = (box: Frame) => microTop(box) + inkHeight(m.label) + Math.max(12, Math.round(m.tightGap * 0.7));
  const ghostBottom = (box: Frame) => titleTop(box) - Math.max(12, Math.round(m.tightGap));

  // 幽灵序号字号：display×0.9 起，剩余空间不足时逐档收缩。
  let ghostSize = Math.round(m.display * 1.1);
  const availAt = (box: Frame) => ghostBottom(box) - ghostTop(box);
  const narrowest = Math.min(...boxes.map(availAt));
  if (narrowest < 48) {
    bad(`${what} 步骤文字过高，序号区只剩 ${Math.round(narrowest)}px——精简标题/说明或减少步骤`);
  }
  while (ghostSize > 44 && inkHeight(ghostSize) > narrowest) ghostSize -= 4;
  const ghostInk = inkHeight(ghostSize);

  built.forEach((entry, index) => {
    const { item, box, titleH, bodyH } = entry;
    // 顶部刻标：强调色短规则 + 中文大写微标签，把序号列钉在版面上。
    elements.push(skin.accentRule(box, { x: box.x, y: box.y, width: ruleW, height: ruleH }));
    elements.push(
      textElement({ x: box.x, y: Math.round(microTop(box)), w: box.w, h: inkHeight(m.label) }, [
        { runs: [skin.micro(`STEP ${String(index + 1).padStart(2, "0")}`, skin.colors.muted)], align },
      ]),
    );
    const ghostColor = withAlpha(
      mixHex(skin.colors.primary, skin.colors.text, isDarkColor(skin.colors.background) ? 0.5 : 0.12),
      0.14,
    );
    const ghost = skin.numeralRun(String(index + 1).padStart(2, "0"), ghostSize, ghostColor);
    if (ghost) {
      const ghostY = Math.round(ghostTop(box) + Math.max(0, (availAt(box) - ghostInk) * 0.4));
      elements.push(textElement({ x: box.x, y: ghostY, w: box.w, h: ghostInk }, [{ runs: ghost }]));
    }
    const titleY = Math.round(titleTop(box));
    elements.push(
      textElement({ x: box.x, y: titleY, w: box.w, h: titleH }, [
        { runs: skin.heading(item.title, titleSize, skin.colors.text), align },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: box.x, y: Math.round(bodyTop(box)), w: box.w, h: bodyH }, [
          { runs: skin.body(item.text, bodySize, skin.colors.muted), align },
        ]),
      );
    }
    // 步骤轨道：2px 强调色横线连接相邻刻标，落点小圆点压在下一个刻标起点。
    if (index > 0 && connector === "line") {
      const trackY = Math.round(box.y + ruleH / 2 - 1);
      elements.push({
        type: "shape", shape: "rect", fill: skin.colors.emphasis,
        x: Math.round(box.x - skin.looseGap), y: trackY, w: Math.round(skin.looseGap), h: 2,
      });
      const dot = 8;
      elements.push({
        type: "shape", shape: "ellipse", fill: skin.colors.emphasis,
        x: Math.round(box.x - dot / 2), y: Math.round(box.y + ruleH / 2 - dot / 2), w: dot, h: dot,
      });
    }
  });
  return elements;
}
