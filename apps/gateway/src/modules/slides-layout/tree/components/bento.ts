/**
 * bentoGrid 组件（editorial）：信息拼贴。
 *
 * 版式：普通格两两成行（三条时整行三等分），wide 独占整行；首格 ink 反白承担最强
 * 对比。每格：索引微标签 + 图标（右上）→ 底部锚定的强调短规则 + 标题 24 + 正文 16；
 * wide 格改为横向构图（左侧索引/标题/正文，右侧大号图标），让宽条带不空。
 * 卡面（含反白格）/内边距/字号全部来自 ComponentSkin 语义色。
 */

import { padFrame, splitColumns, splitRows, type Frame } from "../../grid.js";
import { mixHex, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import {
  estimateLineHeight,
  estimateLines,
  singleLineBoxHeight,
} from "../../text-metrics.js";

export interface BentoItem {
  title: string;
  body?: string;
  icon?: string;
  /** 图槽：格子顶部圆角图片块（给了 image 时 icon 不画）。 */
  image?: string;
  /** 占满整行。 */
  wide?: boolean;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const DENSITY_PAD: Record<string, number> = { tight: 0.9, normal: 1, airy: 1.12 };

function cardPad(skin: ComponentSkin, frame: Frame): number {
  const m = skin.metrics(frame);
  const scale = DENSITY_PAD[skin.density] ?? 1;
  return Math.max(26, Math.min(36, Math.round(m.pad * scale)));
}

function cardBox(skin: ComponentSkin, frame: Frame, pad: number): Frame {
  const base = skin.contentBox(frame);
  const styled = Math.min(skin.pad, Math.floor(Math.min(frame.w, frame.h) * 0.18));
  const guard = Math.floor(Math.min(base.w, base.h) * 0.06);
  const inset = Math.min(Math.max(0, pad - styled), guard);
  return inset > 0 ? padFrame(base, inset) : base;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 行规划：wide 独占一行；连续普通格按 3/2 分组，避免落单半行。 */
function planRows(items: BentoItem[]): BentoItem[][] {
  const rows: BentoItem[][] = [];
  let normal: BentoItem[] = [];
  const flush = (count: number) => {
    while (normal.length > 0) {
      // 3 条 → 一行三等分；其余按 2 条成行；4 条 → 2+2。
      const take = normal.length === 3 ? 3 : Math.min(count, normal.length);
      rows.push(normal.slice(0, take));
      normal = normal.slice(take);
    }
  };
  for (const item of items) {
    if (item.wide) {
      flush(2);
      rows.push([item]);
    } else {
      normal.push(item);
    }
  }
  // 收尾：三条整行，四条 2+2，五条 3+2，其余两两成行。
  while (normal.length > 0) {
    const take = normal.length === 3 || normal.length === 5 ? 3 : Math.min(2, normal.length);
    rows.push(normal.slice(0, take));
    normal = normal.slice(take);
  }
  return rows;
}

export function expandBentoGrid(
  items: BentoItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const rows = planRows(items);
  const gutter = Math.max(m.tightGap, Math.round(m.gap * 0.9));
  const rowFrames = splitRows(frame, rows.length, gutter);
  const pad = cardPad(skin, frame);
  const titleSize = Math.min(24, Math.max(20, Math.round(m.title * 0.8)));
  const bodySize = Math.max(16, m.body - 2);
  const indexSize = m.label;
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const ruleH = Math.max(2, Math.round(indexSize * 0.16));
  const ruleW = Math.max(28, Math.round(m.display * 0.26));
  // 首格 ink 反白：只在卡面/浅色底面语言上启用（none 保持纯平铺，ink 整组已是反白，
  // outline/band 由 agent 显式选择时不被反白抢掉）。
  const invertFirst = skin.surface === "card" || skin.surface === "tint";
  const elements: SpecElement[] = [];
  let itemIndex = 0;

  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const wide = row.length === 1;
    const cells = row.length === 1 ? [rowFrame] : splitColumns(rowFrame, row.length, gutter);
    row.forEach((item, i) => {
      const cell = cells[i]!;
      const index = itemIndex++;
      const inverted = invertFirst && index === 0;
      if (inverted) {
        // 反白格：与 skin.paint("ink") 同口径的墨面（语义色，不写裸色号）。
        const adj = skin.imageRadiusAdj(cell.w, cell.h);
        elements.push({
          type: "shape",
          shape: "roundRect",
          fill: skin.colors.text,
          x: Math.round(cell.x),
          y: Math.round(cell.y),
          w: Math.round(cell.w),
          h: Math.round(cell.h),
          ...(adj !== undefined ? { adj } : {}),
        });
      } else {
        elements.push(...skin.paint(cell));
      }
      const inkTitle = inverted ? skin.colors.inkText : skin.colors.text;
      const inkBody = inverted ? mixHex(skin.colors.inkText, skin.colors.text, 0.32) : skin.colors.muted;
      const inkIndex = inverted ? skin.colors.emphasis : skin.colors.muted;
      const box = cardBox(skin, cell, pad);
      const innerW = box.w;
      const iconSize = Math.max(24, Math.round(m.body * 1.5));
      const topH = singleLineBoxHeight(Math.max(indexSize, iconSize));
      const titleH = estimateLines(item.title, titleSize, innerW) * estimateLineHeight(titleSize) + 8;
      const bodyH = item.body
        ? estimateLines(item.body, bodySize, innerW) * estimateLineHeight(bodySize) + 4
        : 0;
      const imgH = item.image ? Math.min(Math.round(box.h * 0.42), Math.max(56, Math.round(box.h * 0.3))) : 0;
      const need = (wide ? 0 : topH + imgH)
        + ruleH + Math.round(m.tightGap * 1.4)
        + titleH + (item.body ? bodyH + Math.round(m.tightGap * 0.4) : 0);
      if (need > box.h) {
        bad(`${what}「${item.title.slice(0, 12)}」格内容高约 ${Math.round(need)}px 超过 ${Math.round(box.h)}px——精简正文或减少条目`);
      }

      // 顶行：索引（左）+ 图标（右）
      elements.push(
        textElement({ x: box.x, y: box.y, w: Math.round(innerW * 0.55), h: topH }, [
          { runs: [skin.micro(pad2(index + 1), inkIndex)] },
        ]),
      );
      if (item.icon && !item.image && !wide) {
        elements.push({
          type: "icon",
          icon: item.icon,
          color: skin.colors.emphasis,
          x: Math.round(box.x + innerW - iconSize),
          y: Math.round(box.y + (topH - iconSize) / 2),
          w: iconSize,
          h: iconSize,
        });
      } else if (item.image) {
        const radiusAdj = skin.imageRadiusAdj(innerW, imgH);
        elements.push({
          type: "image",
          url: item.image,
          fit: skin.imageFit,
          ...(radiusAdj !== undefined ? { radiusAdj } : {}),
          x: Math.round(box.x),
          y: Math.round(box.y + topH),
          w: Math.round(innerW),
          h: imgH,
        });
      }

      // 底部块：强调短规则 + 标题 + 正文。普通格底对齐（索引/图标在上、结论压底）；
      // wide 格整体垂直居中（横向条带里居中构图，不压在带底）。
      const blockH = ruleH + Math.round(m.tightGap * 0.7) + titleH
        + (item.body ? bodyH + Math.round(m.tightGap * 0.4) : 0);
      const ruleY = wide
        ? box.y + topH + Math.max(0, Math.round((box.h - topH - blockH) / 2))
        : box.y + box.h - bodyH - titleH - (item.body ? Math.round(m.tightGap * 0.4) : 0) - Math.round(m.tightGap * 0.7) - ruleH;
      const titleY = ruleY + ruleH + Math.round(m.tightGap * 0.7);
      const bodyY = titleY + titleH + Math.round(m.tightGap * 0.4);
      elements.push(
        skin.accentRule(box, { x: box.x, y: ruleY, width: ruleW, height: ruleH }),
      );
      elements.push(
        textElement({ x: box.x, y: titleY, w: innerW, h: titleH }, [
          { runs: skin.heading(item.title, titleSize, inkTitle), ...(align === "center" ? { align } : {}) },
        ]),
      );
      if (item.body) {
        elements.push(
          textElement({ x: box.x, y: bodyY, w: innerW, h: bodyH }, [
            { runs: skin.body(item.body, bodySize, inkBody), ...(align === "center" ? { align } : {}) },
          ]),
        );
      }
      // wide 格：右侧大号图标补足横向构图（垂直居中在条带右侧）。
      if (wide && item.icon && !item.image) {
        const big = Math.max(44, Math.round(Math.min(box.h * 0.42, 72)));
        elements.push({
          type: "icon",
          icon: item.icon,
          color: skin.colors.emphasis,
          x: Math.round(box.x + innerW - big),
          y: Math.round(box.y + (box.h - big) / 2),
          w: big,
          h: big,
        });
      }
    });
  });
  return elements;
}
