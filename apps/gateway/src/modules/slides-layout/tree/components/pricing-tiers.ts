/**
 * pricingTiers 组件（editorial）：2~4 档套餐定价卡。三档统一卡框——卡距即视觉间距，
 * featured 档（恰一个）凭 tint 垫板 + 3px 主色顶条 + 实心按钮 + 阴影 + 内容上浮强调；
 * 其余档白底发丝描边（outline 语言）。三档内容统一内缩 18px，顶条只覆盖圆角后的平直段。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface PricingTier {
  name: string;
  price: string;
  unit?: string;
  features: string[];
  cta?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const INSET = 18;

export function expandPricingTiers(
  tiers: PricingTier[],
  featured: number,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const gutter = theme.spacing.gutter * 1.5;
  const cols = splitColumns(frame, tiers.length, gutter);
  const nameSize = Math.min(17, Math.max(15, theme.sizes.body + 2));
  const priceSize = Math.min(34, Math.max(26, theme.sizes.subtitle + 12));
  const metaSize = theme.sizes.caption;
  const checkSize = 12;
  const ctaH = 34;
  const rendered = tiers.map((tier, i) => {
    const isFeatured = featured === i;
    const col = cols[i]!;
    const innerX = col.x + INSET;
    const innerW = col.w - INSET * 2;
    const nameH = estimateLines(tier.name, nameSize, innerW) * estimateLineHeight(nameSize) + 4;
    const priceH = estimateLineHeight(priceSize) + 6;
    const featureHs = tier.features.map(
      (f) => Math.max(1, estimateLines(f, metaSize, innerW - checkSize - 6)) * estimateLineHeight(metaSize) + 8,
    );
    const ctaW = Math.min(innerW, Math.max(120, Math.round((tier.cta ?? "选择").length * metaSize * 1.6 + 40)));
    const need = nameH + priceH + 8 + featureHs.reduce((a, b) => a + b, 0) + 14 + ctaH;
    if (need > col.h) {
      bad(`${what} 档「${tier.name}」内容高约 ${Math.round(need)}px 超过 ${Math.round(col.h)}px——精简特性行或减少档位`);
    }
    return { tier, isFeatured, col, innerX, innerW, nameH, priceH, featureHs, ctaW, need };
  });
  // 三档统一卡框：卡顶取 featured（上浮 12px 后）的卡顶，卡底罩住最高内容 + 12px 呼吸
  const contentH = Math.max(...rendered.map((r) => r.need));
  const baseTop = frame.y + Math.max(0, (frame.h - contentH) / 2);
  const cardY = Math.round(baseTop - 28);
  const contentBottom = Math.max(...rendered.map((r) => (r.isFeatured ? baseTop - 12 : baseTop) + 6 + r.need));
  const cardH = Math.round(contentBottom + 12 - cardY);
  const radiusAdj = Math.min(
    50000,
    Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(cols[0]!.w, cardH))) * 100000),
  );
  rendered.forEach(({ tier, isFeatured, col, innerX, innerW, nameH, priceH, featureHs, ctaW, need }, i) => {
    const top = baseTop + (isFeatured ? -12 : 0);
    if (isFeatured) {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: mixHex(theme.colors.primary, theme.colors.background, 0.93),
        stroke: { color: theme.colors.primary, widthPt: 1.25 },
        x: Math.round(col.x),
        y: cardY,
        w: Math.round(col.w),
        h: cardH,
        adj: radiusAdj,
        shadow: "medium",
      });
      // 顶条内缩：只覆盖圆角之后的平直段，不压弧线
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.primary,
        x: Math.round(col.x + INSET),
        y: cardY,
        w: Math.round(col.w - INSET * 2),
        h: 3,
      });
    } else {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.background,
        stroke: { color: theme.colors.divider, widthPt: 1 },
        x: Math.round(col.x),
        y: cardY,
        w: Math.round(col.w),
        h: cardH,
        adj: radiusAdj,
      });
    }
    let y = top + 6;
    elements.push(
      textElement({ x: innerX, y, w: innerW, h: nameH }, [
        { runs: headingRuns(tier.name, nameSize, isFeatured ? theme.colors.text : theme.colors.textMuted, theme) },
      ]),
    );
    y += nameH;
    // 价格行：大字价格 + 小字单位（同段混排）
    elements.push(
      textElement({ x: innerX, y, w: innerW, h: priceH }, [
        {
          runs: [
            { text: tier.price, sizePt: priceSize, bold: true, color: theme.colors.text },
            ...(tier.unit ? [{ text: ` ${tier.unit}`, sizePt: metaSize, color: theme.colors.textMuted }] : []),
          ],
        },
      ]),
    );
    y += priceH + 8;
    tier.features.forEach((f, j) => {
      const h = featureHs[j]!;
      elements.push({
        type: "icon",
        icon: "check",
        color: theme.colors.primary,
        x: Math.round(innerX),
        y: Math.round(y + 3),
        w: checkSize,
        h: checkSize,
      });
      elements.push(
        textElement({ x: innerX + checkSize + 6, y, w: innerW - checkSize - 6, h }, [
          { runs: bodyRuns(f, metaSize, theme.colors.textMuted, theme) },
        ]),
      );
      y += h;
    });
    y += 14;
    const ctaText = tier.cta ?? "选择";
    if (isFeatured) {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.primary,
        x: Math.round(innerX),
        y: Math.round(y),
        w: Math.round(ctaW),
        h: ctaH,
        adj: 50000,
        paragraphs: [{ runs: [{ text: ctaText, sizePt: metaSize + 1, bold: true, color: theme.colors.onDarkText }] }],
        valign: "middle",
      });
    } else {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.background,
        stroke: { color: theme.colors.divider, widthPt: 1 },
        x: Math.round(innerX),
        y: Math.round(y),
        w: Math.round(ctaW),
        h: ctaH,
        adj: 50000,
        paragraphs: [{ runs: [{ text: ctaText, sizePt: metaSize + 1, bold: true, color: theme.colors.primary }] }],
        valign: "middle",
      });
    }
  });
  return elements;
}
