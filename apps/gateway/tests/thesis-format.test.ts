import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { ThesisFormatCardStore } from "../src/modules/thesis-format/card-store.js";
import { validateThesisFormatCard } from "../src/modules/thesis-format/validate.js";
import { extractOoxmlFactsAsync } from "../src/modules/thesis-format/ooxml-facts.js";
import { mergeTemplateImages } from "../src/modules/thesis-format/service.js";
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
