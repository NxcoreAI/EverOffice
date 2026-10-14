/**
 * flex 树编译器：LayoutTree + 契约 → PageSpec。
 * agent 只出结构与比例；坐标、字号、配色全部在这里确定性算出。
 * 同父子框相接（划分构造），文本墨迹重叠由引擎闸门兜底。
 * 叶子渲染器抛的 LAYOUT_LEAF_INVALID 在这里转成缺陷（不中断整页编译）。
 */

import { padFrame, type Frame } from "../grid.js";
import { snap4 } from "../theme.js";
import { imageElement, type PageSpec, type SpecElement } from "../elements.js";
import { estimateLineHeight, estimateLines } from "../text-metrics.js";
import type { LayoutContract, TextVariant } from "./layout-contract.js";
import type { ContainerNode, LayoutTree, LeafNode, TreeNode } from "./schema.js";
import { isLeaf } from "./schema.js";
import {
  isTreeErrorLike,
  renderCardLeaf,
  renderChartLeaf,
  renderTableLeaf,
  renderTextLeaf,
  titleBand,
} from "./leaf-renderers.js";

export interface LeafPlacement {
  path: string;
  kind: LeafNode["type"];
  frame: Frame;
  variant?: TextVariant;
  sizePt?: number;
  /** 文字叶子的估算内容高（px）。 */
  neededHeight?: number;
  url?: string;
  contain?: boolean;
}

export interface CompileDefect {
  path: string;
  type: "overflow";
  detail: string;
}

export interface CompileResult {
  spec: PageSpec;
  placements: LeafPlacement[];
  defects: CompileDefect[];
  stats: { elements: number; leaves: number; depth: number; images: number; paths: number };
}

const VARIANT_SIZE_KEY: Record<TextVariant, "coverTitle" | "sectionTitle" | "subtitle" | "body" | "caption"> = {
  display: "coverTitle",
  heading: "sectionTitle",
  subtitle: "subtitle",
  body: "body",
  caption: "caption",
};

/** 文字变体 → 契约主题字号档。 */
export function variantSize(variant: TextVariant, contract: LayoutContract): number {
  return contract.theme.sizes[VARIANT_SIZE_KEY[variant]];
}

/** 多段文字（\n 拆段）在框宽下的估算内容高。 */
function neededHeightFor(text: string, sizePt: number, boxWidth: number): number {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce((sum, line) => sum + estimateLines(line, sizePt, boxWidth), 0);
  return lines * estimateLineHeight(sizePt) + estimateLineHeight(sizePt) * 0.35;
}

interface WalkState {
  elements: SpecElement[];
  placements: LeafPlacement[];
  defects: CompileDefect[];
  stats: { elements: number; leaves: number; depth: number; images: number; paths: number };
  sizeOverrides: Map<string, number>;
  contract: LayoutContract;
}

function gapFor(node: { gapScale?: number }, contract: LayoutContract): number {
  const scale = node.gapScale ?? 1;
  return Math.max(0, snap4(contract.theme.spacing.gutter * scale));
}

/** 容器内子框分配：先扣缝隙，再按权重分（snap 取整，余数给末位，至少 1px）。 */
function splitFrame(frame: Frame, node: ContainerNode, contract: LayoutContract, direction: "row" | "column"): Frame[] {
  const count = node.children.length;
  const span = direction === "row" ? frame.w : frame.h;
  let gap = gapFor(node, contract);
  const totalGap = gap * (count - 1);
  if (count > 1 && totalGap > span - 40) {
    gap = Math.max(0, Math.floor((span - 40) / (count - 1)));
  }
  const usable = Math.max(count, span - gap * (count - 1));
  const weights = node.weights ?? node.children.map(() => 1);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const sizes: number[] = [];
  let allocated = 0;
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      sizes.push(Math.max(1, usable - allocated));
    } else {
      const size = Math.max(1, Math.round((usable * weights[i]!) / weightSum));
      sizes.push(size);
      allocated += size;
    }
  }
  const frames: Frame[] = [];
  let offset = direction === "row" ? frame.x : frame.y;
  for (let i = 0; i < count; i++) {
    const size = sizes[i]!;
    if (direction === "row") {
      frames.push({ x: offset, y: frame.y, w: size, h: frame.h });
      offset += size + gap;
    } else {
      frames.push({ x: frame.x, y: offset, w: frame.w, h: size });
      offset += size + gap;
    }
  }
  return frames;
}

function walk(node: TreeNode, frame: Frame, path: string, depth: number, state: WalkState): void {
  state.stats.depth = Math.max(state.stats.depth, depth);
  if (isLeaf(node)) {
    renderLeaf(node, frame, path, state);
    return;
  }
  const inner = node.pad ? padFrame(frame, snap4(node.pad)) : frame;
  const childFrames = splitFrame(inner, node, state.contract, node.direction);
  node.children.forEach((child, i) => walk(child, childFrames[i]!, `${path}/${i}`, depth + 1, state));
}

function renderLeaf(leaf: LeafNode, frame: Frame, path: string, state: WalkState): void {
  const { contract } = state;
  const theme = contract.theme;
  state.stats.leaves += 1;
  try {
    switch (leaf.type) {
      case "text": {
        const sizePt = state.sizeOverrides.get(path) ?? variantSize(leaf.variant, contract);
        const element = renderTextLeaf(leaf, frame, theme, sizePt, false);
        state.elements.push(element);
        state.stats.elements += 1;
        state.placements.push({
          path,
          kind: "text",
          frame,
          variant: leaf.variant,
          sizePt,
          neededHeight: neededHeightFor(leaf.text, sizePt, frame.w),
        });
        return;
      }
      case "image": {
        state.elements.push(imageElement(frame, leaf.url, theme, leaf.contain === true ? "contain" : "cover"));
        state.stats.elements += 1;
        state.stats.images += 1;
        state.placements.push({ path, kind: "image", frame, url: leaf.url, contain: leaf.contain === true });
        return;
      }
      case "card": {
        const elements = renderCardLeaf(leaf, frame, theme, `${path} 卡`);
        state.elements.push(...elements);
        state.stats.elements += elements.length;
        state.placements.push({ path, kind: "card", frame });
        return;
      }
      case "path": {
        state.elements.push({
          type: "path",
          d: leaf.d,
          fill: theme.colors.primarySoft,
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          w: Math.round(frame.w),
          h: Math.round(frame.h),
        });
        state.stats.elements += 1;
        state.stats.paths += 1;
        state.placements.push({ path, kind: "path", frame });
        return;
      }
      case "chart": {
        const element = renderChartLeaf(leaf, frame, theme);
        state.elements.push(element);
        state.stats.elements += 1;
        state.placements.push({ path, kind: "chart", frame });
        return;
      }
      case "table": {
        const element = renderTableLeaf(leaf, frame, theme, `${path} 表格`);
        state.elements.push(element);
        state.stats.elements += 1;
        state.placements.push({ path, kind: "table", frame });
        return;
      }
    }
  } catch (error) {
    if (isTreeErrorLike(error)) {
      state.defects.push({ path, type: "overflow", detail: error.message.replace(/^LAYOUT_LEAF_INVALID: /, "") });
      return;
    }
    throw error;
  }
}

export function compileTree(
  tree: LayoutTree,
  contract: LayoutContract,
  sizeOverrides?: Map<string, number>,
): CompileResult {
  const state: WalkState = {
    elements: [],
    placements: [],
    defects: [],
    stats: { elements: 0, leaves: 0, depth: 0, images: 0, paths: 0 },
    sizeOverrides: sizeOverrides ?? new Map(),
    contract,
  };
  const theme = contract.theme;
  const spec: PageSpec = {
    background: tree.dark === true ? theme.colors.darkBackground : theme.colors.background,
    elements: state.elements,
  };
  if (tree.title) {
    const bandFrame: Frame = {
      x: contract.contentFrame.x,
      y: contract.titleBand.y,
      w: contract.contentFrame.w,
      h: contract.titleBand.maxBottom - contract.titleBand.y,
    };
    try {
      state.elements.push(...titleBand(tree.title, bandFrame, theme, tree.dark === true));
      state.stats.elements += 1;
    } catch (error) {
      if (isTreeErrorLike(error)) {
        state.defects.push({ path: "root.title", type: "overflow", detail: error.message.replace(/^LAYOUT_LEAF_INVALID: /, "") });
      } else {
        throw error;
      }
    }
  }
  const rootContainer: ContainerNode = {
    direction: tree.direction,
    ...(tree.weights ? { weights: tree.weights } : {}),
    ...(tree.gapScale !== undefined ? { gapScale: tree.gapScale } : {}),
    ...(tree.pad !== undefined ? { pad: tree.pad } : {}),
    children: tree.children,
  };
  const inner = tree.pad ? padFrame(contract.contentFrame, snap4(tree.pad)) : contract.contentFrame;
  const childFrames = splitFrame(inner, rootContainer, contract, tree.direction);
  tree.children.forEach((child, i) => walk(child, childFrames[i]!, `root/${i}`, 1, state));
  return { spec, placements: state.placements, defects: state.defects, stats: state.stats };
}
