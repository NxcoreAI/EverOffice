/**
 * F 系预设：圆点箭头流程 F1、横幅+卡片阵 F2、时间轴 F3、
 * 阶段路线条 F4、分层架构 F5、竖向里程碑 F6。
 */

import { CANVAS_W, splitColumns, splitRows, type Frame } from "../grid.js";
import {
  bodyRuns,
  headingRuns,
  textElement,
  type PageSpec,
  type SpecElement,
} from "../elements.js";
import { estimateLines, estimateLineHeight, textBoxHeight } from "../text-metrics.js";
import { enumValue, list, objects, str } from "../parse.js";
import { banner, pageTitle, type PresetContext } from "../preset-common.js";

type Input = Record<string, unknown>;

function expandF1(input: Input, ctx: PresetContext): PageSpec {
  const steps = objects(list(input, "steps", { required: true, min: 3, max: 4 }), "F1 steps").map((s) => ({
    name: str(s, "name", { required: true, max: 6 }),
    desc: str(s, "desc", { max: 30 }),
  }));
  const bannerText = str(input, "banner", { max: 30 });
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  let nodesTop = 280;
  if (bannerText) {
    elements.push(...banner(bannerText, str(input, "bannerValue", { max: 12 }) || undefined, { x: ctx.M, y: ctx.frame.y, w: ctx.frame.w, h: 64 }, ctx, 64));
    nodesTop = 320;
  }
  const nodeW = 150;
  const nodeH = 96;
  const nameSize = 16;
  const descSize = 13;
  const halfW = ctx.frame.w / 2;
  const groupGap = 60;
  const groups = [steps.slice(0, Math.ceil(steps.length / 2)), steps.slice(Math.ceil(steps.length / 2))];
  let nodeIndex = 0;
  groups.forEach((group, gi) => {
    const groupX = ctx.M + gi * (halfW + groupGap / 2);
    const groupW = halfW - groupGap / 2;
    const cells = splitColumns({ x: groupX, y: nodesTop, w: groupW, h: nodeH }, group.length, 40);
    group.forEach((step) => {
      const cell = cells[nodeIndex % group.length]!;
      const cx = cell.x + (cell.w - nodeW) / 2;
      if (step.name.length > 6) throw new Error("PRESET_INVALID: F1 节点名 ≤6 字");
      elements.push({
        type: "shape",
        shape: "ellipse",
        x: Math.round(cx),
        y: Math.round(cell.y + (cell.h - nodeH) / 2),
        w: nodeW,
        h: nodeH,
        fill: ctx.theme.colors.primary,
        paragraphs: [{ runs: [{ text: step.name, sizePt: nameSize, bold: true, color: ctx.theme.colors.onDarkText, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }], align: "center" }],
        valign: "middle",
      });
      if (step.desc) {
        const descW = cell.w + 20;
        const descX = cell.x + (cell.w - descW) / 2;
        elements.push(textElement(
          { x: Math.max(ctx.M, descX), y: cell.y + nodeH + 24, w: descW, h: textBoxHeight(step.desc, descSize, descW) },
          [{ runs: bodyRuns(step.desc, descSize, ctx.theme.colors.textMuted, ctx.theme), align: "center" }],
        ));
      }
      nodeIndex++;
    });
    if (group.length > 1) {
      const first = cells[0]!;
      const second = cells[1]!;
      const arrowX = first.x + (first.w - nodeW) / 2 + nodeW;
      const arrowEnd = second.x + (second.w - nodeW) / 2;
      elements.push({
        type: "shape",
        shape: "lineArrow",
        x: Math.round(arrowX),
        y: Math.round(nodesTop + nodeH / 2),
        w: Math.round(Math.max(8, arrowEnd - arrowX)),
        h: 1,
        stroke: { color: ctx.theme.colors.primary, widthPt: 1.5 },
      });
    }
  });
  return { background: ctx.theme.colors.background, elements };
}

function expandF2(input: Input, ctx: PresetContext): PageSpec {
  const bannerInput = objects([input.banner ?? {}], "F2 banner")[0]!;
  const bannerText = str(bannerInput, "text", { required: true, max: 40 });
  const bannerValue = str(bannerInput, "value", { max: 16 });
  const cards = objects(list(input, "cards", { required: true, min: 3, max: 6 }), "F2 cards").map((c, i) => ({
    icon: str(c, "icon", { max: 40 }),
    title: str(c, "title", { required: true, max: 16 }),
    body: str(c, "body", { required: true, max: 60 }),
    _i: i,
  }));
  if (cards.length === 5) throw new Error("PRESET_INVALID: F2 卡片数须为 3、4 或 6（5 张无法等分网格）");
  const elements: SpecElement[] = [
    ...pageTitle(str(input, "title", { required: true, max: 40 }), ctx),
    ...banner(bannerText, bannerValue || undefined, { x: ctx.M, y: ctx.frame.y, w: ctx.frame.w, h: 72 }, ctx),
  ];
  const cardsFrame = { x: ctx.M, y: ctx.frame.y + 100, w: ctx.frame.w, h: ctx.frame.h - 100 };
  const padding = ctx.theme.spacing.cardPadding;
  const titleSize = 16;
  const bodySize = 13;
  const buildCard = (c: (typeof cards)[number], frame: Frame) => {
    const innerW = frame.w - padding * 2;
    const titleLines = estimateLines(c.title, titleSize, innerW);
    const bodyLines = estimateLines(c.body, bodySize, innerW);
    const titleH = titleLines * estimateLineHeight(titleSize);
    const bodyH = bodyLines * estimateLineHeight(bodySize);
    const total = titleH + 8 + bodyH;
    if (total > frame.h - padding * 2) throw new Error(`PRESET_INVALID: F2 第 ${c._i + 1} 卡内容超高——精简正文`);
    const els: SpecElement[] = [{
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: Math.round(frame.h),
      fill: ctx.theme.colors.cardSurface,
    }];
    const top = frame.y + (frame.h - total) / 2;
    els.push(textElement(
      { x: frame.x + padding, y: top, w: innerW, h: titleH + 4 },
      [{ runs: headingRuns(`${c._i + 1}. ${c.title}`, titleSize, ctx.theme.colors.text, ctx.theme) }],
    ));
    els.push(textElement(
      { x: frame.x + padding, y: top + titleH + 8, w: innerW, h: bodyH + 4 },
      [{ runs: bodyRuns(c.body, bodySize, ctx.theme.colors.textMuted, ctx.theme) }],
    ));
    return els;
  };
  if (cards.length <= 4) {
    const cells = splitColumns(cardsFrame, cards.length, ctx.G);
    elements.push(...cards.flatMap((c, i) => buildCard(c, cells[i]!)));
  } else {
    const rows = splitRows(cardsFrame, 2, ctx.G);
    const top = splitColumns(rows[0]!, 3, ctx.G);
    const bottom = splitColumns(rows[1]!, 3, ctx.G);
    const cells = [...top, ...bottom];
    elements.push(...cards.flatMap((c, i) => buildCard(c, cells[i]!)));
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandF3(input: Input, ctx: PresetContext): PageSpec {
  const milestones = objects(list(input, "milestones", { required: true, min: 4, max: 6 }), "F3 milestones").map((m) => ({
    time: str(m, "time", { required: true, max: 12 }),
    event: str(m, "event", { required: true, max: 30 }),
    done: m.done === true,
  }));
  const direction = enumValue(input, "direction", ["horizontal", "vertical"] as const, "horizontal");
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  const timeSize = 16;
  const eventSize = 13;
  if (direction === "horizontal") {
    const lineY = 410;
    elements.push({ type: "shape", shape: "rect", x: ctx.M, y: lineY, w: ctx.frame.w, h: 2, fill: ctx.theme.colors.divider });
    const cellW = ctx.frame.w / milestones.length;
    milestones.forEach((m, i) => {
      const cx = ctx.M + cellW * (i + 0.5);
      elements.push({
        type: "shape",
        shape: "ellipse",
        x: Math.round(cx - 7),
        y: lineY - 6,
        w: 14,
        h: 14,
        ...(m.done
          ? { fill: ctx.theme.colors.primary }
          : { fill: ctx.theme.colors.background, stroke: { color: ctx.theme.colors.primary, widthPt: 1.5 } }),
      });
      const blockW = cellW - ctx.G;
      const timeH = estimateLineHeight(timeSize) + 4;
      const eventH = estimateLines(m.event, eventSize, blockW) * estimateLineHeight(eventSize) + 4;
      const above = i % 2 === 0;
      const blockH = timeH + 4 + eventH;
      const y = above ? lineY - 28 - blockH : lineY + 28;
      elements.push(textElement(
        { x: Math.round(cx - blockW / 2), y, w: Math.round(blockW), h: timeH },
        [{ runs: headingRuns(m.time, timeSize, m.done ? ctx.theme.colors.primary : ctx.theme.colors.text, ctx.theme), align: "center" }],
      ));
      elements.push(textElement(
        { x: Math.round(cx - blockW / 2), y: y + timeH + 4, w: Math.round(blockW), h: eventH },
        [{ runs: bodyRuns(m.event, eventSize, ctx.theme.colors.textMuted, ctx.theme), align: "center" }],
      ));
    });
  } else {
    const lineX = ctx.M + 80;
    elements.push({ type: "shape", shape: "rect", x: lineX, y: ctx.frame.y, w: 2, h: ctx.frame.h, fill: ctx.theme.colors.divider });
    const rowH = ctx.frame.h / milestones.length;
    milestones.forEach((m, i) => {
      const cy = ctx.frame.y + rowH * (i + 0.5);
      elements.push({
        type: "shape",
        shape: "ellipse",
        x: lineX - 6,
        y: Math.round(cy - 7),
        w: 14,
        h: 14,
        ...(m.done ? { fill: ctx.theme.colors.primary } : { fill: ctx.theme.colors.background, stroke: { color: ctx.theme.colors.primary, widthPt: 1.5 } }),
      });
      const textX = lineX + 28;
      const textW = ctx.frame.w - (textX - ctx.M);
      elements.push(textElement(
        { x: textX, y: cy - 44, w: textW, h: 44 },
        [{ runs: headingRuns(m.time, timeSize, m.done ? ctx.theme.colors.primary : ctx.theme.colors.text, ctx.theme) }],
        "bottom",
      ));
      elements.push(textElement(
        { x: textX, y: cy + 2, w: textW, h: 44 },
        [{ runs: bodyRuns(m.event, eventSize, ctx.theme.colors.textMuted, ctx.theme) }],
        "top",
      ));
    });
  }
  return { background: ctx.theme.colors.background, elements };
}

function expandF4(input: Input, ctx: PresetContext): PageSpec {
  const stages = objects(list(input, "stages", { required: true, min: 3, max: 4 }), "F4 stages").map((s) => ({
    name: str(s, "name", { required: true, max: 8 }),
    deliverables: list(s, "deliverables", { required: true, min: 1, max: 3 }).map((v) => String(v).slice(0, 18)),
    status: enumValue(s, "status", ["done", "current", "future"] as const, "future"),
  }));
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  const rows = splitRows(ctx.frame, stages.length, ctx.G);
  const nameSize = 18;
  const pointSize = 13;
  stages.forEach((stage, i) => {
    const frame = rows[i]!;
    const isCurrent = stage.status === "current";
    const fill = stage.status === "done" ? ctx.theme.colors.primarySoft
      : isCurrent ? ctx.theme.colors.primary
      : ctx.theme.colors.cardSurface;
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: Math.round(frame.h),
      fill,
    });
    const textColor = isCurrent ? ctx.theme.colors.onDarkText : ctx.theme.colors.text;
    const pointColor = isCurrent ? ctx.theme.colors.onDarkText : ctx.theme.colors.textMuted;
    const leftW = 260;
    const iconSize = 22;
    const nameH = estimateLineHeight(nameSize) + 4;
    const nameY = frame.y + (frame.h - nameH) / 2;
    if (stage.status === "done") {
      elements.push({ type: "icon", icon: "check", color: ctx.theme.colors.primary, x: Math.round(frame.x + 24), y: Math.round(nameY + 2), w: iconSize, h: iconSize });
    }
    const nameX = frame.x + 24 + (stage.status === "done" ? iconSize + 10 : 0);
    elements.push(textElement(
      { x: nameX, y: nameY, w: frame.x + leftW - nameX - 8, h: nameH },
      [{ runs: headingRuns(stage.name, nameSize, textColor, ctx.theme) }],
      "middle",
    ));
    const pointsX = frame.x + leftW + 24;
    const pointsW = frame.w - leftW - 48;
    const pointH = estimateLineHeight(pointSize) + 8;
    stage.deliverables.forEach((point, j) => {
      elements.push(textElement(
        { x: Math.round(pointsX + (j * pointsW) / stage.deliverables.length), y: frame.y, w: Math.round(pointsW / stage.deliverables.length - 20), h: frame.h },
        [{ runs: bodyRuns(point, pointSize, pointColor, ctx.theme) }],
        "middle",
      ));
    });
  });
  return { background: ctx.theme.colors.background, elements };
}

function expandF5(input: Input, ctx: PresetContext): PageSpec {
  const layers = objects(list(input, "layers", { required: true, min: 3, max: 5 }), "F5 layers").map((l) => ({
    name: str(l, "name", { required: true, max: 6 }),
    modules: list(l, "modules", { required: true, min: 1, max: 6 }).map((v) => String(v).slice(0, 10)),
  }));
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  const rows = splitRows(ctx.frame, layers.length, 16);
  const bandW = 120;
  const nameSize = 14;
  const moduleSize = 13;
  layers.forEach((layer, i) => {
    const frame = rows[i]!;
    const bandFill = ctx.theme.colors.chartSeries[i % ctx.theme.colors.chartSeries.length]!;
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: Math.round(frame.h),
      fill: ctx.theme.colors.cardSurface,
    });
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: bandW,
      h: Math.round(frame.h),
      fill: bandFill,
      paragraphs: [{ runs: [{ text: layer.name, sizePt: nameSize, bold: true, color: ctx.theme.colors.onDarkText, ...(ctx.theme.fonts.heading ? { font: ctx.theme.fonts.heading } : {}) }], align: "center" }],
      valign: "middle",
    });
    const modulesX = frame.x + bandW + 20;
    const modulesW = frame.w - bandW - 40;
    const cells = splitColumns({ x: modulesX, y: frame.y + 12, w: modulesW, h: frame.h - 24 }, layer.modules.length, 12);
    layer.modules.forEach((moduleName, j) => {
      const cell = cells[j]!;
      elements.push({
        type: "shape",
        shape: "roundRect",
        x: Math.round(cell.x),
        y: Math.round(cell.y),
        w: Math.round(cell.w),
        h: Math.round(cell.h),
        fill: ctx.theme.colors.background,
        paragraphs: [{ runs: [{ text: moduleName, sizePt: moduleSize, color: ctx.theme.colors.text, ...(ctx.theme.fonts.body ? { font: ctx.theme.fonts.body } : {}) }], align: "center" }],
        valign: "middle",
      });
    });
  });
  return { background: ctx.theme.colors.background, elements };
}

function expandF6(input: Input, ctx: PresetContext): PageSpec {
  const milestones = objects(list(input, "milestones", { required: true, min: 4, max: 6 }), "F6 milestones").map((m) => ({
    time: str(m, "time", { required: true, max: 12 }),
    event: str(m, "event", { required: true, max: 40 }),
  }));
  const elements: SpecElement[] = [...pageTitle(str(input, "title", { required: true, max: 40 }), ctx)];
  const hasSide = input.side !== undefined;
  const lineX = ctx.M + 40;
  const listW = hasSide ? Math.round(ctx.frame.w * 0.55) : ctx.frame.w - 80;
  elements.push({ type: "shape", shape: "rect", x: lineX, y: ctx.frame.y, w: 2, h: ctx.frame.h, fill: ctx.theme.colors.divider });
  const rowH = ctx.frame.h / milestones.length;
  const timeSize = 16;
  const eventSize = 13;
  milestones.forEach((m, i) => {
    const cy = ctx.frame.y + rowH * (i + 0.5);
    elements.push({ type: "shape", shape: "ellipse", x: lineX - 6, y: Math.round(cy - 7), w: 14, h: 14, fill: ctx.theme.colors.primary });
    const textX = lineX + 28;
    const textW = listW - (textX - ctx.M);
    const timeH = estimateLineHeight(timeSize) + 4;
    const eventH = estimateLines(m.event, eventSize, textW) * estimateLineHeight(eventSize) + 4;
    const blockH = timeH + 6 + eventH;
    const top = cy - blockH / 2;
    elements.push(textElement({ x: textX, y: top, w: textW, h: timeH }, [{ runs: headingRuns(m.time, timeSize, ctx.theme.colors.primary, ctx.theme) }]));
    elements.push(textElement({ x: textX, y: top + timeH + 6, w: textW, h: eventH }, [{ runs: bodyRuns(m.event, eventSize, ctx.theme.colors.textMuted, ctx.theme) }]));
  });
  if (hasSide) {
    const side = objects([input.side], "F6 side")[0]!;
    const sideX = ctx.M + listW + ctx.G;
    const sideW = CANVAS_W - ctx.M - sideX;
    const sideFrame = { x: sideX, y: ctx.frame.y, w: sideW, h: ctx.frame.h };
    if (typeof side.image === "object" && side.image !== null) {
      const image = objects([side.image], "F6 side.image")[0]!;
      const url = str(image, "url", { required: true, max: 500 });
      elements.push({
        type: "image",
        x: Math.round(sideFrame.x),
        y: Math.round(sideFrame.y),
        w: Math.round(sideFrame.w),
        h: Math.round(sideFrame.h),
        url: /^https?:\/\//i.test(url) || /^everroom-material:\/\//i.test(url) ? url : (() => { throw new Error("PRESET_INVALID: F6 配图 url 只接受 http(s) 或 everroom-material://"); })(),
        fit: ctx.theme.decoration.imageFit,
      });
    } else {
      const title = str(side, "title", { required: true, max: 20 });
      const body = str(side, "body", { required: true, max: 120 });
      const padding = ctx.theme.spacing.cardPadding;
      const innerW = sideFrame.w - padding * 2;
      const titleSize = 18;
      const bodySize = 14;
      const titleH = estimateLines(title, titleSize, innerW) * estimateLineHeight(titleSize);
      const bodyH = estimateLines(body, bodySize, innerW) * estimateLineHeight(bodySize);
      const total = titleH + 12 + bodyH;
      const top = sideFrame.y + (sideFrame.h - total) / 2;
      elements.push({
        type: "shape",
        shape: "roundRect",
        x: Math.round(sideFrame.x),
        y: Math.round(sideFrame.y),
        w: Math.round(sideFrame.w),
        h: Math.round(sideFrame.h),
        fill: ctx.theme.colors.cardSurface,
      });
      elements.push(textElement({ x: sideFrame.x + padding, y: top, w: innerW, h: titleH + 4 }, [{ runs: headingRuns(title, titleSize, ctx.theme.colors.text, ctx.theme) }]));
      elements.push(textElement({ x: sideFrame.x + padding, y: top + titleH + 12, w: innerW, h: bodyH + 4 }, [{ runs: bodyRuns(body, bodySize, ctx.theme.colors.textMuted, ctx.theme), lineSpacingPct: 130 }]));
    }
  }
  return { background: ctx.theme.colors.background, elements };
}

export const FLOW_PRESETS = {
  "F1": expandF1,
  "F2": expandF2,
  "F3": expandF3,
  "F4": expandF4,
  "F5": expandF5,
  "F6": expandF6,
} as const;
