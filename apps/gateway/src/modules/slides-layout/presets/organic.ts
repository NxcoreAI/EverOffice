/**
 * R 系预设：中心辐射 R1、环形循环 R2、错落杂志卡 R3、斜切分区 R4。
 * 骨架坐标来自 organic-pages.md（按 M=60 示例给出，左右锚定项随 M 平移）。
 * 连线先画、节点后画：连线穿过节点的部分被节点盖住，视觉上走空隙。
 */

import { CANVAS_W, splitByRatio, splitColumns } from "../grid.js";
import {
  bodyRuns,
  headingRuns,
  imageElement,
  textElement,
  type PageSpec,
  type SpecElement,
} from "../elements.js";
import { estimateLines, estimateLineHeight, textBoxHeight } from "../text-metrics.js";
import { enumValue, list, objects, str } from "../parse.js";
import { pageTitle, type PresetContext } from "../preset-common.js";
import { httpUrl } from "../elements.js";

type Input = Record<string, unknown>;
type Box = { x: number; y: number; w: number; h: number };

function mixHexLocal(a: string, b: string, mix: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return `#${[r1 + (r2 - r1) * mix, g1 + (g2 - g1) * mix, b1 + (b2 - b1) * mix]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function nodeElements(name: string, desc: string | undefined, box: Box, ctx: PresetContext, highlight: boolean): SpecElement[] {
  const fill = highlight ? ctx.theme.colors.primary : ctx.theme.colors.cardSurface;
  const nameColor = highlight ? ctx.theme.colors.onDarkText : ctx.theme.colors.text;
  const descColor = highlight ? mixHexLocal(ctx.theme.colors.onDarkText, ctx.theme.colors.primary, 0.25) : ctx.theme.colors.textMuted;
  const nameSize = 16;
  const descSize = 13;
  const elements: SpecElement[] = [{
    type: "shape",
    shape: "roundRect",
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.w),
    h: Math.round(box.h),
    fill,
  }];
  const nameH = estimateLineHeight(nameSize) + 4;
  const descH = desc ? estimateLines(desc, descSize, box.w - 16) * estimateLineHeight(descSize) + 4 : 0;
  const total = nameH + (desc ? 4 + descH : 0);
  if (total > box.h - 12) throw new Error(`PRESET_INVALID: 节点「${name.slice(0, 8)}」文字放不下——说明删掉只留节点名`);
  const top = box.y + (box.h - total) / 2;
  elements.push(textElement(
    { x: box.x + 12, y: top, w: box.w - 24, h: nameH },
    [{ runs: headingRuns(name, nameSize, nameColor, ctx.theme), align: "center" }],
  ));
  if (desc) {
    elements.push(textElement(
      { x: box.x + 12, y: top + nameH + 4, w: box.w - 24, h: descH },
      [{ runs: bodyRuns(desc, descSize, descColor, ctx.theme), align: "center" }],
    ));
  }
  return elements;
}

function line(from: Box, to: Box, ctx: PresetContext, arrow = false): SpecElement {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h / 2;
  const x2 = to.x + to.w / 2;
  const y2 = to.y + to.h / 2;
  return {
    type: "shape",
    shape: arrow ? "lineArrow" : "line",
    x: Math.round(Math.min(x1, x2)),
    y: Math.round(Math.min(y1, y2)),
    w: Math.round(Math.abs(x2 - x1)),
    h: Math.round(Math.abs(y2 - y1)),
    stroke: { color: mixHexLocal(ctx.theme.colors.primary, ctx.theme.colors.background, 0.45), widthPt: 1.5 },
  };
}

function expandR1(input: Input, ctx: PresetContext): PageSpec {
  const center = str(input, "center", { required: true, max: 6 });
  const satellites = objects(list(input, "satellites", { required: true, min: 4, max: 6 }), "R1 satellites").map((s, i) => ({
    name: str(s, "name", { required: true, max: 7 }),
    desc: str(s, "desc", { max: 9 }),
    highlight: s.highlight === true && i === 0,
  }));
  if (satellites.some((s, i) => s.highlight !== (i === 0 && satellites[0]!.highlight)) ) {
    throw new Error("PRESET_INVALID: R1 至多一个卫星 highlight，请只给第一个");
  }
  const M = ctx.M;
  // 右侧卫星的镜像锚点：上排贴 M+70 内缩线，侧排贴右边距线（与 organic-pages.md 的 M=60 示例一致）。
  const rightTop = (w: number) => CANVAS_W - M - 70 - w;
  const rightSide = (w: number) => CANVAS_W - M - w;
  const boxes: Box[] = satellites.length === 6
    ? [
        { x: M + 70, y: 160, w: 200, h: 110 },
        { x: rightTop(200), y: 160, w: 200, h: 110 },
        { x: M, y: 350, w: 170, h: 110 },
        { x: rightSide(170), y: 350, w: 170, h: 110 },
        { x: M + 70, y: 570, w: 200, h: 110 },
        { x: rightTop(200), y: 570, w: 200, h: 110 },
      ]
    : [
        { x: 640 - 95, y: 140, w: 190, h: 80 },
        { x: M + 20, y: 360, w: 180, h: 110 },
        { x: rightSide(180) - 20, y: 360, w: 180, h: 110 },
        { x: 640 - 95, y: 596, w: 190, h: 84 },
      ];
  if (satellites.length !== 6 && satellites.length !== 4) throw new Error("PRESET_INVALID: R1 卫星数须为 6 或 4（不排 5 个——奇数环绕失衡）");
  const centerBox: Box = { x: 540, y: 310, w: 200, h: 200 };
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { max: 40 }), ctx)];
  for (const box of boxes) elements.push(line(box, centerBox, ctx));
  elements.push({
    type: "shape",
    shape: "ellipse",
    x: centerBox.x,
    y: centerBox.y,
    w: centerBox.w,
    h: centerBox.h,
    fill: ctx.theme.colors.primary,
    paragraphs: [{ runs: [{ text: center, sizePt: 22, bold: true, color: ctx.theme.colors.onDarkText, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }], align: "center" }],
    valign: "middle",
  });
  satellites.forEach((satellite, i) => {
    elements.push(...nodeElements(satellite.name, satellite.desc, boxes[i]!, ctx, satellite.highlight));
  });
  return { background: ctx.theme.colors.background, elements };
}

function expandR2(input: Input, ctx: PresetContext): PageSpec {
  const nodes = objects(list(input, "nodes", { required: true, min: 4, max: 5 }), "R2 nodes").map((n) => ({
    name: str(n, "name", { required: true, max: 7 }),
    desc: str(n, "desc", { max: 9 }),
  }));
  if (nodes.length !== 5 && nodes.length !== 4) throw new Error("PRESET_INVALID: R2 节点数须为 5 或 4");
  const ghostWord = str(input, "ghostWord", { max: 6 });
  const kpiValue = str(input, "kpiValue", { max: 8 });
  const kpiLabel = str(input, "kpiLabel", { max: 12 });
  const boxes: Box[] = nodes.length === 5
    ? [
        { x: 555, y: 155, w: 170, h: 80 },
        { x: 935, y: 250, w: 190, h: 84 },
        { x: 890, y: 596, w: 190, h: 84 },
        { x: 200, y: 596, w: 190, h: 84 },
        { x: 155, y: 250, w: 190, h: 84 },
      ]
    : [
        { x: 560, y: 160, w: 160, h: 76 },
        { x: 950, y: 363, w: 180, h: 84 },
        { x: 560, y: 596, w: 160, h: 84 },
        { x: 140, y: 363, w: 180, h: 84 },
      ];
  const ring: Box = { x: 490, y: 265, w: 300, h: 280 };
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { max: 40 }), ctx)];
  elements.push({
    type: "shape",
    shape: "donut",
    x: ring.x,
    y: ring.y,
    w: ring.w,
    h: ring.h,
    fill: mixHexLocal(ctx.theme.colors.primary, ctx.theme.colors.background, 0.85),
  });
  for (let i = 0; i < boxes.length; i++) {
    elements.push(line(boxes[i]!, boxes[(i + 1) % boxes.length]!, ctx, true));
  }
  if (ghostWord) {
    elements.push(textElement(
      { x: ring.x + 20, y: ring.y + 100, w: ring.w - 40, h: 110 },
      [{ runs: [{ text: ghostWord, sizePt: 96, bold: true, color: mixHexLocal(ctx.theme.colors.primary, ctx.theme.colors.background, 0.8) }], align: "center" }],
      "middle",
    ));
  } else if (kpiValue) {
    elements.push(textElement(
      { x: ring.x + 20, y: ring.y + 90, w: ring.w - 40, h: 90 },
      [{ runs: [{ text: kpiValue, sizePt: 64, bold: true, color: ctx.theme.colors.primary, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }], align: "center" }],
      "middle",
    ));
    if (kpiLabel) {
      elements.push(textElement(
        { x: ring.x + 20, y: ring.y + 185, w: ring.w - 40, h: 40 },
        [{ runs: bodyRuns(kpiLabel, 13, ctx.theme.colors.textMuted, ctx.theme), align: "center" }],
      ));
    }
  }
  nodes.forEach((node, i) => elements.push(...nodeElements(node.name, node.desc, boxes[i]!, ctx, false)));
  return { background: ctx.theme.colors.background, elements };
}

function expandR3(input: Input, ctx: PresetContext): PageSpec {
  const skeleton = enumValue(input, "skeleton", ["A", "B"] as const, "A");
  const focusPct = input.focusPct === undefined ? 48 : Math.round(Number(input.focusPct));
  if (!Number.isFinite(focusPct) || focusPct < 48 || focusPct > 62) throw new Error("PRESET_INVALID: focusPct 只允许 48~62");
  const focusInput = objects([input.focus], "R3 focus")[0]!;
  const image = focusInput.image !== undefined ? objects([focusInput.image], "R3 focus.image")[0]! : null;
  const focusUrl = image ? httpUrl(str(image, "url", { required: true, max: 500 }), "R3 focus.image.url") : null;
  const focusValue = str(focusInput, "value", { max: 10 });
  const focusLabel = str(focusInput, "label", { max: 16 });
  const focusTitle = str(focusInput, "title", { max: 20 });
  const focusBody = str(focusInput, "body", { max: 90 });
  if (!focusUrl && !focusValue && !focusTitle) throw new Error("PRESET_INVALID: R3 focus 需要三选一：image / value+label / title+body");

  const cards = objects(list(input, "cards", { required: true, min: skeleton === "A" ? 3 : 2, max: skeleton === "A" ? 3 : 2 }), "R3 cards").map((c) => ({
    title: str(c, "title", { max: 20 }),
    body: str(c, "body", { max: 60 }),
    image: c.image !== undefined ? httpUrl(str(objects([c.image], "R3 card.image")[0]!, "url", { required: true, max: 500 }), "R3 卡片图") : null,
  }));

  const focusW = Math.round((ctx.frame.w * focusPct) / 100 / 4) * 4;
  const rightX = ctx.M + focusW + ctx.G;
  const rightW = CANVAS_W - ctx.M - rightX;
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { max: 40 }), ctx)];
  const focusFrame: Box = { x: ctx.M, y: ctx.frame.y, w: focusW, h: ctx.frame.h };
  if (focusUrl) {
    elements.push(imageElement(focusFrame, focusUrl, ctx.theme, "cover"));
  } else {
    elements.push({ type: "shape", shape: "roundRect", x: focusFrame.x, y: focusFrame.y, w: focusFrame.w, h: focusFrame.h, fill: ctx.theme.colors.primary });
    const textColor = ctx.theme.colors.onDarkText;
    if (focusValue) {
      const valueSize = Math.min(96, Math.max(64, ctx.theme.sizes.kpi + 16));
      const valueH = estimateLineHeight(valueSize) + 8;
      const labelH = focusLabel ? estimateLineHeight(18) + 4 : 0;
      const total = valueH + (focusLabel ? 16 + labelH : 0);
      const top = focusFrame.y + (focusFrame.h - total) / 2;
      elements.push(textElement(
        { x: focusFrame.x + 24, y: top, w: focusFrame.w - 48, h: valueH },
        [{ runs: headingRuns(focusValue, valueSize, textColor, ctx.theme), align: "center" }],
      ));
      if (focusLabel) {
        elements.push(textElement(
          { x: focusFrame.x + 24, y: top + valueH + 16, w: focusFrame.w - 48, h: labelH },
          [{ runs: bodyRuns(focusLabel, 18, mixHexLocal(textColor, ctx.theme.colors.primary, 0.3), ctx.theme), align: "center" }],
        ));
      }
    } else {
      const titleSize = 24;
      const bodySize = 15;
      const titleH = estimateLines(focusTitle, titleSize, focusFrame.w - 48) * estimateLineHeight(titleSize);
      const bodyH = focusBody ? estimateLines(focusBody, bodySize, focusFrame.w - 48) * estimateLineHeight(bodySize) : 0;
      const total = titleH + (focusBody ? 16 + bodyH : 0);
      const top = focusFrame.y + (focusFrame.h - total) / 2;
      elements.push(textElement({ x: focusFrame.x + 24, y: top, w: focusFrame.w - 48, h: titleH + 4 }, [{ runs: headingRuns(focusTitle, titleSize, textColor, ctx.theme) }]));
      if (focusBody) {
        elements.push(textElement(
          { x: focusFrame.x + 24, y: top + titleH + 16, w: focusFrame.w - 48, h: bodyH + 4 },
          [{ runs: bodyRuns(focusBody, bodySize, mixHexLocal(textColor, ctx.theme.colors.primary, 0.25), ctx.theme), lineSpacingPct: 130 }],
        ));
      }
    }
  }
  const rightFrame = { x: rightX, y: ctx.frame.y, w: rightW, h: ctx.frame.h };
  if (skeleton === "A") {
    const topH = Math.round(ctx.frame.h * 0.48);
    const [topFrame, bottomFrame] = [
      { x: rightX, y: ctx.frame.y, w: rightW, h: topH },
      { x: rightX, y: ctx.frame.y + topH + ctx.G, w: rightW, h: ctx.frame.h - topH - ctx.G },
    ];
    const [b1, b2] = splitColumns(bottomFrame, 2, ctx.G);
    for (const [card, frame] of [[cards[0], topFrame], [cards[1], b1!], [cards[2], b2!]] as const) {
      if (card) elements.push(...r3Card(card, frame, ctx));
    }
  } else {
    const topH = Math.round(ctx.frame.h * 0.6);
    const [topFrame, bottomFrame] = [
      { x: rightX, y: ctx.frame.y, w: rightW, h: topH },
      { x: rightX, y: ctx.frame.y + topH + ctx.G, w: rightW, h: ctx.frame.h - topH - ctx.G },
    ];
    if (cards[0]) elements.push(...r3Card(cards[0], topFrame, ctx));
    if (cards[1]) elements.push(...r3Card(cards[1], bottomFrame, ctx));
  }
  return { background: ctx.theme.colors.background, elements };
}

function r3Card(card: { title?: string; body?: string; image: string | null }, frame: Box, ctx: PresetContext): SpecElement[] {
  if (card.image) return [imageElement(frame, card.image, ctx.theme, "cover")];
  if (!card.title) throw new Error("PRESET_INVALID: R3 卡片需要 title 或 image");
  const padding = ctx.theme.spacing.cardPadding;
  const innerW = frame.w - padding * 2;
  const titleSize = 16;
  const bodySize = 13;
  const titleH = estimateLines(card.title, titleSize, innerW) * estimateLineHeight(titleSize);
  const bodyH = card.body ? estimateLines(card.body, bodySize, innerW) * estimateLineHeight(bodySize) : 0;
  const total = titleH + (card.body ? 8 + bodyH : 0);
  if (total > frame.h - padding * 2) throw new Error(`PRESET_INVALID: R3 卡片「${card.title.slice(0, 10)}」内容超高`);
  return [
    { type: "shape", shape: "roundRect", x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h), fill: ctx.theme.colors.cardSurface },
    textElement({ x: frame.x + padding, y: frame.y + (frame.h - total) / 2, w: innerW, h: titleH + 4 }, [{ runs: headingRuns(card.title, titleSize, ctx.theme.colors.text, ctx.theme) }]),
    ...(card.body
      ? [textElement({ x: frame.x + padding, y: frame.y + (frame.h - total) / 2 + titleH + 8, w: innerW, h: bodyH + 4 }, [{ runs: bodyRuns(card.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }])]
      : []),
  ];
}

function expandR4(input: Input, ctx: PresetContext): PageSpec {
  const claim = str(input, "claim", { required: true, max: 24 });
  const variant = enumValue(input, "variant", ["topLeft", "bottomRight"] as const, "topLeft");
  const mode = enumValue(input, "mode", ["compare", "points"] as const, "compare");
  const elements: SpecElement[] = [];
  const dark = ctx.theme.colors.darkBackground;
  if (variant === "topLeft") {
    elements.push({ type: "path", x: 0, y: 0, w: CANVAS_W, h: 340, d: "M0,0 L0,340 L1280,340 Z", fill: dark });
    const claimW = 560;
    if (estimateLines(claim, 32, claimW) > 2) throw new Error("PRESET_INVALID: R4 主张句过长（最多两行）");
    const claimH = textBoxHeight(claim, 32, claimW);
    elements.push(textElement(
      { x: 80, y: 210 - claimH / 2, w: claimW, h: claimH },
      [{ runs: headingRuns(claim, 32, ctx.theme.colors.onDarkText, ctx.theme) }],
    ));
    const bodyFrame = { x: ctx.M, y: 380, w: ctx.frame.w, h: 300 };
    elements.push(...r4Body(mode, input, bodyFrame, ctx));
  } else {
    elements.push({ type: "path", x: 0, y: 380, w: CANVAS_W, h: 340, d: "M1280,720 L1280,380 L0,720 Z", fill: dark });
    const claimW = 560;
    if (estimateLines(claim, 32, claimW) > 2) throw new Error("PRESET_INVALID: R4 主张句过长（最多两行）");
    const claimH = textBoxHeight(claim, 32, claimW);
    elements.push(textElement(
      { x: 640, y: 560, w: claimW, h: claimH },
      [{ runs: headingRuns(claim, 32, ctx.theme.colors.onDarkText, ctx.theme) }],
    ));
    const bodyFrame = { x: ctx.M, y: 140, w: ctx.frame.w, h: 200 };
    elements.push(...r4Body(mode, input, bodyFrame, ctx));
  }
  return { background: ctx.theme.colors.background, elements };
}

function r4Body(mode: "compare" | "points", input: Input, frame: Box, ctx: PresetContext): SpecElement[] {
  if (mode === "compare") {
    const left = objects([input.left ?? {}], "R4 left")[0]!;
    const right = objects([input.right ?? {}], "R4 right")[0]!;
    const ratio = enumValue(input, "ratio", ["50/50", "62/38"] as const, "50/50");
    const parseSide = (side: Record<string, unknown>, what: string) => ({
      name: str(side, "name", { required: true, max: 10 }),
      points: list(side, "points", { required: true, min: 2, max: 4 }).map((v) => String(v).slice(0, 22)),
    });
    const leftSide = parseSide(left, "R4 left");
    const rightSide = parseSide(right, "R4 right");
    const winner = enumValue(input, "winner", ["left", "right", "none"] as const, "none");
    const [leftFrame, rightFrame] = splitByRatio({ ...frame, x: frame.x, y: frame.y, w: frame.w, h: frame.h }, ratio, ctx.G, true);
    const elements: SpecElement[] = [];
    for (const [side, sideFrame, isWinner] of [
      [leftSide, leftFrame, winner === "left"],
      [rightSide, rightFrame, winner === "right"],
    ] as const) {
      elements.push({
        type: "shape",
        shape: "roundRect",
        x: Math.round(sideFrame.x),
        y: Math.round(sideFrame.y),
        w: Math.round(sideFrame.w),
        h: Math.round(sideFrame.h),
        fill: isWinner ? ctx.theme.colors.primarySoft : ctx.theme.colors.cardSurface,
        ...(isWinner ? { stroke: { color: ctx.theme.colors.primary, widthPt: 1.5 } } : {}),
      });
      const nameSize = 18;
      const pointSize = 13;
      const pointH = estimateLineHeight(pointSize) * 1.5;
      const blockH = estimateLineHeight(nameSize) + 16 + side.points.length * pointH;
      const top = sideFrame.y + (sideFrame.h - blockH) / 2;
      elements.push(textElement(
        { x: sideFrame.x + 20, y: top, w: sideFrame.w - 40, h: estimateLineHeight(nameSize) + 4 },
        [{ runs: headingRuns(side.name, nameSize, ctx.theme.colors.text, ctx.theme) }],
      ));
      side.points.forEach((point, j) => {
        elements.push(textElement(
          { x: sideFrame.x + 20, y: top + estimateLineHeight(nameSize) + 16 + j * pointH, w: sideFrame.w - 40, h: pointH },
          [{ runs: bodyRuns(point, pointSize, ctx.theme.colors.textMuted, ctx.theme) }],
          "middle",
        ));
      });
    }
    return elements;
  }
  const points = objects(list(input, "points", { required: true, min: 2, max: 3 }), "R4 points").map((p) => ({
    title: str(p, "title", { required: true, max: 16 }),
    body: str(p, "body", { max: 50 }),
  }));
  const cells = splitColumns({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }, points.length, ctx.G);
  return points.flatMap((p, i) => {
    const cell = cells[i]!;
    const padding = ctx.theme.spacing.cardPadding;
    const innerW = cell.w - padding * 2;
    const titleSize = 16;
    const bodySize = 13;
    const titleH = estimateLines(p.title, titleSize, innerW) * estimateLineHeight(titleSize);
    const bodyH = p.body ? estimateLines(p.body, bodySize, innerW) * estimateLineHeight(bodySize) : 0;
    const total = titleH + (p.body ? 8 + bodyH : 0);
    if (total > cell.h - padding * 2) throw new Error("PRESET_INVALID: R4 要点卡内容超高");
    return [
      { type: "shape", shape: "roundRect", x: Math.round(cell.x), y: Math.round(cell.y), w: Math.round(cell.w), h: Math.round(cell.h), fill: ctx.theme.colors.cardSurface },
      textElement({ x: cell.x + padding, y: cell.y + (cell.h - total) / 2, w: innerW, h: titleH + 4 }, [{ runs: headingRuns(p.title, titleSize, ctx.theme.colors.text, ctx.theme) }]),
      ...(p.body ? [textElement({ x: cell.x + padding, y: cell.y + (cell.h - total) / 2 + titleH + 8, w: innerW, h: bodyH + 4 }, [{ runs: bodyRuns(p.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }])] : []),
    ];
  });
}

export const ORGANIC_PRESETS = {
  "R1": expandR1,
  "R2": expandR2,
  "R3": expandR3,
  "R4": expandR4,
} as const;
