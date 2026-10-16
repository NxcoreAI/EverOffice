/**
 * 预设展开入口：把模型给的 {id, …字段} 展开成完整 PageSpec。
 * 模型只选预设、填内容；坐标/字号/配色/间距全部在这里确定性计算。
 */

import { resolveTheme, type StyleParamsInput } from "./theme.js";
import { makeContext } from "./preset-common.js";
import type { PageSpec, SpecElement } from "./elements.js";
import { asObject } from "./parse.js";
import { TEXT_MEDIA_PRESETS } from "./presets/text-media.js";
import { TABLE_PRESETS } from "./presets/tables.js";
import { DATA_PRESETS } from "./presets/data.js";
import { FLOW_PRESETS } from "./presets/flows.js";
import { ORGANIC_PRESETS } from "./presets/organic.js";

type PresetExpander = (input: Record<string, unknown>, ctx: ReturnType<typeof makeContext>) => PageSpec;

export const PRESET_EXPANDERS: Record<string, PresetExpander> = {
  ...TEXT_MEDIA_PRESETS,
  ...TABLE_PRESETS,
  ...DATA_PRESETS,
  ...FLOW_PRESETS,
  ...ORGANIC_PRESETS,
};

export function isPresetId(id: string): boolean {
  return id in PRESET_EXPANDERS;
}

const MAX_ELEMENTS = 48;
const MAX_SPEC_JSON_LENGTH = 78_000;

/**
 * 展开：preset 为 {id, ...字段}；styleParams 可空（用缺省主题）。
 * 抛出的 PRESET_INVALID / 依赖的校验错误会由 set_page 原样回传给模型自行修正。
 */
export function expandPresetPage(preset: unknown, styleParams?: StyleParamsInput | null): PageSpec {
  const input = asObject(preset, "preset");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const expander = PRESET_EXPANDERS[id];
  if (!expander) {
    const known = Object.keys(PRESET_EXPANDERS).join(" ");
    throw new Error(`PRESET_INVALID: 未知预设 id「${id || "(缺失)"}」。合法 id：${known}`);
  }
  const theme = resolveTheme(styleParams);
  const spec = expander(input, makeContext(theme));
  if (spec.elements.length === 0) throw new Error(`PRESET_INVALID: 预设 ${id} 展开结果为空`);
  if (spec.elements.length > MAX_ELEMENTS) {
    throw new Error(`PRESET_INVALID: 预设 ${id} 展开出 ${spec.elements.length} 个元素（上限 ${MAX_ELEMENTS}）——减少条目`);
  }
  for (const element of spec.elements) {
    assertBoxed(element);
  }
  const json = JSON.stringify(spec);
  if (json.length > MAX_SPEC_JSON_LENGTH) {
    throw new Error(`PRESET_INVALID: 预设 ${id} 展开结果超长（${json.length} 字符）——精简文字或数据`);
  }
  return spec;
}

function assertBoxed(element: SpecElement): void {
  for (const key of ["x", "y", "w", "h"] as const) {
    const value = (element as unknown as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`PRESET_INVALID: 展开结果元素缺 ${key}——这是内部错误，请回报`);
    }
  }
}
