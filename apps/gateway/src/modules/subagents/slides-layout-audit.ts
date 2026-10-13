/**
 * 版式节奏审计：对 builder 提交的 pageLayouts（每页版式预设 id，按页序）
 * 做确定性检查——配色有 sanitizePaletteRelations 修复闸，版式的对应物是
 * 这道审计闸。只出 warning 不打回：版式坐标已落页，审计是信号不是修复层。
 *
 * 规则与 layout-ppt-skill/SKILL.md「页序节奏」一节同源
 * （上限常量在 slides-style/layout-presets.ts 的 RHYTHM_LIMITS）。
 * 无 pageLayouts（旧 builder、edit 路径）时静默跳过，旧链路零影响。
 */

import { LAYOUT_ID_PATTERN, RHYTHM_LIMITS } from "../slides-style/layout-presets.js";

const PREFIX = "版式节奏：";

export function auditPageLayouts(pageLayouts: unknown, pageCount: number | null): string[] {
  if (!Array.isArray(pageLayouts) || pageLayouts.length === 0) return [];
  if (pageLayouts.some((id) => typeof id !== "string")) {
    return [`${PREFIX}pageLayouts 含非字符串项，跳过节奏审计`];
  }
  const ids = pageLayouts as string[];
  const warnings: string[] = [];

  const unknown = ids.filter((id) => !LAYOUT_ID_PATTERN.test(id));
  if (unknown.length > 0) {
    const sample = [...new Set(unknown)].slice(0, 5).join("、");
    warnings.push(`${PREFIX}${String(unknown.length)} 处版式 id 不在词表内（${sample}${unknown.length > 5 ? " 等" : ""}）`);
  }

  if (pageCount !== null && ids.length !== pageCount) {
    warnings.push(`${PREFIX}pageLayouts 共 ${String(ids.length)} 项，与成稿 ${String(pageCount)} 页不符`);
  }

  const repeats: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= ids.length; i += 1) {
    if (ids[i] !== ids[runStart]) {
      if (i - runStart >= 2) repeats.push(`第${String(runStart + 1)}~${String(i)}页连续 ${ids[runStart]}`);
      runStart = i;
    }
  }
  if (repeats.length > 0) {
    warnings.push(`${PREFIX}相邻页版式重复（${repeats.slice(0, 4).join("；")}${repeats.length > 4 ? " 等" : ""}）`);
  }

  const count = (id: string): number => ids.filter((item) => item === id).length;
  const organic = ids.filter((item) => item.startsWith("R")).length;
  if (organic > RHYTHM_LIMITS.organicMax) {
    warnings.push(`${PREFIX}R 系有机版式 ${String(organic)} 页，超过上限 ${String(RHYTHM_LIMITS.organicMax)}`);
  }
  const checks: Array<[string, number, string]> = [
    ["P3", RHYTHM_LIMITS.darkSectionMax, "P3 深色章节页"],
    ["D3", RHYTHM_LIMITS.fullBleedChartMax, "D3 全宽图表页"],
  ];
  for (const [id, max, label] of checks) {
    const uses = count(id);
    if (uses > max) warnings.push(`${PREFIX}${label} ${String(uses)} 页，超过上限 ${String(max)}`);
  }
  const bigImage = count("P2") + count("P9");
  if (bigImage > RHYTHM_LIMITS.bigImageMax) {
    warnings.push(`${PREFIX}P2/P9 大图页合计 ${String(bigImage)} 页，超过上限 ${String(RHYTHM_LIMITS.bigImageMax)}`);
  }
  return warnings;
}
