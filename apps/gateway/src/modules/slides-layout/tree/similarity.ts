/**
 * 页间树相似度审计：深度 ≤2 的结构签名，相邻页同签名 → 打回重排。
 * 取代旧 slides-layout-audit 的预设序列五规则。
 */

import type { LayoutTree, TreeNode } from "./schema.js";
import { isLeaf } from "./schema.js";

/** 节点在深度 ≤2 内的结构摘要：方向+子数，容器子节点递归一层，叶子记 *（组件叶子带名字，纯组件页不互相误判同构）。 */
function nodeSummary(node: TreeNode, depth: number): string {
  if (isLeaf(node)) {
    if (node.type !== "component") return "*";
    const style = node.style ? Object.values(node.style).join(",") : "";
    return `c:${node.name}:${style}`;
  }
  const children = node.children
    .map((child) => (depth >= 2 ? (isLeaf(child) ? "*" : `${child.children.length}`) : nodeSummary(child, depth + 1)))
    .join(",");
  return `${node.direction[0]}${node.children.length}[${children}]`;
}

export function treeSignature(tree: LayoutTree): string {
  if (tree.version === 2 && tree.v2) {
    return `v2:${tree.v2.composition}:${tree.v2.nodes.map((node) => {
      const slot = node.type === "connector" ? "connector" : `${node.slot.col.join("-")}:${node.slot.row.join("-")}`;
      return `${node.type}:${slot}:${
        node.type === "text" ? node.token
          : node.type === "component" ? `${node.name}:${node.style ? Object.values(node.style).join(",") : ""}`
            : ""
      }`;
    }).join("|")}`;
  }
  return `${tree.role}|${tree.bg ? "bg" : "-"}|${nodeSummary(tree, 0)}`;
}

/**
 * 相邻页签名相同 → 建议重排页（每对取后一页）。
 * 返回去重后的页码数组（0 基）。连续三页同签名只重排最后一页——前两页已被邻对覆盖或保留。
 */
export function auditSimilarity(trees: LayoutTree[]): number[] {
  const reroll: number[] = [];
  for (let i = 1; i < trees.length; i++) {
    if (treeSignature(trees[i - 1]!) === treeSignature(trees[i]!)) {
      if (!reroll.includes(i) && !reroll.includes(i - 1)) reroll.push(i);
    }
  }
  return reroll;
}
