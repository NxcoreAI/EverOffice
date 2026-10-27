import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { ThesisFormatCardStore } from "../src/modules/thesis-format/card-store.js";
import { validateThesisFormatCard } from "../src/modules/thesis-format/validate.js";
import { extractOoxmlFactsAsync } from "../src/modules/thesis-format/ooxml-facts.js";
import { cardForAgent, factsForAgent, mergeTemplateImages } from "../src/modules/thesis-format/service.js";
import { buildTemplateProfile } from "../src/modules/thesis-format/template-profile.js";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const logger = { info: () => undefined, warn: () => undefined };

/** 仓库 agents/ 目录的 thesis-formatter 包必须能被注册器完整加载（守卫 agent.yaml/schema 改坏）。 */
describe("thesis-formatter agent bundle", () => {
  it("loads from the repository agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-agents-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const registry = new SubagentRegistry(database.db, {
        enabled: true,
        definitionsDir: resolve(join(process.cwd(), "..", "..", "agents")),
        runtimeDir: join(root, "runtime"),
        defaultTimeoutMs: 30_000,
        maxConcurrent: 4,
      }, { search: { url: "https://mcp.example.test", headers: { Authorization: "test-secret" } } }, logger);
      await registry.initialize();
      const definition = registry.get("thesis-formatter");
      expect(definition).toBeTruthy();
      expect(definition?.revision.inputSchema).toBeTruthy();
      expect(definition?.revision.outputSchema).toBeTruthy();
      expect(definition?.revision.policy.allowedCallers).toContain("internal-workflow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ThesisFormatCardStore (multi-card)", () => {
  it("upserts per (room, sourceName), lists, resolves by id and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-cards-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.zip");
      const a1 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: null, sourceName: "A.docx" });
      const b1 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: null, sourceName: "B.docx" });
      const a2 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: "entry-1", sourceName: "A.docx" });
      expect(a2.id).toBe(a1.id);
      expect(store.list("r1")).toHaveLength(2);
      expect(store.latest("r1")?.id).toBe(a2.id);
      expect(store.byId("r1", b1.id)?.sourceName).toBe("B.docx");
      expect(store.remove("r1", b1.id)).toBe(true);
      expect(store.remove("r1", b1.id)).toBe(false);
      expect(store.list("r1")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateThesisFormatCard", () => {
  it("fills Chinese thesis defaults for an empty card", () => {
    const card = validateThesisFormatCard({}, "模版.zip");
    expect(card.page.marginTopMm).toBe(25);
    expect(card.base.font.eastAsia).toBe("宋体");
    expect(card.base.font.size).toBe(12);
    expect(card.base.paragraph.lineSpacingMultiple).toBe(1.25);
    expect(card.footer.frontMatterFormat).toBe("roman");
    expect(card.parts.map((part) => part.type)).toEqual([
      "cover", "commitment", "abstract_zh", "abstract_en", "toc",
      "chapter", "appendix", "references", "acknowledgement", "achievements",
    ]);
  });

  it("resolves Chinese size names to pt and keeps explicit values", () => {
    const card = validateThesisFormatCard({
      headings: [{ level: 1, font: { eastAsia: "黑体", ascii: "Times New Roman", size: "小二", bold: true } }],
      page: { marginTopMm: 30 },
    }, "模版.docx");
    expect(card.headings[0]?.font.size).toBe(18);
    expect(card.page.marginTopMm).toBe(30);
  });

  it("rejects invalid size values", () => {
    expect(() => validateThesisFormatCard({ base: { font: { size: "十七号" } } }, "模版.docx"))
      .toThrow(/字号非法/);
  });
});

/** 1x1 PNG (base64), header logo extraction fixture. */
const LOGO_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** docx fixture with a header logo: header1.xml embeds an anchor drawing + media/rels. */
async function docxWithHeaderLogo(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
  );
  const headerXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<w:p><w:r><w:drawing>',
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">',
    '<wp:simplePos x="0" y="0"/>',
    '<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>',
    '<wp:positionV relativeFrom="margin"><wp:align>top</wp:align></wp:positionV>',
    '<wp:extent cx="381000" cy="381000"/><wp:wrapNone/><wp:docPr id="1" name="logo"/>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic>',
    '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p></w:hdr>',
  ].join('');
  zip.file("word/header1.xml", headerXml);
  zip.file(
    "word/_rels/header1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>',
  );
  zip.file("word/media/logo.png", Buffer.from(LOGO_PNG_BASE64, "base64"));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("ooxml-facts header images", () => {
  it("extracts header image bytes and placement facts", async () => {
    const bytes = await docxWithHeaderLogo();
    const facts = await extractOoxmlFactsAsync(bytes);
    expect(facts.headers).toHaveLength(1);
    const headerFacts = facts.headers[0]!;
    expect(headerFacts.images).toHaveLength(1);
    const image = headerFacts.images[0]!;
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(image.floating).toBe(true);
    expect(image.posH).toBe("center");
    expect(image.posV).toBe("top");
    expect(image.widthPx).toBe(40);
  });
});

describe("validateThesisFormatCard header images", () => {
  it("keeps valid image facts and drops dirty entries", () => {
    const card = validateThesisFormatCard(
      {
        header: {
          enabled: true,
          images: [
            { dataUrl: "data:image/png;base64," + LOGO_PNG_BASE64, widthPx: 40, heightPx: 40, floating: true, posH: "center", posVRel: "margin" },
            { dataUrl: "javascript:alert(1)" },
            "not-an-object",
          ],
        },
      },
      "template.docx",
    );
    const images = card.header.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(images[0]!.widthPx).toBe(40);
  });

  it("gives an empty array when images are absent (no fabrication)", () => {
    const card = validateThesisFormatCard({ header: { enabled: true } }, "template.docx");
    expect(card.header.images ?? []).toEqual([]);
  });
});

/** 封面带校徽的模版：logo 在正文首个分节之前的居中段落里（不在页眉）。 */
async function docxWithCoverLogo(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
  );
  const document = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>',
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="114300" distR="114300">',
    '<wp:extent cx="5958840" cy="850265"/><wp:docPr id="2" name="图片 1" descr="学校常用标识2"/>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic>',
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    '<w:p><w:r><w:t>通信工程学院</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>',
    '<w:p><w:r><w:t>正文</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');
  zip.file("word/document.xml", document);
  zip.file("word/media/image1.png", Buffer.from(LOGO_PNG_BASE64, "base64"));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("封面 logo 提取与确定性写入", () => {
  it("抽出封面的校徽及其尺寸/居中事实", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    expect(facts.coverImages).toHaveLength(1);
    const logo = facts.coverImages[0]!;
    expect(logo.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(logo.widthPx).toBe(626);
    expect(logo.heightPx).toBe(89);
    expect(logo.posH).toBe("center");
    // 正文分节之后的插图不算封面元素
    expect(facts.coverImages).toHaveLength(1);
  });

  it("封面图写进 card.cover.logo，且不覆盖代理已给的值", async () => {
    const facts = {
      ooxml: [{
        name: "模版.docx",
        styles: [],
        sections: [],
        headers: [{ file: "header1.xml", text: "", images: [] }],
        footers: [],
        coverImages: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" as const }],
      }],
      documentsText: [],
    };
    const base = validateThesisFormatCard({ cover: { schoolName: "通信工程学院" } }, "模版.docx");
    const merged = mergeTemplateImages(base, facts);
    expect(merged.cover.logo?.widthPx).toBe(626);
    expect(merged.cover.logo?.posH).toBe("center");

    const kept = mergeTemplateImages(
      { ...base, cover: { ...base.cover, logo: { dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 10 } } },
      facts,
    );
    expect(kept.cover.logo?.widthPx).toBe(10);
  });

  it("facts 里没有图片时不写字段（绝不编造 logo）", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "某学院" } }, "模版.docx");
    const merged = mergeTemplateImages(base, { ooxml: [], documentsText: [] });
    expect(merged.cover.logo).toBeUndefined();
    expect(merged.header.images ?? []).toEqual([]);
  });

  it("非法 data:URL 的封面图被丢弃", () => {
    const card = validateThesisFormatCard({ cover: { logo: { dataUrl: "javascript:alert(1)" } } }, "模版.docx");
    expect(card.cover.logo).toBeUndefined();
  });
});

describe("封面文字兜底（coverText）", () => {
  const factsWithCover = (coverText: string[]) => ({
    ooxml: [{ name: "模版.docx", styles: [], sections: [], headers: [], footers: [], coverText }],
    documentsText: [],
  });

  it("代理留空时用封面文本补齐校名/文种/学年", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "" } }, "模版.docx");
    expect(base.cover.degreeLine).toBe("本科毕业论文（设计）"); // 校验层兜底值
    const merged = mergeTemplateImages(base, factsWithCover([
      "通信工程学院", "《人工智能创新创业实践》", "课程考核报告", "2026-2027学年第一学期",
    ]));
    expect(merged.cover.schoolName).toBe("通信工程学院");
    expect(merged.cover.degreeLine).toBe("课程考核报告");
    expect(merged.cover.yearLine).toBe("2026-2027学年第一学期");
  });

  it("代理已给出的封面字段不被覆盖", () => {
    const base = validateThesisFormatCard(
      { cover: { schoolName: "嘉应学院", degreeLine: "本科毕业论文（设计）" } },
      "模版.docx",
    );
    const merged = mergeTemplateImages(base, factsWithCover(["通信工程学院", "课程考核报告"]));
    expect(merged.cover.schoolName).toBe("嘉应学院");
  });

  it("coverText 为空时保持原样（不编造）", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "" } }, "模版.docx");
    const merged = mergeTemplateImages(base, factsWithCover([]));
    expect(merged.cover.schoolName).toBe("");
    expect(merged.cover.yearLine).toBe("");
  });
});

describe("factsForAgent 剥离图片字节", () => {
  it("代理输入里没有任何 data:URL，但保留尺寸与版位元信息", () => {
    const facts = {
      ooxml: [{
        name: "模版.docx",
        styles: [],
        sections: [],
        headers: [{ file: "header1.xml", text: "", images: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 40, heightPx: 40 }] }],
        footers: [],
        coverImages: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" as const }],
        coverText: ["通信工程学院"],
      }],
      documentsText: [{ name: "模版.docx", text: "正文" }],
    };
    const forAgent = factsForAgent(facts) as { ooxml: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(forAgent);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain(LOGO_PNG_BASE64);
    const member = forAgent.ooxml[0]!;
    expect((member.coverImages as Array<Record<string, unknown>>)[0]).toMatchObject({ hasBytes: true, widthPx: 626, posH: "center" });
    expect(member.coverText).toEqual(["通信工程学院"]);
    expect(member.styles).toEqual([]);
  });
});

describe("cardForAgent 剥离卡片里的图片字节", () => {
  it("封面 logo 与页眉图只留元信息，别处字段原样", () => {
    const card = validateThesisFormatCard({
      cover: { schoolName: "广州城市理工学院", logo: { dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" } },
      header: { enabled: true, images: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 40, heightPx: 40 }] },
    }, "模版.docx");
    const forAgent = cardForAgent(card) as { cover: Record<string, unknown>; header: Record<string, unknown> };
    const serialized = JSON.stringify(forAgent);
    expect(serialized).not.toContain("data:image");
    expect(forAgent.cover.schoolName).toBe("广州城市理工学院");
    expect(forAgent.cover.logo).toMatchObject({ hasBytes: true, widthPx: 626, posH: "center" });
    expect((forAgent.header.images as Array<Record<string, unknown>>)[0]).toMatchObject({ widthPx: 40 });
    // 原卡不受影响（回填仍用带字节的版本）
    expect(card.cover.logo?.dataUrl).toContain("data:image/png");
  });
});

/** 带章节骨架 + 中文编号的模板：验证 outline/numbering 抽取。 */
async function docxWithOutline(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '</w:styles>',
  );
  zip.file(
    "word/numbering.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:abstractNum w:abstractNumId="7">'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/><w:pPr><w:ind w:firstLine="420"/></w:pPr></w:lvl>'
    + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>'
    + '</w:abstractNum>'
    + '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>'
    + '</w:numbering>',
  );
  const paragraph = (styleId: string, text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraph("a", "封面标题")
    + '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>'
    + paragraph("1", "一、项目任务")
    + paragraph("2", "1.1 背景")
    + paragraph("a", "正文段落")
    + paragraph("1", "二、项目需求分析")
    + paragraph("a", "参考资料")
    + paragraph("1", "参考资料")
    + '</w:body></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("模板正文大纲与编号方案（M1 模板剖面）", () => {
  it("抽出章节骨架：层级、文本、封面区标记", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const outline = facts.outline;
    expect(outline.map((entry) => `${entry.level}:${entry.text}`)).toEqual([
      "1:一、项目任务",
      "2:1.1 背景",
      "1:二、项目需求分析",
      "1:参考资料",
    ]);
    expect(outline[0]!.styleId).toBe("1");
    expect(outline.every((entry) => entry.inCoverRegion === false)).toBe(true);
  });

  it("识别中文一级编号方案", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    expect(facts.numbering.scheme).toBe("cn-upper");
    expect(facts.numbering.headingNumId).toBe(3);
    expect(facts.numbering.levels[0]).toMatchObject({ level: 1, numFmt: "chineseCounting", lvlText: "%1、", start: 1 });
  });

  it("无 numbering.xml 时 scheme = none（不编造）", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    zip.file(
      "word/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>一、项目任务</w:t></w:r></w:p></w:body></w:document>',
    );
    const facts = await extractOoxmlFactsAsync(await zip.generateAsync({ type: "nodebuffer" }));
    expect(facts.numbering.scheme).toBe("none");
    expect(facts.numbering.levels).toEqual([]);
    expect(facts.outline).toHaveLength(1);
  });
});

describe("TemplateProfile（M1：固定元素 + 槽位骨架）", () => {
  const cardOf = (overrides: Record<string, unknown> = {}) =>
    validateThesisFormatCard(overrides, "模版.docx");

  it("模板章节 → 槽位：锚点升级为固定槽位，其余为 body 且可扩展", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "模版.docx" });
    expect(profile.version).toBe(2);
    expect(profile.slots.map((slot) => `${slot.kind}:${slot.title}`)).toEqual([
      "body:一、项目任务",
      "body:二、项目需求分析",
      "reference:参考资料",
    ]);
    // 锚点槽位保留模板原标题；body 槽位用内容标题
    expect(profile.slots[2]!.emitTemplateTitle).toBe(true);
    expect(profile.slots[0]!.emitTemplateTitle).toBe(false);
    expect(profile.slots[0]!.capacity).toBe("many");
    // 匹配特征已归一化（剥掉「一、」）
    expect(profile.slots[0]!.matchKey.normalized).toBe("项目任务");
    expect(profile.slots[0]!.matchKey.tokens.length).toBeGreaterThan(0);
  });

  it("编号方案与页面一起进 fixed；样式锁覆盖题注/列表等语义键", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "模版.docx" });
    expect(profile.fixed.numbering.scheme).toBe("cn-upper");
    expect(profile.fixed.page.widthMm).toBeGreaterThan(0);
    for (const key of ["body", "h1", "h2", "caption", "tableText", "listItem", "formula"]) {
      expect(profile.fixed.styles[key]).toBeDefined();
    }
    // 模板没定义题注样式 → 回退正文但必须记 gap（不静默）
    expect(profile.fixed.styles.caption!.origin).toBe("default");
    expect(profile.gaps.some((gap) => gap.includes("caption"))).toBe(true);
  });

  it("封面 logo 进入 fixed.logos 且角色为 cover", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    const card = validateThesisFormatCard({}, "模版.docx");
    const profile = buildTemplateProfile({
      facts,
      card: { ...card, cover: { ...card.cover, logo: facts.coverImages[0] } },
      sourceName: "模版.docx",
    });
    expect(profile.fixed.logos.some((logo) => logo.role === "cover" && logo.widthPx === 626)).toBe(true);
  });

  it("模板没有章节骨架时降级并记 gap", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "规范.docx" });
    expect(profile.slots).toEqual([]);
    expect(profile.gaps.some((gap) => gap.includes("章节标题"))).toBe(true);
  });
});
