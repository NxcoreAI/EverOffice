/**
 * featureCards：卡片行。图标徽章/图槽 + 标题 + 正文；卡面由风格卡决定。
 * 每张卡的内容按卡高分配（徽章顶、标题中、正文随行），避免「大卡小字」。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface FeatureItem {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandFeatureCards(
  items: FeatureItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const m = skin.metrics(frame);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const cells = splitColumns(frame, items.length, m.gap);
  const titleSize = Math.round(m.title * 0.9);
  const bodySize = m.body;
  const iconSize = Math.round(Math.min(Math.max(36, m.pad * 1.3), 52));
  const elements: SpecElement[] = [];
  const built = items.map((item, i) => {
    const cell = cells[i]!;
    elements.push(...skin.paint(cell));
    const box = skin.contentBox(cell);
    const innerW = box.w;
    const imageH = item.image ? Math.round(box.h * 0.44) : 0;
    const titleH = estimateLines(item.title, titleSize, innerW) * estimateLineHeight(titleSize, 108) + 4;
    const bodyH = item.body ? estimateLines(item.body, bodySize, innerW) * estimateLineHeight(bodySize, 124) + 4 : 0;
    const topBlock = imageH > 0 ? imageH + Math.round(m.tightGap * 1.1) : iconSize + Math.round(m.tightGap * 1.2);
    const need = topBlock + titleH + (bodyH ? Math.round(m.tightGap * 0.8) + bodyH : 0);
    if (need > box.h) {
      bad(`${what}「${item.title.slice(0, 12)}」内容高约 ${Math.round(need)}px 超过 ${Math.round(box.h)}px——精简正文或加大权重`);
    }
    return { item, box, innerW, imageH, titleH, bodyH, topBlock, need };
  });
  built.forEach(({ item, box, innerW, imageH, titleH, bodyH, topBlock }, i) => {
    let y = box.y;
    if (item.image && imageH > 0) {
      const radiusAdj = skin.imageRadiusAdj(innerW, imageH);
      elements.push({
        type: "image", url: item.image, fit: skin.imageFit,
        ...(radiusAdj !== undefined ? { radiusAdj } : {}),
        x: Math.round(box.x), y: Math.round(y), w: Math.round(innerW), h: imageH,
      });
    } else if (item.icon) {
      elements.push({
        type: "icon", icon: item.icon, color: skin.colors.emphasis,
        x: Math.round(box.x), y: Math.round(box.y), w: iconSize, h: iconSize,
      });
    }
    // 标题落在卡面视觉中段（有图则在图下），让大卡不空。
    const titleY = item.image && imageH > 0
      ? box.y + topBlock
      : box.y + Math.max(topBlock + Math.round(m.tightGap * 0.8), Math.round(box.h * 0.42));
    if (!(item.image && imageH > 0)) {
      elements.push(skin.accentRule(box, { x: box.x, y: titleY - Math.round(m.tightGap * 0.9), width: 32, height: 3 }));
    }
    elements.push(
      textElement({ x: box.x, y: titleY, w: innerW, h: titleH }, [
        { runs: skin.heading(item.title, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
      ]),
    );
    if (item.body) {
      elements.push(
        textElement({ x: box.x, y: titleY + titleH + Math.round(m.tightGap * 0.8), w: innerW, h: bodyH }, [
          { runs: skin.body(item.body, bodySize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
        ]),
      );
    }
    // 卡片序号压底：让卡内文本簇覆盖整卡高度，避免引擎把图标/文字整体下移造成错位。
    elements.push(
      textElement({ x: box.x, y: box.y + box.h - 20, w: innerW, h: 20 }, [
        { runs: [skin.micro(String(i + 1).padStart(2, "0"), skin.colors.divider)] },
      ]),
    );
  });
  return elements;
}
