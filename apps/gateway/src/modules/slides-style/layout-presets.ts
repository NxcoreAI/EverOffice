/**
 * layout 技能预设词表的网关侧镜像。
 * 单一维护点在 agents/slides-builder/skills/layout-ppt-skill/（SKILL.md 与
 * layouts/*.md）；改预设清单或节奏上限时两处必须同步改。
 * 消费方：styler settle 的 layoutPresetIds 输入、generate 的版式节奏审计
 * （subagents/slides-layout-audit.ts）。
 */

/** layout 技能预设 id 形态（P1a / T3 / D2 / F6 / R1…）。 */
export const LAYOUT_ID_PATTERN = /^[PDTFR]\d[ab]?$/;

/** 按页角色分组的合法预设 id（layout-ppt-skill 各 layouts 文件的全集）。 */
export const LAYOUT_PRESET_IDS: Record<"cover" | "section" | "content" | "closing", string[]> = {
  cover: ["P1a", "P1b", "P1c"],
  section: ["P3"],
  content: [
    "P4", "P5", "P6", "P7", "P8",
    "T1", "T2", "T3", "T4", "T5", "T6", "T7",
    "D1", "D2", "D3", "D4", "D5",
    "F1", "F2", "F3", "F4", "F5", "F6",
    "R1", "R2", "R3", "R4",
  ],
  closing: ["P2", "P9"],
};

/**
 * 页序节奏硬上限——与 SKILL.md「页序节奏」一节同步维护。
 * 审计（slides-layout-audit.ts）按这些上限出 warning，不打回。
 */
export const RHYTHM_LIMITS = {
  /** R 系有机版式全篇上限。 */
  organicMax: 3,
  /** P3 深色章节页上限。 */
  darkSectionMax: 2,
  /** D3 全宽图表页上限。 */
  fullBleedChartMax: 2,
  /** P2+P9 大图页合计上限。 */
  bigImageMax: 3,
} as const;
