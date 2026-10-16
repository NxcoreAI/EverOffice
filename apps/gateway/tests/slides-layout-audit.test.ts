import { describe, expect, it } from "vitest";
import { auditPageLayouts } from "../src/modules/subagents/slides-layout-audit.js";

describe("auditPageLayouts 版式节奏审计", () => {
  it("无 pageLayouts（null/undefined/空数组）时静默跳过，旧路径零影响", () => {
    expect(auditPageLayouts(null, 3)).toEqual([]);
    expect(auditPageLayouts(undefined, 3)).toEqual([]);
    expect(auditPageLayouts([], 3)).toEqual([]);
  });

  it("含非字符串项时只报一项并跳过其余规则", () => {
    const warnings = auditPageLayouts(["P1a", 3, "T1"], null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("非字符串");
  });

  it("词表外 id 报 warning", () => {
    const warnings = auditPageLayouts(["P1a", "X9", "Z1"], null);
    const text = warnings.join("\n");
    expect(text).toContain("不在词表内");
    expect(text).toContain("X9");
  });

  it("与成稿页数不符报 warning", () => {
    const warnings = auditPageLayouts(["P1a", "T1"], 3);
    expect(warnings.join("\n")).toContain("与成稿 3 页不符");
  });

  it("相邻页同版式报 warning（含三连区间）", () => {
    const warnings = auditPageLayouts(["P1a", "T1", "T1", "D1", "D1", "D1"], null);
    const text = warnings.join("\n");
    expect(text).toContain("第2~3页连续 T1");
    expect(text).toContain("第4~6页连续 D1");
  });

  it("节奏合规时零 warning", () => {
    const warnings = auditPageLayouts(["P1a", "P4", "T1", "D1", "F1", "R1", "P3", "P9"], 8);
    expect(warnings).toEqual([]);
  });

  it("R 系超过全篇上限报 warning", () => {
    const warnings = auditPageLayouts(["R1", "R2", "R3", "R4"], 4);
    expect(warnings.join("\n")).toContain("R 系有机版式 4 页，超过上限 3");
  });

  it("P3/D3/P2+P9 各自超上限报 warning", () => {
    expect(auditPageLayouts(["P3", "P3", "P3"], 3).join("\n")).toContain("P3 深色章节页 3 页，超过上限 2");
    expect(auditPageLayouts(["D3", "D3", "D3"], 3).join("\n")).toContain("D3 全宽图表页 3 页，超过上限 2");
    expect(auditPageLayouts(["P2", "P9", "P2", "P9"], 4).join("\n")).toContain("P2/P9 大图页合计 4 页，超过上限 3");
  });
});
