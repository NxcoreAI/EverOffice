/**
 * v2 页面视觉丰富度闸门：内容/数据/表格/流程页不能只有文字 + 白底。
 * 至少要有 1 个信息图形原子（image/chart/table/stats/component/icon/path），
 * 或一个非全屏的装饰 shape（短线/色块/分隔）。封面/收尾/引语页不强制。
 */

import type { V2Page } from "./schema.js";

const VISUAL_TYPES = new Set(["image", "chart", "table", "stats", "component", "icon", "path", "group", "connector"]);
const GATED_ROLES = new Set(["content", "data", "table", "flow"]);

function slotArea(page: V2Page, slot: { col: [number, number]; row: [number, number] }): number {
  const cols = page.grid?.cols ?? 12;
  const rows = page.grid?.rows ?? 8;
  return ((slot.col[1] - slot.col[0] + 1) / cols) * ((slot.row[1] - slot.row[0] + 1) / rows);
}

export function visualRichnessIssues(page: V2Page): string[] {
  if (!GATED_ROLES.has(page.role)) return [];
  const hasVisual = page.nodes.some((node) => VISUAL_TYPES.has(node.type));
  const hasDecorativeShape = page.nodes.some((node) => {
    if (node.type !== "shape") return false;
    const area = slotArea(page, node.slot);
    return area < 0.65 || Boolean(node.stroke);
  });
  const issues: string[] = [];
  if (!hasVisual && !hasDecorativeShape) {
    issues.push("页面只有文字和白底，缺少视觉锚点：至少加一个 icon/path/table/chart/stats/component，或一条非全屏装饰色块/短线");
  }
  // 参考 BP 的内容页至少 4 个模块（标题带/标题/主内容/结论或脚注）；<4 通常是一块内容撑不满。
  if (page.nodes.length < 4) {
    issues.push(`页面只有 ${page.nodes.length} 个节点，模块过少：参考级页面至少 4 个模块（标题带/标题/主内容/结论或导航）`);
  }
  return issues;
}
