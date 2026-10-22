/**
 * teamGrid 组件（editorial）：2~6 人团队卡。≤4 人单行、5~6 人两行（每行 3）。
 *
 * 版式（每张卡）：标本索引 → 首字徽章（衬线首字 + 色调圆，72–150px）→ 姓名 20
 * → 职位（强调色全大写微标签）→ 简介 14。卡内按「上索引 / 中徽章 / 下署名」均分
 * 竖向余量：内容从卡顶排到卡底，不留大片空纸。
 * 头像位不再画通用 user 图标：无图者一律衬线首字徽章（avatar 变体只换色调语义）。
 */

import { padFrame, splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, singleLineBoxHeight } from "../../text-metrics.js";

export interface TeamMember {
  name: string;
  role?: string;
  bio?: string;
  /** 头像直链；缺省按 skin 头像变体画首字徽章。 */
  image?: string;
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

export function expandTeamGrid(
  members: TeamMember[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  avatar: "circle" | "initial" = "circle",
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const n = members.length;
  const cols = n <= 4 ? n : 3;
  const rows: TeamMember[][] = [];
  for (let i = 0; i < n; i += cols) rows.push(members.slice(i, i + cols));
  const gutter = Math.max(m.gap, Math.round(m.gap * 1.25));
  const rowFrames = splitRows(frame, rows.length, gutter);
  const nameSize = Math.max(20, Math.round(m.title * 0.68));
  const roleSize = m.label;
  const bioSize = Math.max(14, Math.round(m.caption + 2));
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";
  const pad = cardPad(skin, frame);
  const elements: SpecElement[] = [];
  const memberIndex = new Map<TeamMember, number>();
  members.forEach((member, i) => memberIndex.set(member, i));

  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = splitColumns(rowFrame, row.length, gutter);
    row.forEach((member, i) => {
      const cell = cells[i]!;
      const index = memberIndex.get(member) ?? r * cols + i;
      elements.push(...skin.paint(cell));
      const box = cardBox(skin, cell, pad);
      const cx = box.x + box.w / 2;

      const indexH = singleLineBoxHeight(roleSize);
      const avatarSize = Math.min(
        150,
        Math.max(72, Math.min(Math.round(box.w * 0.78), Math.round(box.h * 0.3))),
      );
      const nameH = estimateLines(member.name, nameSize, box.w) * estimateLineHeight(nameSize) + 12;
      const roleH = member.role ? singleLineBoxHeight(roleSize) : 0;
      const bioH = member.bio
        ? estimateLines(member.bio, bioSize, box.w) * estimateLineHeight(bioSize) + 2
        : 0;
      let total = indexH + avatarSize + nameH + roleH + bioH;
      // 小格保护：先丢索引，再缩徽章，保证内容不溢出。
      let showIndex = true;
      if (total > box.h) {
        showIndex = false;
        total -= indexH;
      }
      let avatarFit = avatarSize;
      while (total > box.h && avatarFit > 56) {
        avatarFit -= 4;
        total -= 4;
      }
      if (total > box.h) {
        bad(`${what}「${member.name}」内容高约 ${Math.round(total)}px 超过 ${Math.round(box.h)}px——精简简介或减少人数`);
      }

      // 竖向均分：索引 / 徽章 / 署名 / 简介四段，上下留同档呼吸，从卡顶铺到卡底。
      const contentH = (showIndex ? indexH : 0) + avatarFit + nameH + roleH + bioH;
      const gaps = member.bio ? 5 : 4;
      const space = Math.max(0, (box.h - contentH) / gaps);
      let y = box.y + space;
      if (showIndex) {
        const runs = skin.numeralRun(pad2(index + 1), Math.max(16, Math.round(roleSize * 1.4)), skin.colors.muted, false)
          ?? skin.body(pad2(index + 1), roleSize, skin.colors.muted);
        elements.push(
          textElement({ x: box.x, y: Math.round(y), w: box.w, h: indexH }, [{ runs, align }]),
        );
        y += indexH + space;
      }

      const avatarX = align === "center" ? Math.round(cx - avatarFit / 2) : Math.round(box.x);
      const avatarY = Math.round(y);
      if (member.image) {
        elements.push({
          type: "image",
          url: member.image,
          fit: skin.imageFit,
          circle: true,
          x: avatarX,
          y: avatarY,
          w: avatarFit,
          h: avatarFit,
        });
      } else {
        // avatar:circle（缺省）= 主色实心圆 + 纸色衬线首字（最强头像占位）；
        // avatar:initial = 浅强调圆 + 强调色衬线首字（编辑感标本徽章）。
        const solid = avatar === "circle";
        elements.push({
          type: "shape",
          shape: "ellipse",
          fill: solid ? skin.colors.primary : skin.colors.emphasisSoft,
          x: avatarX,
          y: avatarY,
          w: avatarFit,
          h: avatarFit,
        });
        const initialSize = Math.max(18, Math.round(avatarFit * 0.42));
        elements.push(
          textElement(
            { x: avatarX, y: Math.round(avatarY + (avatarFit - singleLineBoxHeight(initialSize)) / 2), w: avatarFit, h: singleLineBoxHeight(initialSize) },
            [{
              runs: skin.heading(
                skin.initials(member.name),
                initialSize,
                solid ? skin.colors.background : skin.colors.emphasis,
              ),
              align: "center",
            }],
          ),
        );
      }
      y += avatarFit + space;

      elements.push(
        textElement({ x: box.x, y: Math.round(y), w: box.w, h: nameH }, [
          { runs: skin.heading(member.name, nameSize, skin.colors.text), align },
        ]),
      );
      y += nameH;
      if (member.role) {
        elements.push(
          textElement({ x: box.x, y: Math.round(y), w: box.w, h: roleH }, [
            { runs: [{ ...skin.micro(member.role, skin.colors.emphasis), sizePt: roleSize }], align },
          ]),
        );
        y += roleH;
      }
      if (member.bio) {
        // 署名与简介之间一条发丝线：把「身份」与「说明」分层（结构件，不是装饰）。
        const ruleY = y + Math.round(space / 2);
        const line = skin.dividerH(box, ruleY);
        if (line) elements.push(line);
        y += space;
        elements.push(
          textElement({ x: box.x, y: Math.round(y), w: box.w, h: bioH }, [
            { runs: skin.body(member.bio, bioSize, skin.colors.muted), align },
          ]),
        );
      }
    });
  });
  return elements;
}
