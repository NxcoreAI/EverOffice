/**
 * 论文排版 v2 · 映射计划 → 装订规格（过渡层）。
 *
 * 当前渲染器（genoffice thesis-binder）吃的是 `ThesisBindingSpec`：
 * chapters 的区间必须**互不重叠且按文档序**（它按 `blockStart+1 .. blockEnd` 逐块取）。
 * 本模块把 M3 产出的 MappingPlan（槽位 ↔ 章节）翻译成这个形状，
 * 让 v2 的"按槽位排序 + 未匹配兜底"立刻生效，而不必先改渲染器。
 *
 * M4b 会用 RenderPlan 取代它；在那之前它是唯一的渲染入口契约。
 */

import type { ContentOutlineNode, ContentProfile } from "./content-profile.js";
import type { MappingPlan } from "./mapping-plan.js";
import type { ThesisBindingSpec } from "./types.js";

/** 章节树 → 互不重叠的叶子区间序列（DFS 前序，与文档顺序一致）。 */
export function flattenLeafRanges(node: ContentOutlineNode): Array<{
  level: 1 | 2 | 3 | 4;
  headingText: string;
  blockStart: number;
  blockEnd: number;
}> {
  const out: Array<{ level: 1 | 2 | 3 | 4; headingText: string; blockStart: number; blockEnd: number }> = [];
  const walk = (current: ContentOutlineNode, level: 1 | 2 | 3 | 4): void => {
    const firstChild = current.children[0];
    // 自己的正文到此为止：有子节点就到第一个子节点，否则到节点区间末尾
    const bodyEnd = firstChild ? firstChild.blockStart : current.blockEnd;
    out.push({
      level,
      headingText: current.text,
      blockStart: current.blockStart,
      blockEnd: Math.max(bodyEnd, current.blockStart + 1),
    });
    for (const child of current.children) {
      walk(child, Math.min(level + 1, 4) as 1 | 2 | 3 | 4);
    }
  };
  walk(node, node.role === "chapter" ? 1 : node.role === "section" ? 2 : 3);
  return out;
}

/** 取区间内的段落文本（首块是标题，跳过）。 */
function textsIn(content: ContentProfile, range: [number, number]): string[] {
  const out: string[] = [];
  for (let index = range[0] + 1; index < range[1]; index += 1) {
    const block = content.blocks[index];
    if (!block) continue;
    if (block.kind === "paragraph" || block.kind === "list") {
      const text = block.text.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** 关键词行解析：「关键词：a；b，c」 → ["a","b","c"]。 */
function keywordsOf(texts: string[]): { keywords: string[]; withoutKeywordLine: string[] } {
  const keywords: string[] = [];
  const rest: string[] = [];
  for (const text of texts) {
    const match = /^\s*(关键词|关键字|keywords?)\s*[:：]?\s*(.+)$/i.exec(text);
    if (!match) {
      rest.push(text);
      continue;
    }
    for (const token of match[2]!.split(/[;；,，、]\s*/)) {
      const value = token.trim();
      if (value) keywords.push(value);
    }
  }
  return { keywords, withoutKeywordLine: rest };
}

/**
 * 映射计划 → 装订规格。
 *
 * 章节顺序 = 槽位顺序（分配到的章节按其槽位排序），追加章节排在正文之后；
 * 每个章节的子树按叶子区间展开，保证区间互不重叠。
 */
export function planToBindingSpec(input: {
  plan: MappingPlan;
  content: ContentProfile;
  /** 缺省论文题目（通常取源文件名）。 */
  titleHint: string;
}): { spec: ThesisBindingSpec; notes: string[] } {
  const { plan, content, titleHint } = input;
  const notes: string[] = [];
  const nodes = new Map<string, ContentOutlineNode>();
  const walk = (list: ContentOutlineNode[]): void => {
    for (const node of list) {
      nodes.set(node.traceId, node);
      walk(node.children);
    }
  };
  walk(content.outline);

  // 槽位顺序（body 在前、追加在后）
  const orderedAssignments = [...plan.assignments].sort((a, b) => {
    if (a.rule === "R4-append" && b.rule !== "R4-append") return 1;
    if (b.rule === "R4-append" && a.rule !== "R4-append") return -1;
    return a.blockRange[0] - b.blockRange[0];
  });

  const chapters: ThesisBindingSpec["chapters"] = [];
  const references: string[] = [];
  let appendixBlocks: ThesisBindingSpec["appendixBlocks"] = null;
  const acknowledgementParagraphs: string[] = [];
  const abstractZhTexts: string[] = [];
  const abstractEnTexts: string[] = [];
  let keywordsZh: string[] = [];
  let keywordsEn: string[] = [];

  for (const assignment of orderedAssignments) {
    const node = assignment.chapterTraceId ? nodes.get(assignment.chapterTraceId) : null;
    switch (assignment.kind) {
      case "reference":
        references.push(...textsIn(content, assignment.blockRange));
        break;
      case "appendix":
        appendixBlocks = { start: assignment.blockRange[0], end: assignment.blockRange[1] };
        break;
      case "acknowledgement":
        acknowledgementParagraphs.push(...textsIn(content, assignment.blockRange));
        break;
      case "abstract_zh": {
        const { keywords, withoutKeywordLine } = keywordsOf(textsIn(content, assignment.blockRange));
        abstractZhTexts.push(...withoutKeywordLine);
        keywordsZh = keywords;
        break;
      }
      case "abstract_en": {
        const { keywords, withoutKeywordLine } = keywordsOf(textsIn(content, assignment.blockRange));
        abstractEnTexts.push(...withoutKeywordLine);
        keywordsEn = keywords;
        break;
      }
      case "commitment":
      case "toc":
        break; // 模板固定部件，内容侧不参与
      default:
        if (node) chapters.push(...flattenLeafRanges(node));
        break;
    }
  }

  // 未匹配块（R5）：目前渲染器无法标记，先记进 notes，M4b 落到「未归类内容」章节
  for (const entry of plan.unmatched) {
    notes.push(`未匹配块 [${entry.blockRange[0]},${entry.blockRange[1]})：${entry.note}`);
  }
  notes.push(...plan.report.notes);
  if (chapters.length === 0) notes.push("映射未产出任何正文章节，输出将只有模板固定部件");

  const spec: ThesisBindingSpec = {
    title: titleHint,
    coverFields: { title: titleHint },
    abstractZh: abstractZhTexts.join("\n"),
    keywordsZh,
    abstractEn: abstractEnTexts.join("\n"),
    keywordsEn,
    chapters,
    references,
    appendixBlocks,
    acknowledgementParagraphs,
    // 研究成果（P-05「研究成果」）当前无自动来源：保持为空而不是编造
    achievements: [],
  };
  return { spec, notes };
}