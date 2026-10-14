/**
 * P 系预设：封面 P1a/P1b/P1c、大图压字 P2、深色章节 P3、目录 P4、
 * 大引用 P5、半图半卡 P6、双栏图文 P7、履历 P8、封底 P9。
 * 骨架来自 layout-ppt-skill/layouts/text-media-pages.md，坐标全部由代码算。
 */

import { CANVAS_H, CANVAS_W, splitRows, splitByRatio, parseRatio } from "../grid.js";
import {
  bodyRuns,
  headingRuns,
  httpUrl,
  imageElement,
  textElement,
  type ImageElement,
  type PageSpec,
  type SpecElement,
} from "../elements.js";
import { estimateLines, estimateTextWidth, singleLineBoxHeight, textBoxHeight, estimateLineHeight } from "../text-metrics.js";
import { enumValue, list, objects, str, asObject } from "../parse.js";
import { banner as _banner, cardColumn, makeContext, parseCard, pageTitle, type PresetContext } from "../preset-common.js";

type Input = Record<string, unknown>;

/** 深色封面/章节页的弱化白。 */
function mutedOnDark(ctx: PresetContext): string {
  return mixHexLocal(ctx.theme.colors.onDarkText, ctx.theme.colors.darkBackground, 0.38);
}

function mixHexLocal(a: string, b: string, mix: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return `#${[r1 + (r2 - r1) * mix, g1 + (g2 - g1) * mix, b1 + (b2 - b1) * mix]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 左对齐文字组整体垂直居中（封面/章节共用）。 */
function centeredStack(paragraphGroups: { text: string; size: number; color: string; gapBefore: number; bold?: boolean }[], x: number, w: number, theme: PresetContext["theme"]): SpecElement[] {
  const heights = paragraphGroups.map((g) => ({
    ...g,
    h: textBoxHeight(g.text, g.size, w),
    lines: estimateLines(g.text, g.size, w),
  }));
  const total = heights.reduce((sum, g) => sum + g.h + g.gapBefore, 0);
  let y = (CANVAS_H - total) / 2;
  return heights.map((g) => {
    y += g.gapBefore;
    const element = textElement(
      { x, y, w, h: g.h },
      [{ runs: g.bold === false ? bodyRuns(g.text, g.size, g.color, theme) : headingRuns(g.text, g.size, g.color, theme) }],
    );
    y += g.h;
    return element;
  });
}

function expandP1a(input: Input, ctx: PresetContext): PageSpec {
  const eyebrow = str(input, "eyebrow", { max: 60 });
  const title = str(input, "title", { required: true, max: 40 });
  const subtitle = str(input, "subtitle", { max: 80 });
  const ghost = str(input, "ghostText", { max: 12 });
  const dark = ctx.theme.colors.darkBackground;
  const onDark = ctx.theme.colors.onDarkText;
  // 背景大字在右下 (CANVAS_W-M-560 起)，文字组收窄到 44% 画布宽避免与它相交。
  const textW = ghost ? Math.round(CANVAS_W * 0.44) : CANVAS_W - ctx.M * 2 - 40;
  const elements: SpecElement[] = [];
  if (ghost) {
    elements.push(textElement(
      { x: CANVAS_W - ctx.M - 560, y: CANVAS_H - 300, w: 560, h: 280 },
      [{ runs: [{ text: ghost, sizePt: 150, bold: true, color: `${mixHexLocal(onDark, dark, 0.85)}` }] }],
    ));
  }
  const group: Parameters<typeof centeredStack>[0] = [];
  if (eyebrow) group.push({ text: eyebrow, size: ctx.theme.sizes.caption, color: mutedOnDark(ctx), gapBefore: 0, bold: false });
  group.push({ text: title, size: ctx.theme.sizes.coverTitle, color: onDark, gapBefore: eyebrow ? 32 : 0 });
  if (subtitle) group.push({ text: subtitle, size: ctx.theme.sizes.subtitle, color: mutedOnDark(ctx), gapBefore: 32, bold: false });
  elements.push(...centeredStack(group, ctx.M + 8, textW, ctx.theme));
  return { background: dark, elements };
}

function expandP1b(input: Input, ctx: PresetContext): PageSpec {
  const eyebrow = str(input, "eyebrow", { max: 60 });
  const title = str(input, "title", { required: true, max: 24 });
  const subtitle = str(input, "subtitle", { max: 60 });
  const band = enumValue(input, "band", ["right", "bottom"] as const, "right");
  const elements: SpecElement[] = [];
  const primary = ctx.theme.colors.primary;
  const onDark = ctx.theme.colors.onDarkText;
  const titleSize = Math.min(64, Math.max(48, ctx.theme.sizes.coverTitle - 8));
  if (band === "right") {
    elements.push({ type: "shape", shape: "rect", x: CANVAS_W / 2, y: 0, w: CANVAS_W / 2, h: CANVAS_H, fill: primary });
    if (eyebrow) {
      elements.push(textElement(
        { x: ctx.M, y: 88, w: CANVAS_W / 2 - ctx.M - 40, h: singleLineBoxHeight(ctx.theme.sizes.caption) },
        [{ runs: bodyRuns(eyebrow, ctx.theme.sizes.caption, ctx.theme.colors.textMuted, ctx.theme) }],
      ));
    }
    const group = [
      { text: title, size: titleSize, color: onDark, gapBefore: 0 },
      ...(subtitle ? [{ text: subtitle, size: ctx.theme.sizes.subtitle, color: mixHexLocal(onDark, primary, 0.3), gapBefore: 28, bold: false }] : []),
    ];
    elements.push(...centeredStack(group, CANVAS_W / 2 + 48, CANVAS_W / 2 - 96, ctx.theme));
  } else {
    elements.push({ type: "shape", shape: "rect", x: 0, y: 400, w: CANVAS_W, h: 320, fill: primary });
    if (eyebrow) {
      elements.push(textElement(
        { x: ctx.M, y: 88, w: CANVAS_W - ctx.M * 2, h: singleLineBoxHeight(ctx.theme.sizes.caption) },
        [{ runs: bodyRuns(eyebrow, ctx.theme.sizes.caption, ctx.theme.colors.textMuted, ctx.theme) }],
      ));
    }
    const group = [
      { text: title, size: titleSize, color: onDark, gapBefore: 0 },
      ...(subtitle ? [{ text: subtitle, size: ctx.theme.sizes.subtitle, color: mixHexLocal(onDark, primary, 0.3), gapBefore: 24, bold: false }] : []),
    ];
    const heights = group.map((g) => ({ ...g, h: textBoxHeight(g.text, g.size, CANVAS_W - 200) }));
    const total = heights.reduce((sum, g) => sum + g.h + g.gapBefore, 0);
    let y = 400 + (320 - total) / 2;
    for (const g of heights) {
      y += g.gapBefore;
      elements.push(textElement(
        { x: 100, y, w: CANVAS_W - 200, h: g.h },
        [{ runs: g.bold === false ? bodyRuns(g.text, g.size, g.color, ctx.theme) : headingRuns(g.text, g.size, g.color, ctx.theme) }],
      ));
      y += g.h;
    }
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandP1c(input: Input, ctx: PresetContext): PageSpec {
  const eyebrow = str(input, "eyebrow", { max: 60 });
  const title = str(input, "title", { required: true, max: 16 });
  const subtitle = str(input, "subtitle", { max: 80 });
  const size = Math.min(110, Math.max(80, ctx.theme.sizes.coverTitle + 24));
  const w = CANVAS_W - ctx.M * 2;
  if (estimateLines(title, size, w) > 2) {
    throw new Error(`PRESET_INVALID: P1c 主标题过长——${size}pt 最多两行（约 ${Math.floor((w * 2) / (size * 1.35))} 个中文字）`);
  }
  const elements: SpecElement[] = [];
  const group: Parameters<typeof centeredStack>[0] = [];
  if (eyebrow) group.push({ text: eyebrow, size: ctx.theme.sizes.caption, color: ctx.theme.colors.textMuted, gapBefore: 0, bold: false });
  group.push({ text: title, size, color: ctx.theme.colors.text, gapBefore: eyebrow ? 40 : 0 });
  if (subtitle) group.push({ text: subtitle, size: ctx.theme.sizes.subtitle, color: ctx.theme.colors.textMuted, gapBefore: 40, bold: false });
  elements.push(...centeredStack(group, ctx.M, w, ctx.theme));
  return { background: ctx.theme.colors.background, elements };
}

function expandP2(input: Input, ctx: PresetContext): PageSpec {
  const image = asObject(input.image, "P2 image");
  const url = httpUrl(str(image, "url", { required: true, max: 500 }), "P2 image.url");
  const claim = str(input, "claim", { required: true, max: 40 });
  const sub = str(input, "sub", { max: 80 });
  const claimSize = Math.min(48, Math.max(36, Math.round(ctx.theme.sizes.sectionTitle * 0.9)));
  const w = CANVAS_W - ctx.M * 2;
  if (estimateLines(claim, claimSize, w) > 2) throw new Error("PRESET_INVALID: P2 主张句过长（最多两行）");
  const overlay = `${ctx.theme.colors.darkBackground}59`;
  const elements: SpecElement[] = [
    { type: "shape", shape: "rect", x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, fill: overlay },
  ];
  const group: Parameters<typeof centeredStack>[0] = [
    { text: claim, size: claimSize, color: ctx.theme.colors.onDarkText, gapBefore: 0 },
    ...(sub ? [{ text: sub, size: Math.min(20, ctx.theme.sizes.subtitle), color: mixHexLocal(ctx.theme.colors.onDarkText, overlay, 0.25), gapBefore: 24, bold: false }] : []),
  ];
  const heights = group.map((g) => ({ ...g, h: textBoxHeight(g.text, g.size, w) }));
  const total = heights.reduce((sum, g) => sum + g.h + g.gapBefore, 0);
  let y = CANVAS_H / 2 - total / 2 - 20;
  for (const g of heights) {
    y += g.gapBefore;
    elements.push(textElement(
      { x: ctx.M, y, w, h: g.h },
      [{ runs: g.bold === false ? bodyRuns(g.text, g.size, g.color, ctx.theme) : headingRuns(g.text, g.size, g.color, ctx.theme), align: "center" }],
    ));
    y += g.h;
  }
  return {
    background: ctx.theme.colors.background,
    elements: [
      imageElement({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, url, ctx.theme, "cover"),
      ...elements.map((el) => (el.type === "text" ? { ...el, shadow: "soft" as const } : el)),
    ],
  };
}

function expandP3(input: Input, ctx: PresetContext): PageSpec {
  const sectionNo = str(input, "sectionNo", { max: 4 });
  const title = str(input, "title", { required: true, max: 20 });
  const subtitle = str(input, "subtitle", { max: 60 });
  const dark = ctx.theme.colors.darkBackground;
  const onDark = ctx.theme.colors.onDarkText;
  const size = ctx.theme.sizes.sectionTitle;
  const elements: SpecElement[] = [];
  if (sectionNo) {
    elements.push(textElement(
      { x: CANVAS_W - ctx.M - 420, y: 40, w: 420, h: 220 },
      [{ runs: [{ text: sectionNo, sizePt: 120, bold: true, color: mixHexLocal(onDark, dark, 0.82) }], align: "right" }],
    ));
  }
  const w = CANVAS_W - ctx.M * 2 - (sectionNo ? 200 : 0);
  const group: Parameters<typeof centeredStack>[0] = [
    { text: title, size, color: onDark, gapBefore: 0 },
    ...(subtitle ? [{ text: subtitle, size: Math.min(18, ctx.theme.sizes.subtitle), color: mutedOnDark(ctx), gapBefore: 24, bold: false }] : []),
  ];
  elements.push(...centeredStack(group, ctx.M + 8, w, ctx.theme));
  return { background: dark, elements };
}

function expandP4(input: Input, ctx: PresetContext): PageSpec {
  const heading = str(input, "heading", { max: 12 }) || "目录";
  const tagline = str(input, "tagline", { max: 40 });
  const items = list(input, "items", { required: true, min: 4, max: 6 }).map((v, i) => str({ v: typeof v === "string" ? v : "" }, "v", { max: 40 }) || String(v).slice(0, 40));
  const leftW = 320;
  const elements: SpecElement[] = [];
  const headingSize = Math.min(36, Math.max(28, ctx.theme.sizes.sectionTitle - 8));
  const leftGroup: Parameters<typeof centeredStack>[0] = [
    { text: heading, size: headingSize, color: ctx.theme.colors.text, gapBefore: 0 },
    ...(tagline ? [{ text: tagline, size: ctx.theme.sizes.caption, color: ctx.theme.colors.textMuted, gapBefore: 16, bold: false }] : []),
  ];
  elements.push(...centeredStack(leftGroup, ctx.M, leftW, ctx.theme));
  const rightX = ctx.M + leftW + 60;
  const rightW = CANVAS_W - ctx.M - rightX;
  const rowH = ctx.frame.h / items.length;
  const numSize = Math.min(22, Math.max(18, ctx.theme.sizes.body + 6));
  const titleSize = Math.min(18, Math.max(16, ctx.theme.sizes.body + 3));
  items.forEach((item, i) => {
    const y = ctx.frame.y + i * rowH;
    elements.push(textElement(
      { x: rightX, y, w: 56, h: rowH },
      [{ runs: headingRuns(String(i + 1).padStart(2, "0"), numSize, ctx.theme.colors.primary, ctx.theme) }],
      "middle",
    ));
    elements.push(textElement(
      { x: rightX + 68, y, w: rightW - 68, h: rowH },
      [{ runs: bodyRuns(item, titleSize, ctx.theme.colors.text, ctx.theme) }],
      "middle",
    ));
    if (i < items.length - 1 && ctx.theme.decoration.divider === "line") {
      elements.push({ type: "shape", shape: "rect", x: rightX, y: Math.round(y + rowH), w: rightW, h: 1, fill: ctx.theme.colors.divider });
    }
  });
  return { background: ctx.theme.colors.background, elements };
}

function expandP5(input: Input, ctx: PresetContext): PageSpec {
  const quote = str(input, "quote", { required: true, max: 120 });
  const author = str(input, "author", { max: 30 });
  const role = str(input, "role", { max: 30 });
  const size = Math.min(32, Math.max(24, Math.round(ctx.theme.sizes.sectionTitle * 0.66)));
  const w = Math.round(ctx.frame.w * 0.8);
  if (estimateLines(quote, size, w) > 3) throw new Error("PRESET_INVALID: P5 引言过长（最多三行）——精简引言");
  const quoteH = textBoxHeight(quote, size, w);
  const elements: SpecElement[] = [
    textElement(
      { x: ctx.M, y: 150, w: 64, h: 64 },
      [{ runs: [{ text: "“", sizePt: 48, bold: true, color: ctx.theme.colors.primary, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }] }],
    ),
  ];
  const groupTop = 200;
  elements.push(textElement(
    { x: ctx.M + 72, y: groupTop, w, h: quoteH },
    [{ runs: headingRuns(quote, size, ctx.theme.colors.text, ctx.theme) }],
  ));
  if (author || role) {
    const runs = [
      ...(author ? bodyRuns(author, ctx.theme.sizes.body, ctx.theme.colors.text, ctx.theme, true) : []),
      ...(role ? bodyRuns(role ? `　${role}` : "", ctx.theme.sizes.body, ctx.theme.colors.textMuted, ctx.theme) : []),
    ].filter((r) => r.text);
    elements.push(textElement(
      { x: ctx.M + 72, y: groupTop + quoteH + 40, w, h: singleLineBoxHeight(ctx.theme.sizes.body) },
      [{ runs, align: "right" }],
    ));
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandP6(input: Input, ctx: PresetContext): PageSpec {
  const image = asObject(input.image, "P6 image");
  const url = httpUrl(str(image, "url", { required: true, max: 500 }), "P6 image.url");
  const fit = enumValue(image, "fit", ["cover", "contain"] as const, ctx.theme.decoration.imageFit);
  const ratio = enumValue(input, "ratio", ["62/38", "50/50", "38/62"] as const, "62/38");
  const imageSide = enumValue(input, "imageSide", ["left", "right"] as const, "left");
  const cards = list(input, "cards", { required: true, min: 3, max: 3 }).map(parseCard);
  const [imageFrame, cardFrame] = splitByRatio(ctx.frame, ratio, ctx.G, imageSide === "left");
  return {
    background: ctx.theme.colors.background,
    elements: [
      ...pageTitle(str(input, "title", { max: 40 }), ctx),
      imageElement(imageFrame, url, ctx.theme, fit),
      ...cardColumn(cards, cardFrame, ctx, "P6 卡片"),
    ],
  };
}

function expandP7(input: Input, ctx: PresetContext): PageSpec {
  const image = asObject(input.image, "P7 image");
  const url = httpUrl(str(image, "url", { required: true, max: 500 }), "P7 image.url");
  const fit = enumValue(image, "fit", ["cover", "contain"] as const, ctx.theme.decoration.imageFit);
  const ratio = enumValue(input, "ratio", ["50/50", "62/38", "38/62"] as const, "50/50");
  const imageSide = enumValue(input, "imageSide", ["left", "right"] as const, "left");
  const heading = str(input, "heading", { required: true, max: 30 });
  const body = str(input, "body", { max: 300 });
  const bullets = list(input, "bullets", { max: 4 }).map((v) => String(v).slice(0, 40));
  const [imageFrame, textFrame] = splitByRatio(ctx.frame, ratio, ctx.G, imageSide === "left");
  const headingSize = Math.min(22, Math.max(18, ctx.theme.sizes.subtitle - 2));
  const bodySize = Math.min(15, Math.max(13, ctx.theme.sizes.body));
  const innerW = textFrame.w - 16;
  const blocks: { h: number; el: SpecElement }[] = [];
  const headingLines = estimateLines(heading, headingSize, innerW);
  if (headingLines > 2) throw new Error("PRESET_INVALID: P7 小标题过长（最多两行）");
  blocks.push({
    h: headingLines * estimateLineHeight(headingSize) + 4,
    el: textElement({ x: textFrame.x + 8, y: 0, w: innerW, h: headingLines * estimateLineHeight(headingSize) + 4 }, [{ runs: headingRuns(heading, headingSize, ctx.theme.colors.text, ctx.theme) }]),
  });
  if (body) {
    const bodyH = textBoxHeight(body, bodySize, innerW);
    blocks.push({ h: bodyH, el: textElement({ x: textFrame.x + 8, y: 0, w: innerW, h: bodyH }, [{ runs: bodyRuns(body, bodySize, ctx.theme.colors.textMuted, ctx.theme), lineSpacingPct: 130 }]) });
  }
  for (const bullet of bullets) {
    const h = textBoxHeight(bullet, bodySize, innerW - 16);
    blocks.push({ h, el: textElement({ x: textFrame.x + 8, y: 0, w: innerW, h }, [{ runs: bodyRuns(bullet, bodySize, ctx.theme.colors.text, ctx.theme), bullet: true, lineSpacingPct: 130 }]) });
  }
  const gaps = (headingLines > 0 ? 16 : 0) + (body ? 16 : 0) + Math.max(0, bullets.length - 1) * 8 + (bullets.length ? 16 : 0);
  const total = blocks.reduce((sum, b) => sum + b.h, 0) + gaps;
  if (total > textFrame.h) throw new Error(`PRESET_INVALID: P7 文字栏内容超高（约 ${Math.round(total)}px > ${Math.round(textFrame.h)}px）——精简正文或要点`);
  let y = textFrame.y + (textFrame.h - total) / 2;
  const elements: SpecElement[] = blocks.map((b) => {
    b.el.y = Math.round(y);
    y += b.h + 16;
    return b.el;
  });
  return {
    background: ctx.theme.colors.background,
    elements: [...pageTitle(str(input, "title", { max: 40 }), ctx), imageElement(imageFrame, url, ctx.theme, fit), ...elements],
  };
}

function expandP8(input: Input, ctx: PresetContext): PageSpec {
  const entries = objects(list(input, "entries", { required: true, min: 3, max: 4 }), "P8 entries");
  const highlight = asObject(input.highlight, "P8 highlight");
  const highlightTitle = str(highlight, "title", { required: true, max: 40 });
  const highlightBody = str(highlight, "body", { max: 200 });
  const leftW = 280;
  const rightX = ctx.M + leftW + 40;
  const rightW = CANVAS_W - ctx.M - rightX;
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { max: 40 }), ctx)];
  const entrySize = Math.min(16, Math.max(14, ctx.theme.sizes.body + 2));
  const bodySize = Math.min(14, Math.max(12, ctx.theme.sizes.body));
  const parsed = entries.map((entry) => ({
    period: str(entry, "period", { max: 16 }),
    title: str(entry, "title", { required: true, max: 20 }),
    body: str(entry, "body", { max: 120 }),
  }));
  const combinedTitle = (e: (typeof parsed)[number]) => (e.period ? `${e.period}　${e.title}` : e.title);
  const entryH = parsed.map((e) => {
    const titleLines = estimateLines(combinedTitle(e), entrySize, leftW - 40);
    const bodyLines = e.body ? estimateLines(e.body, bodySize, leftW - 40) : 0;
    return titleLines * estimateLineHeight(entrySize) + (e.body ? 6 : 0) + bodyLines * estimateLineHeight(bodySize) + 12;
  });
  const gap = ctx.frame.h >= parsed.length * 160 ? 40 : 24;
  const total = entryH.reduce((a, b) => a + b, 0) + gap * (parsed.length - 1);
  let y = ctx.frame.y + Math.max(20, (ctx.frame.h - total) / 2);
  elements.push({ type: "shape", shape: "rect", x: ctx.M + 5, y: Math.round(y), w: 1, h: Math.round(total + 24), fill: ctx.theme.colors.divider });
  parsed.forEach((entry, i) => {
    elements.push({ type: "shape", shape: "ellipse", x: ctx.M, y: Math.round(y + 4), w: 12, h: 12, fill: ctx.theme.colors.primary });
    const titleH = estimateLines(combinedTitle(entry), entrySize, leftW - 40) * estimateLineHeight(entrySize);
    elements.push(textElement(
      { x: ctx.M + 24, y, w: leftW - 40, h: titleH + 4 },
      [{ runs: headingRuns(entry.period ? `${entry.period}　${entry.title}` : entry.title, entrySize, ctx.theme.colors.text, ctx.theme) }],
    ));
    if (entry.body) {
      elements.push(textElement(
        { x: ctx.M + 24, y: y + titleH + 6, w: leftW - 40, h: textBoxHeight(entry.body, bodySize, leftW - 40) },
        [{ runs: bodyRuns(entry.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }],
      ));
    }
    y += entryH[i]! + gap;
  });
  const hlSize = Math.min(26, Math.max(20, ctx.theme.sizes.sectionTitle - 20));
  const hlW = rightW;
  if (estimateLines(highlightTitle, hlSize, hlW) > 3) throw new Error("PRESET_INVALID: P8 右侧大引言过长（最多三行）");
  const hlH = textBoxHeight(highlightTitle, hlSize, hlW);
  const hlBodyH = highlightBody ? textBoxHeight(highlightBody, ctx.theme.sizes.body, hlW) : 0;
  const groupTop = ctx.frame.y + (ctx.frame.h - hlH - (highlightBody ? 24 + hlBodyH : 0)) / 2;
  elements.push(textElement({ x: rightX, y: groupTop, w: hlW, h: hlH }, [{ runs: headingRuns(highlightTitle, hlSize, ctx.theme.colors.text, ctx.theme) }]));
  if (highlightBody) {
    elements.push(textElement(
      { x: rightX, y: groupTop + hlH + 24, w: hlW, h: hlBodyH },
      [{ runs: bodyRuns(highlightBody, ctx.theme.sizes.body, ctx.theme.colors.textMuted, ctx.theme), lineSpacingPct: 130 }],
    ));
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandP9(input: Input, ctx: PresetContext): PageSpec {
  const logoText = str(input, "logoText", { max: 20 }) || "EverRoom";
  const slogan = str(input, "slogan", { required: true, max: 40 });
  const contacts = objects(list(input, "contacts", { max: 4 }), "P9 contacts").map((c) => ({
    icon: str(c, "icon", { max: 40 }),
    text: str(c, "text", { required: true, max: 40 }),
  }));
  const rawImage = input.image;
  const elements: SpecElement[] = [];
  const leftX = 60;
  const leftW = 440;
  elements.push(textElement(
    { x: leftX, y: 140, w: leftW, h: singleLineBoxHeight(24) },
    [{ runs: headingRuns(logoText, 24, ctx.theme.colors.primary, ctx.theme) }],
  ));
  elements.push(textElement(
    { x: leftX, y: 200, w: leftW, h: textBoxHeight(slogan, ctx.theme.sizes.subtitle, leftW) },
    [{ runs: headingRuns(slogan, ctx.theme.sizes.subtitle, ctx.theme.colors.text, ctx.theme) }],
  ));
  let y = 320;
  for (const contact of contacts) {
    if (contact.icon) {
      elements.push({ type: "icon", icon: contact.icon, color: ctx.theme.colors.primary, x: leftX, y: Math.round(y + 2), w: 20, h: 20 });
    }
    elements.push(textElement(
      { x: leftX + (contact.icon ? 32 : 0), y, w: leftW - 32, h: 36 },
      [{ runs: bodyRuns(contact.text, ctx.theme.sizes.body, ctx.theme.colors.textMuted, ctx.theme) }],
      "middle",
    ));
    y += 44;
  }
  if (typeof rawImage === "object" && rawImage !== null) {
    const image = asObject(rawImage, "P9 image");
    const url = httpUrl(str(image, "url", { required: true, max: 500 }), "P9 image.url");
    elements.push(imageElement({ x: 600, y: 0, w: 680, h: CANVAS_H }, url, ctx.theme, "cover"));
  } else {
    elements.push({ type: "shape", shape: "rect", x: 600, y: 0, w: 680, h: CANVAS_H, fill: ctx.theme.colors.primary });
  }
  return { background: ctx.theme.colors.background, elements };
}

export const TEXT_MEDIA_PRESETS = {
  "P1a": expandP1a,
  "P1b": expandP1b,
  "P1c": expandP1c,
  "P2": expandP2,
  "P3": expandP3,
  "P4": expandP4,
  "P5": expandP5,
  "P6": expandP6,
  "P7": expandP7,
  "P8": expandP8,
  "P9": expandP9,
} as const;
