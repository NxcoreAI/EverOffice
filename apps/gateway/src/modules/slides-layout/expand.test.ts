import { describe, expect, it } from "vitest";
import { expandPresetPage, PRESET_EXPANDERS } from "./expand.js";
import { resolveTheme } from "./theme.js";
import { estimateLineHeight, estimateTextWidth } from "./text-metrics.js";
import type { PageSpec, SpecElement } from "./elements.js";

/** 27 个预设各一份代表性输入（字段按 layouts/*.md 文档给全）。 */
const SAMPLES: Record<string, unknown> = {
  "P1a": { eyebrow: "PROJECT PROPOSAL · 2026", title: "中国茶文化出海战略", subtitle: "从品类到品牌的三年路线", ghostText: "茶" },
  "P1b": { eyebrow: "2026 年度汇报", title: "增长复盘与来年计划", subtitle: "收入 · 效率 · 组织", band: "right" },
  "P1c": { eyebrow: "TEA HOUSE", title: "茶饮新纪元", subtitle: "2026 品牌升级方案" },
  "P2": { image: { url: "https://example.com/vision.jpg" }, claim: "让世界喝到东方茶", sub: "三年出海愿景" },
  "P3": { sectionNo: "02", title: "市场与机会", subtitle: "全球茶饮市场规模与趋势" },
  "P4": { heading: "目录", tagline: "三步走路线", items: ["市场洞察", "产品策略", "渠道打法", "财务预测", "团队与里程碑"] },
  "P5": { quote: "好产品是设计出来的，更是迭代出来的。", author: "张三", role: "创始人" },
  "P6": { title: "年轻消费者的三大痛点", image: { url: "https://example.com/tea.jpg" }, ratio: "62/38", cards: [
    { title: "选择困难", body: "货架上三十种茶不知怎么挑" },
    { title: "冲泡麻烦", body: "没有时间和器具做完整茶席" },
    { title: "品质不稳", body: "同品牌两次购买口感不一致" },
  ] },
  "P7": { title: "冷萃工艺保留茶香本味", image: { url: "https://example.com/craft.jpg" }, ratio: "50/50", heading: "四段低温萃取", body: "全程 8℃ 以下冷萃 12 小时，锁住茶氨酸与芳香物质。", bullets: ["8℃ 恒温冷萃", "12 小时慢提取", "无氧灌装锁鲜"] },
  "P8": { title: "核心团队", entries: [
    { period: "2019-2021", title: "连锁茶饮品牌主理人", body: "操盘 120 家门店" },
    { period: "2021-2023", title: "供应链负责人", body: "建立三大原产地直采" },
    { period: "2023-至今", title: "产品副总裁", body: "主导冷萃产品线" },
  ], highlight: { title: "从茶园到茶杯的完整履历", body: "团队覆盖种植、供应链、品牌与渠道全链路。" } },
  "P9": { logoText: "山泉茶事", slogan: "一口东方茶，半日山水间", contacts: [
    { icon: "envelope", text: "hello@teahouse.cn" },
    { icon: "phone", text: "400-800-9000" },
  ], image: { url: "https://example.com/closing.jpg" } },
  "T1": { title: "三大产区的核心指标对照", table: { rows: [
    ["产区", "海拔", "年产量", "单价"],
    ["武夷山", "700m", "3200 吨", "260 元/kg"],
    ["黄山", "800m", "2800 吨", "210 元/kg"],
    ["西双版纳", "1200m", "5100 吨", "180 元/kg"],
  ], colWidths: [1, 0.8, 1, 1], emphasisColumn: 2 } },
  "T2": { title: "与主要竞品的规格对比", table: { rows: [
    ["维度", "本方案", "竞品 A", "竞品 B"],
    ["萃取温度", "8℃ 冷萃", "常温", "60℃ 热萃"],
    ["茶汤浓度", "1.8×", "1.0×", "1.3×"],
  ] } },
  "T3": { title: "上市排期一览", table: { rows: [
    ["月份", "里程碑", "负责团队"],
    ["3 月", "配方定版", "产品"],
    ["4 月", "包装打样", "设计"],
    ["5 月", "首店试营业", "运营"],
    ["6 月", "全网首发", "增长"],
    ["7 月", "复购活动", "会员"],
    ["8 月", "出口首单", "海外"],
    ["9 月", "年度复盘", "全员"],
  ] } },
  "T4": { title: "融资用途的四项承诺", cards: [
    { icon: "bolt", title: "供应链升级", body: "三大原产地建冷库与初制厂，鲜叶损耗从 18% 降到 8%。" },
    { icon: "rocket-launch", title: "渠道扩张", body: "华东 200 家便利店冷柜位与抖快自播矩阵。" },
    { icon: "shield-check", title: "品牌资产", body: "产地纪录片与茶文化 IP 联名两季。" },
  ] },
  "T5": { title: "六维评分矩阵", table: { rows: [
    ["维度", "本方案", "竞品 A", "竞品 B"],
    ["风味", "★★★★★", "★★★☆☆", "★★★★☆"],
    ["性价比", "★★★★☆", "★★★★☆", "★★☆☆☆"],
    ["便利性", "✓", "✗", "✓"],
  ] } },
  "T6": { title: "三年财务预测（万元）", table: { rows: [
    ["科目", "2026", "2027", "2028"],
    ["收入", "1,200", "3,800", "9,600"],
    ["毛利", "520", "1,780", "4,700"],
    ["合计", "1,720", "5,580", "14,300"],
  ] } },
  "T7": { title: "自建冷链胜过三方托管", left: { name: "三方冷链", points: ["单件成本高 40%", "温控不可追溯", "旺季爆仓风险"] }, right: { name: "自建冷链", points: ["单件成本省 40%", "全程温控可视", "旺季运力自持"] }, winner: "right" },
  "D1": { title: "茶饮市场的四个基本盘", stats: [
    { value: "3,500", label: "全球市场规模（亿元）" },
    { value: "31%", label: "年复合增长率" },
    { value: "2.6倍", label: "冷萃品类增速" },
    { value: "68%", label: "年轻客群占比" },
  ] },
  "D2": { title: "冷萃是增速最快的品类", banner: { text: "一条主线：用冷萃抢占年轻客群", value: "+31%" }, stats: [
    { value: "31%", label: "品类年增速" },
    { value: "68%", label: "年轻客群占比" },
    { value: "2.6倍", label: "对传统茶增速倍数" },
  ] },
  "D3": { title: "收入三年翻八倍", chart: { chart: "comboBarLine", categories: ["2025", "2026", "2027", "2028"], series: [
    { name: "收入（万元）", values: [400, 1200, 3800, 9600] },
    { name: "增长率", values: [100, 200, 217, 153] },
  ] } },
  "D4": { title: "高质低价区间存在定位空白", chart: { chart: "scatter", categories: ["199", "299", "499", "899"], series: [{ name: "产品", values: [72, 88, 92, 95] }] }, cards: [
    { title: "定位空白", body: "300 元档 ×90 分段无强势玩家" },
    { title: "目标区间", body: "切入 299 元档做质价比第一" },
  ] },
  "D5": { title: "增长由复购驱动", chart: { chart: "line", categories: ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月"], series: [{ name: "复购率", values: [18, 22, 26, 31, 34, 39] }] }, cards: [
    { title: "复购率翻倍", body: "六个月从 18% 到 39%" },
    { title: "会员贡献过半", body: "会员订单占比 54%" },
  ] },
  "F1": { title: "从茶园到茶杯的四步打法", banner: "先锁供给，再做品牌", steps: [
    { name: "锁产地", desc: "三大原产地直采协议" },
    { name: "建工艺", desc: "四段冷萃产线落地" },
    { name: "打品牌", desc: "茶文化 IP 与自播" },
    { name: "拓渠道", desc: "便利店与出海首单" },
  ] },
  "F2": { title: "A 轮资金的三项用途", banner: { text: "1,200 万用在刀刃上", value: "1,200万" }, cards: [
    { title: "供应链", body: "原产地冷库与初制厂" },
    { title: "渠道", body: "华东 200 家便利店冷柜" },
    { title: "品牌", body: "产地纪录片与 IP 联名" },
  ] },
  "F3": { title: "从试营业到出海的里程碑", milestones: [
    { time: "2026 Q1", event: "配方定版与首店试营业", done: true },
    { time: "2026 Q2", event: "全网首发与复购活动", done: false },
    { time: "2026 Q3", event: "便利店渠道铺进 200 家", done: false },
    { time: "2026 Q4", event: "出口首单发往东南亚", done: false },
    { time: "2027 Q2", event: "第二产线投产", done: false },
  ] },
  "F4": { title: "三阶段路线：当前在产能爬坡", stages: [
    { name: "验证期", deliverables: ["配方定版", "首店模型"], status: "done" },
    { name: "爬坡期", deliverables: ["产线投产", "200 家冷柜"], status: "current" },
    { name: "复制期", deliverables: ["出海首单", "第二产线"], status: "future" },
  ] },
  "F5": { title: "供应链的四层体系", layers: [
    { name: "用户层", modules: ["小程序", "会员体系"] },
    { name: "品牌层", modules: ["内容 IP", "自播矩阵", "联名"] },
    { name: "供应链层", modules: ["直采", "冷萃产线", "冷库", "冷链"] },
    { name: "数据层", modules: ["溯源", "销售看板"] },
  ] },
  "F6": { title: "一年走过的四个节点", milestones: [
    { time: "2025-03", event: "团队组建完成" },
    { time: "2025-07", event: "首店模型跑通" },
    { time: "2025-11", event: "产线正式投产" },
    { time: "2026-03", event: "便利店渠道铺开" },
  ], side: { title: "一年从 0 到 1", body: "四季度完成团队、模型、产能、渠道四步跨越。" } },
  "R1": { title: "一核心三支点的茶生态", center: "茶生态", satellites: [
    { name: "原产地", desc: "三大直采" },
    { name: "冷萃工艺", desc: "四段萃取" },
    { name: "品牌 IP", desc: "内容联名" },
    { name: "渠道网络", desc: "便利店" },
    { name: "会员体系", desc: "复购引擎" },
    { name: "数据中台", desc: "溯源看板" },
  ] },
  "R2": { title: "供给与品牌的增长飞轮", nodes: [
    { name: "锁产地", desc: "直采降本" },
    { name: "稳品质", desc: "工艺标准化" },
    { name: "树品牌", desc: "IP 内容" },
    { name: "扩渠道", desc: "冷柜网络" },
    { name: "攒会员", desc: "复购数据" },
  ], ghostWord: "飞轮" },
  "R3": { title: "三个卖点撑起一个品牌", skeleton: "A", focus: { value: "2.6倍", label: "冷萃品类增速" }, cards: [
    { title: "8℃ 冷萃", body: "四段低温萃取锁住茶氨酸" },
    { title: "产地直采", body: "三大原产地鲜叶 24 小时到厂" },
    { title: "0 添加", body: "配料表只有茶与水" },
  ] },
  "R4": { claim: "从卖原料到卖品牌", mode: "compare", left: { name: "过去", points: ["散茶原料出口", "无定价权", "利润率 8%"] }, right: { name: "现在", points: ["品牌成品出海", "自主定价", "利润率 31%"] }, winner: "right" },
};

/** 预设 ids 与 layout-presets 词表一致。 */
const EXPECTED_IDS = [
  "P1a", "P1b", "P1c", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9",
  "T1", "T2", "T3", "T4", "T5", "T6", "T7",
  "D1", "D2", "D3", "D4", "D5",
  "F1", "F2", "F3", "F4", "F5", "F6",
  "R1", "R2", "R3", "R4",
];

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

interface InkBox { x: number; y: number; w: number; h: number; label: string }

/** 与引擎 estimateTextInk 同口径的测试端墨迹框（文本与带字形状）。 */
function inkBoxes(spec: PageSpec): InkBox[] {
  const boxes: InkBox[] = [];
  for (const el of spec.elements) {
    if (el.type === "text" || (el.type === "shape" && el.paragraphs)) {
      const paragraphs = el.type === "text" ? el.paragraphs : el.paragraphs!;
      let contentH = 0;
      let label = "";
      for (const p of paragraphs) {
        const size = Math.max(18, ...p.runs.map((r) => r.sizePt ?? 18));
        let textW = 0;
        for (const r of p.runs) {
          label += r.text;
          for (const ch of r.text) textW += (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1.35 : 0.7) * (r.sizePt ?? 18);
        }
        const lineH = estimateLineHeight(size, p.lineSpacingPct);
        contentH += Math.max(1, Math.ceil(textW / Math.max(1, el.w))) * lineH;
      }
      const anchor = el.valign ?? (el.type === "shape" ? "middle" : "top");
      const top = anchor === "top" ? el.y : anchor === "bottom" ? el.y + el.h - contentH : el.y + (el.h - contentH) / 2;
      boxes.push({ x: el.x, y: top, w: el.w, h: contentH, label: label.slice(0, 16) });
    }
  }
  return boxes;
}

function overlaps(a: InkBox, b: InkBox): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 6 && oy > 6;
}

/** 底边要求撑满内容区的预设（封面/章节/引用/封底/履历与居中型节点页除外）。 */
const BOTTOM_FILL_IDS = new Set(["P4", "P6", "P7", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "D1", "D2", "D3", "D4", "D5", "F2", "F4", "F5", "F6", "R1", "R2", "R3", "R4"]);

describe("expandPresetPage 全预设不变量", () => {
  it("预设清单覆盖 27 个 id 且无多余", () => {
    expect(Object.keys(PRESET_EXPANDERS).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  for (const id of EXPECTED_IDS) {
    it(`${id} 展开满足结构不变量`, () => {
      const spec = expandPresetPage({ id, ...SAMPLES[id] as object });
      expect(spec.elements.length).toBeGreaterThan(0);
      expect(spec.elements.length).toBeLessThanOrEqual(48);
      for (const el of spec.elements) {
        for (const key of ["x", "y", "w", "h"] as const) {
          expect(Number.isFinite((el as unknown as Record<string, number>)[key])).toBe(true);
        }
      }
      const boxes = inkBoxes(spec);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
        }
      }
      if (BOTTOM_FILL_IDS.has(id)) {
        const bottom = Math.max(...spec.elements.map((el) => (el as SpecElement & { y: number; h: number }).y + (el as SpecElement & { y: number; h: number }).h));
        expect(bottom).toBeGreaterThanOrEqual(676);
      }
      const json = JSON.stringify(spec);
      expect(json.length).toBeLessThan(78_000);
      expect(spec.background ?? "").toMatch(HEX);
      for (const color of json.match(/#[0-9a-fA-F]{6,8}/g) ?? []) {
        expect(color).toMatch(HEX);
      }
    });
  }
});

describe("expandPresetPage 主题与定制", () => {
  it("styleParams 的 margin/gutter 生效（内容区 x=margin）", () => {
    const spec = expandPresetPage(
      { id: "T1", title: "标题", table: { rows: [["A", "B"], ["1", "2"]] } },
      { palette: { background: "#FFFFFF", primary: "#123456" }, spacing: { margin: 80, gutter: 24 } },
    );
    const table = spec.elements.find((el) => el.type === "table");
    expect(table).toBeDefined();
    expect((table as { x: number }).x).toBe(80);
    expect((table as { w: number }).w).toBe(1280 - 160);
  });

  it("调色板色号透传到元素", () => {
    const spec = expandPresetPage(
      { id: "D1", title: "标题", stats: [{ value: "31%", label: "增速" }, { value: "68%", label: "年轻客群" }] },
      { palette: { background: "#101010", primary: "#AB34F0" } },
    );
    const json = JSON.stringify(spec).toLowerCase();
    expect(json).toContain("#ab34f0");
    expect(json).toContain("#101010");
  });

  it("T2 深表头用深底色 + 白字", () => {
    const theme = resolveTheme();
    const spec = expandPresetPage({ id: "T2", title: "标题", table: { rows: [["A", "B"], ["1", "2"]] } });
    const table = spec.elements.find((el) => el.type === "table") as { rows: { fill?: string; color?: string }[][] };
    expect(table.rows[0]![0]!.fill).toBe(theme.colors.darkBackground);
    expect(table.rows[0]![0]!.color).toBe(theme.colors.onDarkText);
  });

  it("页标题过长报错并给字数上限", () => {
    const long = "这是一条特别特别长特别特别长特别特别长特别特别长特别特别长特别特别长特别特别长特别特别长特别特别长的行动标题";
    expect(() => expandPresetPage({ id: "T1", title: long, table: { rows: [["A", "B"], ["1", "2"]] } }))
      .toThrow(/标题过长/);
  });

  it("未知 id 报错并列出合法 id", () => {
    expect(() => expandPresetPage({ id: "X9" })).toThrow(/未知预设/);
  });

  it("F2 五张卡报错（无法等分）", () => {
    const cards = [1, 2, 3, 4, 5].map((i) => ({ title: `卡${i}`, body: "说明" }));
    expect(() => expandPresetPage({ id: "F2", title: "标题", banner: { text: "主张" }, cards })).toThrow(/3、4 或 6/);
  });

  it("图表系列值数量不一致报错", () => {
    expect(() => expandPresetPage({
      id: "D3", title: "标题",
      chart: { chart: "line", categories: ["a", "b", "c"], series: [{ name: "s", values: [1, 2] }] },
    })).toThrow(/values 数量/);
  });

  it("表格行高预算超限报错", () => {
    const rows = [["列A", "列B"], ...Array.from({ length: 12 }, (_, i) => [`第 ${i} 行 这是一个比较长的单元格内容用来撑高行预算`, "值"])];
    expect(() => expandPresetPage({ id: "T1", title: "标题", table: { rows } })).toThrow(/行高预算|超过 12 行|至少 2 行/);
  });

  it("P6 图片 url 非法报错", () => {
    expect(() => expandPresetPage({
      id: "P6", title: "标题", image: { url: "file:///etc/passwd" },
      cards: [{ title: "a", body: "b" }, { title: "c", body: "d" }, { title: "e", body: "f" }],
    })).toThrow(/http\(s\)|素材引用/);
  });

  it("数字格超宽自动降字号而不是报错", () => {
    const spec = expandPresetPage({ id: "D1", title: "标题", stats: [
      { value: "1,234,567,890", label: "很长很长很长很长很长很长的标签文字用来折行" },
      { value: "31%", label: "增速" },
    ] });
    expect(spec.elements.some((el) => el.type === "text")).toBe(true);
    const value = spec.elements.find((el) => el.type === "text") as { paragraphs: { runs: { sizePt?: number }[] }[] };
    expect(value.paragraphs[0]!.runs[0]!.sizePt!).toBeLessThanOrEqual(90);
  });

  it("估算器与引擎系数一致（CJK 1.35 / 拉丁 0.7 / 行高 1.8）", () => {
    expect(estimateTextWidth("中", 20)).toBeCloseTo(27);
    expect(estimateTextWidth("a", 20)).toBeCloseTo(14);
    expect(estimateLineHeight(20)).toBeCloseTo(36);
  });
});
