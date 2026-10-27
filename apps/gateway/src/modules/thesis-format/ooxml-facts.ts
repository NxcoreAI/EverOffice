/**
 * docx 版式事实抽取：styles.xml / document.xml sectPr / 页眉页脚 → 粗粒度 JSON，
 * 供解析代理与条文规则相互印证。单位换算：w:sz 半磅→pt；twips→mm（/56.6929）。
 * 抽取失败抛错由上层容忍（单成员失败不阻断整包）。
 */

import JSZip from "jszip";

const TWIPS_PER_MM = 56.6929;

export interface OoxmlStyleFact {
  id: string;
  name: string;
  fontEastAsia?: string;
  fontAscii?: string;
  sizePt?: number;
  bold?: boolean;
  lineSpacingMultiple?: number;
  lineSpacingExactPt?: number;
  align?: string;
  firstLineIndentChars?: number;
}

/** 页眉/页脚里的展示图片（校徽 logo 等）：字节内联 + 版位事实，装订引擎回填用。 */
export interface OoxmlHfImageFact {
  /** data:image/...;base64 URL。 */
  dataUrl: string;
  widthPx?: number;
  heightPx?: number;
  /** 浮动（wp:anchor）；false/缺省 = 内联随文。 */
  floating?: boolean;
  /** 衬于文字下方（图片水印）。 */
  behind?: boolean;
  posH?: "left" | "center" | "right";
  posV?: "top" | "center" | "bottom";
  posXPx?: number;
  posYPx?: number;
  posHRel?: "page" | "margin";
  posVRel?: "page" | "margin" | "paragraph";
}

export interface OoxmlSectionFact {
  widthMm?: number;
  heightMm?: number;
  marginTopMm?: number;
  marginBottomMm?: number;
  marginLeftMm?: number;
  marginRightMm?: number;
  gutterMm?: number;
  pageFormat?: string;
}

export interface OoxmlFacts {
  styles: OoxmlStyleFact[];
  sections: OoxmlSectionFact[];
  headers: Array<{ file: string; text: string; images: OoxmlHfImageFact[] }>;
  footers: Array<{ file: string; text: string; images: OoxmlHfImageFact[] }>;
  /** 封面区（首个分节/分页之前）的正文图片：校徽、校名标识等。
   *  这类图不在页眉页脚里，装订重建封面时必须显式回填，否则直接丢失。 */
  coverImages: OoxmlHfImageFact[];
}

function attr(xml: string, name: string): number | undefined {
  const m = xml.match(new RegExp(`\\bw:${name}="(-?\\d+)"`));
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** EMU → 像素（genoffice 同款换算：14400 EMU = 1px @96dpi）。 */
const EMU_PER_PX = 9525;

function numAttr(xml: string, tag: string, name: string): number | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${name}="(\\d+)"`));
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 页眉/页脚部件里的展示图片（logo/水印位图）。抽取字节（data:URL）与版位事实，
 * 供解析代理识别「校徽」并让装订引擎在输出里原样回填。
 */
/** 部件的 rels → rId → data:URL 映射（页眉页脚与正文图片共用）。 */
async function partMediaByRid(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const relsPath = partPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsXml = await zip.file(relsPath)?.async("string").catch(() => undefined);
  const mediaByRid = new Map<string, string>();
  if (!relsXml) return mediaByRid;
  for (const rel of relsXml.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = rel.match(/\bId="([^"]+)"/)?.[1];
    const target = rel.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target || /TargetMode="External"/i.test(rel)) continue;
    const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/") + 1) : "";
    const resolved = target.startsWith("/") ? target.slice(1) : dir + target.replace(/^\.\//, "");
    const normalized: string[] = [];
    for (const segment of resolved.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") normalized.pop();
      else normalized.push(segment);
    }
    const entry = zip.file(normalized.join("/"));
    if (!entry) continue;
    const bytes = await entry.async("nodebuffer");
    const ext = (normalized.join("/").split(".").pop() ?? "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "bmp" ? "image/bmp"
      : ext === "emf" || ext === "wmf" ? "image/x-emf"
      : "image/png";
    mediaByRid.set(id, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  return mediaByRid;
}

/** 单个绘图块 → 图片事实（字节 + 尺寸 + 浮动版位）。 */
function drawingFact(frag: string, mediaByRid: Map<string, string>): OoxmlHfImageFact | null {
  const rId = frag.match(/r:(?:embed|id)="([^"]+)"/)?.[1];
  const dataUrl = rId ? mediaByRid.get(rId) : undefined;
  if (!dataUrl) return null;
  const image: OoxmlHfImageFact = { dataUrl };
  const cx = numAttr(frag, "wp:extent", "cx");
  const cy = numAttr(frag, "wp:extent", "cy");
  if (cx !== undefined && cx > 0) image.widthPx = Math.round(cx / EMU_PER_PX);
  if (cy !== undefined && cy > 0) image.heightPx = Math.round(cy / EMU_PER_PX);
  if (/<wp:anchor[\s>]/.test(frag)) {
    image.floating = true;
    if (/behindDoc="(?:1|true)"/.test(frag)) image.behind = true;
    const posH = frag.match(/<wp:positionH[^>]*relativeFrom="(page|margin)"[^>]*>[\s\S]*?<wp:align>(\w+)<\/wp:align>/);
    const posV = frag.match(/<wp:positionV[^>]*relativeFrom="(page|margin|paragraph)"[^>]*>[\s\S]*?<wp:align>(\w+)<\/wp:align>/);
    if (posH) { image.posHRel = posH[1] as "page" | "margin"; image.posH = posH[2] as "left" | "center" | "right"; }
    if (posV) { image.posVRel = posV[1] as "page" | "margin" | "paragraph"; image.posV = posV[2] as "top" | "center" | "bottom"; }
    const offH = frag.match(/<wp:positionH[^>]*relativeFrom="(page|margin)"[^>]*>[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    const offV = frag.match(/<wp:positionV[^>]*relativeFrom="(page|margin|paragraph)"[^>]*>[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    if (offH) image.posXPx = Math.round(Number(offH[2]) / EMU_PER_PX);
    if (offV) image.posYPx = Math.round(Number(offV[2]) / EMU_PER_PX);
  }
  return image;
}

async function hfImages(zip: JSZip, partPath: string, partXml: string): Promise<OoxmlHfImageFact[]> {
  if (!partXml.includes("<a:blip") && !partXml.includes("<v:imagedata")) return [];
  const mediaByRid = await partMediaByRid(zip, partPath);
  if (mediaByRid.size === 0) return [];

  const out: OoxmlHfImageFact[] = [];
  for (const m of partXml.matchAll(/<w:drawing[\s\S]*?<\/w:drawing>|<v:imagedata[^>]*>/g)) {
    const image = drawingFact(m[0], mediaByRid);
    if (image) out.push(image);
  }
  return out;
}

/**
 * 封面区的正文图片（校徽、校名标识）。
 *
 * 装订是「提取规则 → 重建文档」：封面由格式卡字段重新生成，原封面里的图片不会
 * 自动带入（用户报「导入模版后 logo 不见了」即此）。这里抽出封面几张图，让装机
 * 时回填到重建后的封面顶部。
 *
 * 封面区 = 首个分节符/分页符之前的内容；最多 3 张（正常只有校徽/校名标识，
 * 避免把正文插图误当封面元素）。
 */
async function coverImages(zip: JSZip, documentXml: string): Promise<OoxmlHfImageFact[]> {
  if (!documentXml.includes("<a:blip") && !documentXml.includes("<v:imagedata")) return [];
  const boundaries = ["<w:sectPr", 'w:type="page"']
    .map((token) => documentXml.indexOf(token))
    .filter((index) => index > 0);
  const cut = boundaries.length > 0 ? Math.min(...boundaries) : documentXml.length;
  const head = documentXml.slice(0, cut);
  if (!head.includes("<a:blip") && !head.includes("<v:imagedata")) return [];
  const mediaByRid = await partMediaByRid(zip, "word/document.xml");
  if (mediaByRid.size === 0) return [];

  const out: OoxmlHfImageFact[] = [];
  for (const para of head.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    if (!/<w:drawing[\s>]|<w:pict[\s>]|<v:imagedata/.test(para)) continue;
    // 封面文字行普遍居中；取段落对齐作为图片对齐（inline 图跟随段落）。
    const align = para.match(/<w:jc[^>]*w:val="(left|center|right|both)"/)?.[1];
    for (const m of para.matchAll(/<w:drawing[\s\S]*?<\/w:drawing>|<v:imagedata[^>]*>/g)) {
      const image = drawingFact(m[0], mediaByRid);
      if (!image) continue;
      if (align === "center" || align === "right") image.posH = align;
      else if (align === "left") image.posH = "left";
      out.push(image);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

function stripTags(xml: string): string {
  return (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("");
}

function paragraphFact(pPr: string): Pick<OoxmlStyleFact, "lineSpacingMultiple" | "lineSpacingExactPt" | "align" | "firstLineIndentChars"> {
  const fact: Pick<OoxmlStyleFact, "lineSpacingMultiple" | "lineSpacingExactPt" | "align" | "firstLineIndentChars"> = {};
  const spacing = pPr.match(/<w:spacing[^>]*\/>/)?.[0];
  if (spacing) {
    const line = attr(spacing, "line");
    const rule = spacing.match(/\bw:lineRule="(\w+)"/)?.[1];
    if (line !== undefined) {
      if (rule === "exact" || rule === "atLeast") fact.lineSpacingExactPt = Math.round((line / 20) * 10) / 10;
      else fact.lineSpacingMultiple = Math.round((line / 240) * 100) / 100;
    }
  }
  const align = pPr.match(/<w:jc[^>]*\bw:val="(\w+)"/)?.[1];
  if (align) fact.align = align;
  const ind = pPr.match(/<w:ind[^>]*\/>/)?.[0];
  if (ind) {
    const chars = ind.match(/\bw:firstLineChars="(\d+)"/);
    if (chars) fact.firstLineIndentChars = Number(chars[1]) / 100;
  }
  return fact;
}

function runFact(rPr: string): Pick<OoxmlStyleFact, "fontEastAsia" | "fontAscii" | "sizePt" | "bold"> {
  const fact: Pick<OoxmlStyleFact, "fontEastAsia" | "fontAscii" | "sizePt" | "bold"> = {};
  const fonts = rPr.match(/<w:rFonts[^>]*\/>/)?.[0];
  if (fonts) {
    const eastAsia = fonts.match(/\bw:eastAsia="([^"]+)"/)?.[1];
    if (eastAsia) fact.fontEastAsia = eastAsia;
    const ascii = fonts.match(/\bw:ascii="([^"]+)"/)?.[1];
    if (ascii) fact.fontAscii = ascii;
  }
  const sz = attr(rPr, "sz");
  if (sz !== undefined) fact.sizePt = sz / 2;
  fact.bold = /<w:b\b/.test(rPr);
  return fact;
}

export async function extractOoxmlFactsAsync(bytes: Buffer): Promise<OoxmlFacts> {
  const zip = await JSZip.loadAsync(bytes);

  const styles: OoxmlStyleFact[] = [];
  const stylesXml = await zip.file("word/styles.xml")?.async("string").catch(() => undefined);
  if (stylesXml) {
    const styleBlocks = stylesXml.match(/<w:style [^>]*>[\s\S]*?<\/w:style>/g) ?? [];
    for (const block of styleBlocks) {
      const id = block.match(/\bw:styleId="([^"]+)"/)?.[1];
      if (!id) continue;
      const name = block.match(/<w:name[^>]*\bw:val="([^"]+)"/)?.[1] ?? id;
      const relevant = /^Heading/i.test(id) || id === "Normal" || /标题|正文/.test(name);
      if (!relevant && styles.length >= 40) continue;
      const rPr = block.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
      const pPr = block.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
      styles.push({ id, name, ...runFact(rPr), ...paragraphFact(pPr) });
    }
  }

  const sections: OoxmlSectionFact[] = [];
  const documentXml = await zip.file("word/document.xml")?.async("string").catch(() => undefined);
  if (documentXml) {
    const sectBlocks = documentXml.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>|<w:sectPr[^>]*\/>/g) ?? [];
    for (const sect of sectBlocks.slice(0, 10)) {
      const pgSz = sect.match(/<w:pgSz[^>]*\/>/)?.[0] ?? "";
      const pgMar = sect.match(/<w:pgMar[^>]*\/>/)?.[0] ?? "";
      const fact: OoxmlSectionFact = {};
      const w = attr(pgSz, "w");
      const h = attr(pgSz, "h");
      if (w) fact.widthMm = Math.round((w / TWIPS_PER_MM) * 10) / 10;
      if (h) fact.heightMm = Math.round((h / TWIPS_PER_MM) * 10) / 10;
      const top = attr(pgMar, "top");
      const bottom = attr(pgMar, "bottom");
      const left = attr(pgMar, "left");
      const right = attr(pgMar, "right");
      const gutter = attr(pgMar, "gutter");
      if (top !== undefined) fact.marginTopMm = Math.round((top / TWIPS_PER_MM) * 10) / 10;
      if (bottom !== undefined) fact.marginBottomMm = Math.round((bottom / TWIPS_PER_MM) * 10) / 10;
      if (left !== undefined) fact.marginLeftMm = Math.round((left / TWIPS_PER_MM) * 10) / 10;
      if (right !== undefined) fact.marginRightMm = Math.round((right / TWIPS_PER_MM) * 10) / 10;
      if (gutter !== undefined) fact.gutterMm = Math.round((gutter / TWIPS_PER_MM) * 10) / 10;
      const fmt = sect.match(/<w:pgNumType[^>]*\bw:fmt="(\w+)"/)?.[1];
      if (fmt) fact.pageFormat = fmt;
      sections.push(fact);
    }
  }

  const headers: OoxmlFacts["headers"] = [];
  const footers: OoxmlFacts["footers"] = [];
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(path)) continue;
    const xml = await zip.file(path)!.async("string").catch(() => "");
    if (!xml) continue;
    const text = stripTags(xml).trim();
    const images = await hfImages(zip, path, xml);
    const entry = {
      file: path.replace(/^word\//, ""),
      text: (images.length > 0 ? `[图片×${images.length}]${text ? " " + text : ""}` : text).slice(0, 200),
      images,
    };
    if (path.includes("header")) headers.push(entry);
    else footers.push(entry);
  }

  const coverFacts = documentXml ? await coverImages(zip, documentXml) : [];

  return { styles, sections, headers, footers, coverImages: coverFacts };
}
