/**
 * quotes 组件（editorial）：客户评价卡。
 *
 * 版式（每张卡）：标本索引 + 星级（强调色）→ 幽灵引号（强调色浅档）→ 引文
 * （19–20pt，正文色）→ 强调短规则 → 底部署名（首字徽章/头像 + 姓名 20 + 角色微标签）。
 * 内容顶底锚定、引文在中段垂直居中：卡面被填满，不留「大卡小字 + 底部空纸」。
 * 卡面/内边距/字距/颜色全部来自 ComponentSkin，不写裸像素/裸色号。
 */

import { padFrame, splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface QuoteEntry {
  text: string;
  name: string;
  role?: string;
  avatar?: string;
  /** 星级 1~5；缺省不画星。 */
  rating?: number;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const DENSITY_PAD: Record<string, number> = { tight: 0.9, normal: 1, airy: 1.12 };

/** 卡内边距：以 metrics.pad 为基准、按 density 缩放，并守住设计系统「卡内 ≥26px」下限。 */
function cardPad(skin: ComponentSkin, frame: Frame): number {
  const m = skin.metrics(frame);
  const scale = DENSITY_PAD[skin.density] ?? 1;
  return Math.max(26, Math.min(36, Math.round(m.pad * scale)));
}

/** 卡面内容框：先走 skin.contentBox（尊重 surface/pad 语义），再补足到设计系统卡内边距。 */
function cardBox(skin: ComponentSkin, frame: Frame, pad: number): Frame {
  const base = skin.contentBox(frame);
  const styled = Math.min(skin.pad, Math.floor(Math.min(frame.w, frame.h) * 0.18));
  const guard = Math.floor(Math.min(base.w, base.h) * 0.06);
  const inset = Math.min(Math.max(0, pad - styled), guard);
  return inset > 0 ? padFrame(base, inset) : base;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function expandQuotes(
  items: QuoteEntry[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const elements: SpecElement[] = [];
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const pad = cardPad(skin, frame);
  const cols = splitColumns(frame, items.length, Math.max(m.gap, Math.round(m.gap * 1.25)));
  const quoteSize = Math.min(28, Math.max(22, Math.round(m.title * 0.9)));
  const nameSize = Math.max(20, Math.round(m.title * 0.68));
  const roleSize = m.label;
  const starSize = Math.max(16, Math.round(m.body * 0.9));
  const avatarSize = Math.min(72, Math.max(56, Math.round(m.pad * 2.5)));
  const initialSize = Math.round(avatarSize * 0.42);
  const ruleH = Math.max(2, Math.round(m.label * 0.16));
  const ruleW = Math.max(32, Math.round(m.display * 0.3));

  items.forEach((item, i) => {
    const col = cols[i]!;
    elements.push(...skin.paint(col));
    const box = cardBox(skin, col, pad);
    const innerW = box.w;

    // 顶行：标本索引（左）+ 星级（右）——同一行，卡片顶部有结构件。
    const topH = singleLineBoxHeight(Math.max(roleSize, starSize));
    elements.push(
      textElement({ x: box.x, y: box.y, w: Math.round(innerW * 0.5), h: topH }, [
        { runs: [skin.micro(`${pad2(i + 1)} / ${pad2(items.length)}`, skin.colors.muted)] },
      ]),
    );
    if (item.rating && item.rating > 0) {
      const starGap = Math.max(4, Math.round(starSize * 0.3));
      const starsW = item.rating * starSize + (item.rating - 1) * starGap;
      const starsX = align === "center" ? box.x + Math.round((innerW - starsW) / 2) : box.x + innerW - starsW;
      for (let s = 0; s < item.rating; s++) {
        elements.push({
          type: "icon",
          icon: "star",
          color: skin.colors.emphasis,
          x: Math.round(starsX + s * (starSize + starGap)),
          y: Math.round(box.y + (topH - starSize) / 2),
          w: starSize,
          h: starSize,
        });
      }
    }

    // 底部署名块：首字徽章/圆头像 + 姓名 + 角色；底对齐，卡底不再空。
    const nameH = singleLineBoxHeight(nameSize);
    const roleH = item.role ? singleLineBoxHeight(roleSize) : 0;
    const stackH = nameH + roleH;
    const footerH = Math.max(avatarSize, stackH);
    const footerY = box.y + box.h - footerH;
    const ruleY = footerY - Math.round(m.tightGap * 0.9) - ruleH;
    const ruleX = align === "center" ? box.x + Math.round((innerW - ruleW) / 2) : box.x;
    elements.push(skin.accentRule(box, { x: ruleX, y: ruleY, width: ruleW, height: ruleH }));

    // 引文在中段垂直居中：顶行与署名规则之间的留白对称，卡面不空、底部由署名收口。
    const contentTop = box.y + topH + Math.round(m.tightGap * 0.35);
    const contentBottom = ruleY - Math.round(m.tightGap * 0.7);
    const areaH = contentBottom - contentTop;
    let qSize = quoteSize;
    let quoteBoxH = textBoxHeight(item.text, qSize, innerW);
    while (quoteBoxH > areaH && qSize > 15) {
      qSize -= 1;
      quoteBoxH = textBoxHeight(item.text, qSize, innerW);
    }
    if (areaH <= 0 || quoteBoxH > areaH) {
      bad(`${what} 第 ${i + 1} 条「${item.text.slice(0, 12)}…」引文放不下（可用 ${Math.round(areaH)}px）——精简引文或减少条目`);
    }
    elements.push(
      textElement(
        { x: box.x, y: Math.round(contentTop + (areaH - quoteBoxH) / 2), w: innerW, h: quoteBoxH },
        [{
          runs: skin.body(item.text, qSize, skin.colors.text),
          ...(align === "center" ? { align } : {}),
          lineSpacingPct: 124,
        }],
      ),
    );

    // 署名：徽章/头像 + 姓名（20 标题字体）+ 角色（强调色全大写微标签）。
    const nameW = estimateTextWidth(item.name, nameSize);
    const roleW = item.role ? estimateTextWidth(item.role, roleSize) + item.role.length * 1.6 : 0;
    const avatarGap = Math.max(12, Math.round(avatarSize * 0.18));
    const groupW = Math.min(innerW, avatarSize + avatarGap + Math.max(nameW, roleW));
    const groupX = box.x + (align === "center" ? Math.max(0, (innerW - groupW) / 2) : 0);
    const avatarX = Math.round(groupX);
    const avatarY = Math.round(footerY + (footerH - avatarSize) / 2);
    if (item.avatar) {
      elements.push({
        type: "image",
        url: item.avatar,
        fit: skin.imageFit,
        circle: true,
        x: avatarX,
        y: avatarY,
        w: avatarSize,
        h: avatarSize,
      });
    } else {
      elements.push({
        type: "shape",
        shape: "ellipse",
        fill: skin.colors.emphasisSoft,
        x: avatarX,
        y: avatarY,
        w: avatarSize,
        h: avatarSize,
      });
      elements.push(
        textElement(
          { x: avatarX, y: Math.round(avatarY + (avatarSize - singleLineBoxHeight(initialSize)) / 2), w: avatarSize, h: singleLineBoxHeight(initialSize) },
          [{ runs: skin.heading(skin.initials(item.name), initialSize, skin.colors.emphasis), align: "center" }],
        ),
      );
    }
    const textX = Math.round(avatarX + avatarSize + avatarGap);
    const textW = Math.max(24, box.x + innerW - textX);
    const nameY = Math.round(footerY + (footerH - stackH) / 2);
    elements.push(
      textElement({ x: textX, y: nameY, w: textW, h: nameH }, [
        { runs: skin.heading(item.name, nameSize, skin.colors.text) },
      ]),
    );
    if (item.role) {
      elements.push(
        textElement({ x: textX, y: nameY + nameH, w: textW, h: roleH }, [
          { runs: [{ ...skin.micro(item.role, skin.colors.emphasis), sizePt: roleSize }] },
        ]),
      );
    }
  });
  return elements;
}
