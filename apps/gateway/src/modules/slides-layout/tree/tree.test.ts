import { describe, expect, it } from "vitest";
import { normalizeTree, type LayoutTree } from "./schema.js";
import { contractFromStyleParams } from "./layout-contract.js";
import { compileTree } from "./compile.js";
import { measureDefects, shrinkToFit } from "./measure.js";
import { auditSimilarity, treeSignature } from "./similarity.js";
import { jpegDimensions, pngDimensions, resolveImageAr, resolveImageArs } from "./aspect-ratio.js";
import { estimateLineHeight } from "../text-metrics.js";
import type { PageSpec } from "../elements.js";

const CONTRACT = contractFromStyleParams(null);

/** 测试端复刻墨迹估算（与 expand.test.ts 同口径）查文字两两不重叠。 */
interface InkBox { x: number; y: number; w: number; h: number }

function inkBoxes(spec: PageSpec): InkBox[] {
  const boxes: InkBox[] = [];
  for (const el of spec.elements) {
    if (el.type === "text" || (el.type === "shape" && el.paragraphs)) {
      const paragraphs = el.type === "text" ? el.paragraphs : el.paragraphs!;
      let contentH = 0;
      for (const p of paragraphs) {
        const size = Math.max(18, ...p.runs.map((r) => r.sizePt ?? 18));
        let textW = 0;
        for (const r of p.runs) {
          for (const ch of r.text) textW += (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1.35 : 0.7) * (r.sizePt ?? 18);
        }
        contentH += Math.max(1, Math.ceil(textW / Math.max(1, el.w))) * estimateLineHeight(size, p.lineSpacingPct);
      }
      const anchor = el.valign ?? (el.type === "shape" ? "middle" : "top");
      const top = anchor === "top" ? el.y : anchor === "bottom" ? el.y + el.h - contentH : el.y + (el.h - contentH) / 2;
      boxes.push({ x: el.x, y: top, w: el.w, h: contentH });
    }
  }
  return boxes;
}

function overlaps(a: InkBox, b: InkBox): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 6 && oy > 6;
}

function tree(raw: unknown): LayoutTree {
  return normalizeTree(raw);
}

describe("normalizeTree", () => {
  it("接受合法树并清洗可选字段", () => {
    const normalized = tree({
      role: "content",
      title: "页标题",
      direction: "row",
      weights: [2, 1],
      children: [
        { type: "text", variant: "body", text: "左侧要点一\n左侧要点二", bullet: true },
        { direction: "column", gapScale: 2, children: [{ type: "image", url: "https://example.com/a.jpg", contain: true }] },
      ],
    });
    expect(normalized.role).toBe("content");
    expect(normalized.children).toHaveLength(2);
    expect(normalized.gapScale).toBeUndefined();
  });

  it("既非叶子又非容器的节点报 LAYOUT_TREE_INVALID", () => {
    expect(() => tree({ direction: "row", children: [{ foo: 1 }] })).toThrow(/LAYOUT_TREE_INVALID/);
  });

  it("weights 数量与 children 不一致报错", () => {
    expect(() => tree({ direction: "row", weights: [1], children: [
      { type: "text", variant: "body", text: "a" },
      { type: "text", variant: "body", text: "b" },
    ] })).toThrow(/weights 长度（1）必须等于 children 数（2）/);
  });

  it("图片 url 只收 http(s) 或 everroom-material", () => {
    expect(() => tree({ direction: "row", children: [{ type: "image", url: "file:///etc/passwd" }] })).toThrow(/url 只接受/);
  });

  it("卡叶子缺 value 与 title 报错", () => {
    expect(() => tree({ direction: "row", children: [{ type: "card" }] })).toThrow(/必须有 value（KPI 卡）或 title（文字卡）/);
  });

  it("超过 12 个子节点报错", () => {
    const children = Array.from({ length: 13 }, () => ({ type: "text", variant: "caption", text: "x" }));
    expect(() => tree({ direction: "row", children })).toThrow(/最多 12 项/);
  });

  it("图表 series 与 categories 数量不一致报错", () => {
    expect(() => tree({ direction: "row", children: [{ type: "chart", kind: "bar", categories: ["a", "b"], series: [{ name: "s", values: [1] }] }] }))
      .toThrow(/必须等于 categories/);
  });

  it("节点预算拦截过碎的树", () => {
    const leaf = { type: "text", variant: "caption", text: "x" };
    let node: unknown = { direction: "column", children: [leaf] };
    for (let i = 0; i < 205; i++) node = { direction: "column", children: [node] };
    expect(() => tree(node)).toThrow(/节点总数超过/);
  });
});

/** 金标准树：role × density × 深嵌套。 */
const GOLDEN_TREES: Record<string, unknown> = {
  cover: {
    role: "cover", dark: true, direction: "column", gapScale: 2, children: [
      { type: "text", variant: "display", text: "中国茶文化出海战略", align: "center" },
      { type: "text", variant: "subtitle", text: "从品类到品牌的三年路线", align: "center", tone: "inverse" },
    ],
  },
  "content image-text": {
    role: "content", title: "冷萃工艺保留茶香本味", direction: "row", weights: [1.6, 1], children: [
      { type: "image", url: "https://example.com/craft.jpg" },
      { direction: "column", gapScale: 1.5, children: [
        { type: "text", variant: "heading", text: "四段低温萃取" },
        { type: "text", variant: "body", text: "全程 8℃ 以下冷萃 12 小时\n锁住茶氨酸与芳香物质", bullet: true },
      ] },
    ],
  },
  "data kpi": {
    role: "data", title: "茶饮市场的四个基本盘", direction: "column", children: [
      { direction: "row", weights: [1, 1, 1, 1], children: [
        { type: "card", value: "3,500", label: "全球市场规模（亿元）" },
        { type: "card", value: "31%", label: "年复合增长率" },
        { type: "card", value: "2.6倍", label: "冷萃品类增速" },
        { type: "card", value: "68%", label: "年轻客群占比" },
      ] },
      { type: "text", variant: "body", text: "数据来源：行业公开报告整理，2026 年 3 月。", tone: "muted" },
    ],
  },
  table: {
    role: "table", title: "三大产区的核心指标对照", direction: "row", children: [
      { type: "table", style: "lines", rows: [
        ["产区", "海拔", "年产量", "单价"],
        ["武夷山", "700m", "3200 吨", "260 元/kg"],
        ["黄山", "800m", "2800 吨", "210 元/kg"],
      ], colWidths: [1, 0.8, 1, 1] },
    ],
  },
  chart: {
    role: "data", title: "收入三年翻八倍", direction: "row", weights: [2, 1], children: [
      { type: "chart", kind: "comboBarLine", categories: ["2025", "2026", "2027", "2028"], series: [
        { name: "收入（万元）", values: [400, 1200, 3800, 9600] },
        { name: "增长率", values: [100, 200, 217, 153] },
      ] },
      { direction: "column", children: [
        { type: "card", title: "增速领跑", body: "三年复合增长率 217%" },
        { type: "card", title: "结构优化", body: "高毛利品类占比过半" },
      ] },
    ],
  },
  "deep nesting": {
    role: "content", title: "深嵌套与 pad/gap 组合", direction: "column", gapScale: 1.5, weights: [1, 3, 2], children: [
      { type: "text", variant: "subtitle", text: "上层要点" },
      { direction: "row", pad: 16, children: [
        { direction: "column", weights: [3, 2], children: [
          { type: "text", variant: "body", text: "左侧第一层\n左侧第二层", bullet: true },
          { type: "text", variant: "caption", text: "备注口径说明", tone: "muted" },
        ] },
        { type: "card", title: "侧栏卡", body: "嵌套三层后的卡" },
      ] },
      { direction: "row", gapScale: 2, children: [
        { type: "path", d: "M 0 0 L 100 0 L 50 80 Z" },
        { type: "text", variant: "caption", text: "路径装饰与说明文字并排", tone: "muted" },
      ] },
    ],
  },
  quote: {
    role: "quote", title: "一句话定调", direction: "column", pad: 32, children: [
      { type: "text", variant: "heading", text: "好产品是设计出来的，更是迭代出来的。", align: "center" },
      { type: "text", variant: "caption", text: "张三 · 创始人", align: "center", tone: "muted" },
    ],
  },
  closing: {
    role: "closing", dark: true, direction: "column", gapScale: 2, children: [
      { type: "text", variant: "display", text: "山泉茶事", align: "center" },
      { type: "text", variant: "subtitle", text: "一口东方茶，半日山水间", align: "center", tone: "inverse" },
    ],
  },
};

describe("compileTree 金标准", () => {
  for (const [name, raw] of Object.entries(GOLDEN_TREES)) {
    it(`${name} 编译满足结构不变量`, () => {
      const result = compileTree(tree(raw), CONTRACT);
      expect(result.defects).toEqual([]);
      expect(measureDefects(result, CONTRACT)).toEqual([]);
      expect(result.spec.elements.length).toBeGreaterThan(0);
      expect(result.spec.elements.length).toBeLessThanOrEqual(48);
      for (const el of result.spec.elements) {
        expect(Number.isFinite(el.x)).toBe(true);
        expect(Number.isFinite(el.y)).toBe(true);
        expect(Number.isFinite(el.w)).toBe(true);
        expect(Number.isFinite(el.h)).toBe(true);
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(1281);
        expect(el.y + el.h).toBeLessThanOrEqual(721);
      }
      const boxes = inkBoxes(result.spec);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
        }
      }
    });
  }

  it("深色页背景用 darkBackground，标题带在 titleBand", () => {
    const theme = contractFromStyleParams(null).theme;
    const cover = compileTree(tree(GOLDEN_TREES["cover"]), CONTRACT);
    expect(cover.spec.background).toBe(theme.colors.darkBackground);
    const content = compileTree(tree(GOLDEN_TREES["content image-text"]), CONTRACT);
    expect(content.spec.background).toBe(theme.colors.background);
    const title = content.spec.elements.find((el) => el.type === "text" && el.y < 100);
    expect(title).toBeDefined();
  });

  it("图片叶子一律显式 fit（cover/contain 都不缺省）", () => {
    const cover = compileTree(tree(GOLDEN_TREES["content image-text"]), CONTRACT);
    const image = cover.spec.elements.find((el) => el.type === "image");
    expect(image && image.type === "image" ? image.fit : undefined).toBe("cover");
  });
});

describe("measureDefects", () => {
  it("小权重子区域触发 min_size", () => {
    const result = compileTree(tree({
      direction: "row", weights: [20, 1], children: [
        { type: "text", variant: "body", text: "主体内容" },
        { type: "text", variant: "caption", text: "边" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "min_size" && d.path === "root/1")).toBe(true);
  });

  it("长文字小框触发 overflow 并带实测数字", () => {
    const result = compileTree(tree({
      direction: "column", children: [
        { type: "text", variant: "body", text: "很长的一段正文".repeat(300) },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && d.path === "root/0")).toBe(true);
  });

  it("contain 模式图框比例失配触发 image_ar", () => {
    const result = compileTree(tree({
      direction: "row", children: [
        { type: "image", url: "https://example.com/wide.jpg", contain: true },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT, { imageArs: new Map([["https://example.com/wide.jpg", 3.5]]) });
    expect(defects.some((d) => d.type === "image_ar" && d.path === "root/0")).toBe(true);
  });

  it("图数超上限触发 element_cap", () => {
    const children = Array.from({ length: 9 }, (_, i) => ({ type: "image", url: `https://example.com/${i}.jpg` }));
    const result = compileTree(tree({ direction: "row", children }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "element_cap" && /图片数 9/.test(d.detail))).toBe(true);
  });
});

describe("引擎硬闸镜像（真机 2026-10-15 第 4 页事故回归）", () => {
  it("KPI 卡装不下卡框时报缺陷，不再让墨迹溢出", () => {
    const result = compileTree(tree({
      role: "data", title: "茶经立典",
      direction: "column", weights: [0.6, 1.6], children: [
        { direction: "row", gapScale: 0.7, children: [
          { type: "card", value: "780", unit: "年", label: "《茶经》成书" },
          { type: "card", value: "3", unit: "卷", label: "全书十节 · 七千余言" },
          { type: "card", value: "28", unit: "种", label: "记录的茶具" },
        ] },
        { type: "text", variant: "body", text: "公元 780 年陆羽《茶经》成书，是世界第一部茶文化元典。" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /KPI 卡/.test(d.detail))).toBe(true);
  });

  it("文本含 emoji 报 emoji 缺陷", () => {
    const result = compileTree(tree({
      direction: "column", children: [
        { type: "text", variant: "body", text: "要点一 🎉 与要点二" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "emoji")).toBe(true);
  });

  it("编译产物文本墨迹两两重叠时报 overlap 缺陷", () => {
    const overlapResult = {
      spec: {
        elements: [
          { type: "text", x: 56, y: 259, w: 608, h: 65, paragraphs: [{ runs: [{ text: "很宽的两行正文内容", sizePt: 14 }] }] },
          { type: "text", x: 74, y: 259, w: 156, h: 32, paragraphs: [{ runs: [{ text: "卡标签", sizePt: 14 }] }] },
        ],
      },
      placements: [],
      defects: [],
      stats: { elements: 2, leaves: 0, depth: 0, images: 0, paths: 0 },
    };
    const defects = measureDefects(overlapResult as never, CONTRACT);
    expect(defects.some((d) => d.type === "overlap")).toBe(true);
  });
});

describe("shrinkToFit", () => {
  it("溢出文字降档后收敛并标记 degraded", () => {
    const t = tree({
      direction: "column", children: [
        { type: "text", variant: "body", text: "这是一段需要更多空间的正文内容，用来触发溢出然后验证降档收敛。".repeat(50) },
      ],
    });
    const shrunk = shrinkToFit(t, CONTRACT);
    expect(shrunk.degraded).toBe(true);
    expect(shrunk.defects.filter((d) => d.type === "overflow")).toEqual([]);
  });

  it("字号到下限仍装不下时报 font_floor 且不再降", () => {
    const t = tree({
      direction: "column", weights: [1, 6], children: [
        { type: "text", variant: "body", text: "这一段正文在小高度区域里无论怎么降字号都装不下。".repeat(10) },
        { type: "text", variant: "body", text: "占位" },
      ],
    });
    const shrunk = shrinkToFit(t, CONTRACT);
    expect(shrunk.defects.some((d) => d.type === "font_floor" && d.path === "root/0")).toBe(true);
  });
});

describe("similarity", () => {
  it("相邻同签名页被打回（取后一页）", () => {
    const a = tree({ role: "content", direction: "row", children: [
      { type: "text", variant: "body", text: "a" },
      { type: "text", variant: "body", text: "b" },
    ] });
    const b = tree({ role: "content", direction: "row", children: [
      { type: "text", variant: "body", text: "c" },
      { type: "text", variant: "body", text: "d" },
    ] });
    const c = tree({ role: "content", direction: "column", children: [
      { type: "text", variant: "body", text: "e" },
    ] });
    expect(treeSignature(a)).toBe(treeSignature(b));
    expect(treeSignature(a)).not.toBe(treeSignature(c));
    expect(auditSimilarity([a, b, c])).toEqual([1]);
    expect(auditSimilarity([a, c, b])).toEqual([]);
  });
});

describe("aspect-ratio", () => {
  it("png 头解析宽高", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(bytes.buffer).setUint32(16, 1792);
    new DataView(bytes.buffer).setUint32(20, 1024);
    expect(pngDimensions(bytes)).toEqual({ w: 1792, h: 1024 });
  });

  it("jpeg SOF 解析宽高", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
    new DataView(bytes.buffer).setUint16(7, 600);
    new DataView(bytes.buffer).setUint16(9, 800);
    expect(jpegDimensions(bytes)).toEqual({ w: 800, h: 600 });
  });

  it("resolveImageArs 只保留成功项", async () => {
    const deps = {
      readMaterialBlob: async (hash: string) => {
        if (hash === "a".repeat(64)) {
          const bytes = new Uint8Array(32);
          bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
          new DataView(bytes.buffer).setUint32(16, 1000);
          new DataView(bytes.buffer).setUint32(20, 500);
          return bytes;
        }
        return null;
      },
      fetchHead: async () => null,
    };
    const ar = await resolveImageAr(`everroom-material://${"a".repeat(64)}`, deps);
    expect(ar).toBe(2);
    const map = await resolveImageArs(["https://example.com/x.jpg"], deps);
    expect(map.size).toBe(0);
  });
});
