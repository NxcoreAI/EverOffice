/**
 * 量测器：编译产物 + 树 + 契约 → 结构化缺陷清单。
 * 全部确定性检查（估算系数与引擎对齐），供 validate 工具回传布局代理自纠。
 * shrinkToFit 为迭代环耗尽后的引擎兜底：文字叶子逐档降字号，到下限为止。
 */

import type { CompileResult } from "./compile.js";
import { compileTree } from "./compile.js";
import { variantSize } from "./compile.js";
import type { LayoutContract, TextVariant } from "./layout-contract.js";
import type { LayoutTree } from "./schema.js";
import { contractFromStyleParams } from "./layout-contract.js";

export type DefectType = "schema" | "overflow" | "min_size" | "font_floor" | "element_cap" | "image_ar" | "canvas";

export interface LayoutDefect {
  path: string;
  type: DefectType;
  detail: string;
  hint: string;
}

export interface MeasureInput {
  /** 图片 url → 长宽比（宽/高）；取不到的 url 不进 Map。 */
  imageArs?: Map<string, number>;
}

const OVERFLOW_TOLERANCE_PX = 2;

export function measureDefects(result: CompileResult, contract: LayoutContract, input: MeasureInput = {}): LayoutDefect[] {
  const defects: LayoutDefect[] = [];
  const push = (path: string, type: DefectType, detail: string, hint: string) =>
    defects.push({ path, type, detail, hint });

  for (const compileDefect of result.defects) {
    push(compileDefect.path, "overflow", compileDefect.detail, "调整该区域的权重/比例，或精简内容");
  }

  for (const placement of result.placements) {
    const { frame } = placement;
    if (frame.w < contract.minLeaf.w || frame.h < contract.minLeaf.h) {
      push(
        placement.path,
        "min_size",
        `区域过小（${Math.round(frame.w)}×${Math.round(frame.h)}px，下限 ${contract.minLeaf.w}×${contract.minLeaf.h}px）`,
        "加大该子树的权重，或减少兄弟节点数量",
      );
      continue;
    }
    if (placement.kind === "text" && placement.neededHeight !== undefined) {
      if (placement.neededHeight > frame.h + OVERFLOW_TOLERANCE_PX) {
        push(
          placement.path,
          "overflow",
          `文字估算 ${Math.round(placement.neededHeight)}px 超出区域 ${Math.round(frame.h)}px（${placement.variant} ${placement.sizePt}pt）`,
          "加大权重/换更宽的区域，精简文字，或拆成多个文字叶子",
        );
      }
    }
    if (placement.kind === "image" && placement.contain && placement.url && input.imageArs) {
      const ar = input.imageArs.get(placement.url);
      if (ar !== undefined && ar > 0) {
        const frameAr = frame.w / frame.h;
        const deviation = Math.abs(frameAr / ar - 1);
        if (deviation > contract.imageArTolerance) {
          push(
            placement.path,
            "image_ar",
            `contain 模式下框长宽比 ${frameAr.toFixed(2)} 与图 ${ar.toFixed(2)} 偏差 ${Math.round(deviation * 100)}%（空带过宽）`,
            "调整区域比例贴近图片长宽比，或改用 cover 裁切填满",
          );
        }
      }
    }
  }

  if (result.stats.elements > contract.caps.elements) {
    push("root", "element_cap", `元素总数 ${result.stats.elements} 超过上限 ${contract.caps.elements}`, "减少叶子数量或降低嵌套密度");
  }
  if (result.stats.images > contract.caps.images) {
    push("root", "element_cap", `图片数 ${result.stats.images} 超过上限 ${contract.caps.images}`, "减少图片叶子");
  }
  if (result.stats.paths > contract.caps.paths) {
    push("root", "element_cap", `路径数 ${result.stats.paths} 超过上限 ${contract.caps.paths}`, "减少路径叶子");
  }

  for (const element of result.spec.elements) {
    if (
      element.x < 0 || element.y < 0 ||
      element.x + element.w > contract.canvas.w + 1 ||
      element.y + element.h > contract.canvas.h + 1
    ) {
      push("root", "canvas", `元素越出画布（x=${Math.round(element.x)} y=${Math.round(element.y)} w=${Math.round(element.w)} h=${Math.round(element.h)}）`, "检查嵌套 pad 与缝隙总和");
      break;
    }
  }

  return defects;
}

export interface ShrinkResult {
  result: CompileResult;
  defects: LayoutDefect[];
  /** 降档是否生效过（生效即标记 degraded，供 VLM 终检重点看）。 */
  degraded: boolean;
  overrides: Map<string, number>;
}

/**
 * 迭代环耗尽后的兜底：对溢出的文字叶子逐档降字号（-1pt）重编，
 * 到契约字号下限为止。卡片/表格类溢出不在此兜底（保持内容不丢，交 VLM 终检）。
 */
export function shrinkToFit(tree: LayoutTree, contract: LayoutContract, input: MeasureInput = {}, maxIterations = 12): ShrinkResult {
  const overrides = new Map<string, number>();
  let degraded = false;
  let current = compileTree(tree, contract, overrides);
  let defects = measureDefects(current, contract, input);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const overflowTexts = defects.filter(
      (defect) => defect.type === "overflow" && defect.path !== "root.title",
    );
    if (overflowTexts.length === 0) break;

    let reduced = false;
    for (const defect of overflowTexts) {
      const placement = current.placements.find((p) => p.path === defect.path && p.kind === "text");
      if (!placement || placement.variant === undefined || placement.sizePt === undefined) continue;
      const floor = contract.fontFloors[placement.variant as TextVariant];
      const nextSize = placement.sizePt - 1;
      if (nextSize < floor) {
        if (!defects.some((d) => d.path === defect.path && d.type === "font_floor")) {
          defects.push({
            path: defect.path,
            type: "font_floor",
            detail: `${placement.variant} 已降到下限 ${floor}pt 仍溢出`,
            hint: "内容超出单页容量——精简文字或拆两页",
          });
        }
        continue;
      }
      overrides.set(defect.path, nextSize);
      reduced = true;
      degraded = true;
    }
    if (!reduced) break;

    current = compileTree(tree, contract, overrides);
    defects = measureDefects(current, contract, input);
  }

  return { result: current, defects, degraded, overrides };
}

/** 便捷入口：树 + styleParams → 编译 + 量测（validate 工具与测试共用）。 */
export function compileAndMeasure(tree: LayoutTree, styleParams: unknown, input: MeasureInput = {}): { result: CompileResult; defects: LayoutDefect[] } {
  const contract = contractFromStyleParams(styleParams as never);
  const result = compileTree(tree, contract);
  const defects = measureDefects(result, contract, input);
  return { result, defects };
}
