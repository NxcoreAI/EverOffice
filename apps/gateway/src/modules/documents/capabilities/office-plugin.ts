import { createHash } from "node:crypto";

import { annotations, manifest } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool, type SlidesPageProgressReporter } from "./types.js";
import type {
  OfficeAgentToolCall,
  OfficeApplyBytesResult,
  OfficeBridgeClient,
  OfficeSheetBridgeInput,
} from "./office-bridge-client.js";
import { applyDocxOps, DocxEditError, readDocxParagraphs, type DocxEditOp } from "../../files/docx-edit.js";
import { applyXlsxOps, readXlsx, XlsxEditError, type XlsxEditOp } from "../../files/xlsx-edit.js";
import {
  SlidesVisualReviewer,
  visualReviewToolPayload,
  type VisualReviewOutcome,
} from "../../slides-visual-review/review.js";

/**
 * Agent 写 Office：Word（受限 HTML）、PPT（两阶段：建文件 + 逐页生成）、Excel
 * （sheets→rows）三个工具，经桌面 office-bridge 生成真实文件并走
 * file-imports 入库，Room 产物库由路由决策自动投影展示。
 * - Word：隐藏 GenOffice docs view（HTML 子集与 vendored
 *   apps/docs/src/renderer/ai/protocol.ts 的 HTML_RULES 一致）。
 * - PPT：两阶段生成。create 只带 outline（页序蓝图：每页标题、长度即页数上限），
 *   桌面端只落 1 页骨架（fork buildAgentDeckPptx 生成）；文件入库后自动以可编辑
 *   方式打开，Agent 再用 set_page 一页一页生成（fork
 *   applyAgentDeckPage：与 regenerate_slide 相同的 insertSlidePptx 事务；
 *   slideIndex<页数原地替换，=页数末尾追加——文件页数随生成进度增长，失败不留空壳；
 *   实时重绘、每页独立失败重试）。单次输出一页，避免长输出结构漂移与黑盒等待。
 * - Excel：主进程直接拼标准 OOXML（jszip，inline string）。
 * 编辑：PPT 走 slides_read/edit（文件需在 Room 产物库打开为可编辑实例；
 * 编辑事务实时重绘在打开的视图上，保存自动回填版本链）。
 * Word/Excel 走 office_edit / sheets_read+sheets_edit（文本级/单元格级修改）：
 * 网关读当前版本字节 → 改字节 → 桌面端覆盖工作副本、回填版本链并重开视图。
 * 只支持用户已经以可编辑方式打开的文件；有未保存修改时拒绝写回。
 */

const MAX_HTML_LENGTH = 400_000;
const MAX_SLIDES_PAGES = 24;
export const MAX_PAGE_SPEC_LENGTH = 80_000;
const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLS = 50;
const MAX_CELL_LENGTH = 3000;
/** 单次 Agent 编辑接受的源文件上限：再大就不适合走 base64 桥，直接拒绝。 */
const MAX_EDIT_BYTES = 25 * 1024 * 1024;

/** `office_edit`/`sheets_edit` 需要的最小文件访问面（FilesService 的结构子集）。 */
export interface OfficeFileAccess {
  catalogEntry(fileEntryId: string): {
    id: string;
    originalName: string;
    displayName: string | null;
    currentVersionId: string | null;
    contentHash: string;
  } | null;
  catalogContentOf(fileEntryId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null>;
}

/** slides-builder 子代理独占的 4 个 PPT 工具名：主 Agent 工具面按此剔除（单一事实源）。 */
export const SLIDES_TOOL_NAMES = [
  "slides_create",
  "slides_set_page",
  "slides_read",
  "slides_edit",
] as const;

const HTML_GUIDE = "内容用受限 HTML 片段表达，只允许这些标签："
  + "h1 h2 h3 h4 h5 h6 p ul ol li strong em u s a br table thead tbody tr th td pre code blockquote。"
  + "表格首行用 th，单元格只放纯文本（可用 br 分行），不支持嵌套表格和合并单元格；"
  + "代码示例用 pre，引用用 blockquote；长内容用 h2/h3 分节组织。"
  + "不要包含 html/body 标签、markdown 代码围栏或任何解释性文字。";

const PAGESPEC_GUIDE = "每页是一个 JSON 对象（PageSpec）"
  +   + "spec 手写兜底形态：每一页是一个 JSON 对象（PageSpec），画布固定 1280×720 像素、坐标原点左上，x/y/w/h 用整数像素："
  + '{"background":"#RRGGBB"(可选),"elements":[…按绘制顺序排列…]}。'
  + "元素按数组顺序绘制：背景/装饰形状在前、图片其次、文本最后（文本绝不能被形状盖住）。"
  + "元素七种："
  + "文本 {\"type\":\"text\",\"x\",\"y\",\"w\",\"h\",\"valign\":\"top|middle|bottom\",\"shadow\":\"soft|medium|strong\"(可选),\"paragraphs\":[{\"align\":\"left|center|right\",\"lineSpacingPct\":110,\"spaceAfterPt\":6,\"bullet\":true,\"runs\":[{\"text\",\"sizePt\",\"bold\",\"italic\",\"color\",\"font\"}]}]}；"
  + "形状 {\"type\":\"shape\",\"shape\":\"rect|roundRect|ellipse|triangle|rightArrow|leftArrow|upArrow|downArrow|chevron|diamond|parallelogram|trapezoid|hexagon|pentagon|pie|donut|star5|heart|cloud|line|lineArrow\",\"fill\":\"#RRGGBB 或 #RRGGBBAA（AA=透明度，00 全透明）\",\"gradient\":{\"stops\":[{\"pos\":0~1,\"color\":\"#RRGGBB\"},…恰好 2~3 个],\"angle\":90}(可选线性渐变，有 gradient 时忽略 fill),\"shadow\":\"soft|medium|strong\"(可选),\"stroke\":{\"color\",\"widthPt\"},\"paragraphs\":…(可选，形状内文字垂直居中)}；"
  + "自由路径 {\"type\":\"path\",\"x\",\"y\",\"w\",\"h\",\"d\":\"SVG path 字符串(M/L/C/Q/Z；相对命令与 H/V/S/A 自动归一)\",\"fill\":\"#RRGGBBAA\"(可选),\"fillRule\":\"evenodd\"(可选,挖洞图形用),\"stroke\":{\"color\",\"widthPt\"}(可选),\"shadow\":…(可选)}——fill 与 stroke 至少给一个；坐标空间自定，引擎取包围盒拉伸填满 x/y/w/h 盒子(不保比例)；d ≤2000 字符、每页最多 4 个；仅用于预设形状画不出的装饰轮廓(波浪、弧形分隔、有机形状)，直线用 shape line、小图标用 icon；"
  + "图片 {\"type\":\"image\",\"x\",\"y\",\"w\",\"h\",\"url\":\"https://…\",\"fit\":\"cover|contain\",\"shadow\":\"soft|medium|strong\"(可选)}(仅 http(s)，每页最多 8 张；fit 默认 cover 居中裁剪填满框，主体可能被裁边；产品图等主体必须完整时用 contain 整图缩放居中留白)；"
  + "图表 {\"type\":\"chart\",\"chart\":\"bar|barStacked|line|pie|doughnut|scatter|comboBarLine\",\"title\":\"标题\"(可选≤80字符；页面已有大标题时留空，避免双标题),\"categories\":[\"Q1\",\"Q2\"…](2~24 个),\"series\":[{\"name\":\"系列名\",\"values\":[数字…]}](1~6 个；每个 values 长度必须等于 categories，全为有限数字，否则整页拒绝),\"colors\":[\"#RRGGBB\"…](可选，多系列按系列、饼/环按扇区；不传时用统一蓝灰板),\"legend\":true|false(可选；默认自动——多系列或饼/环显示、单系列不显示),\"dataLabels\":true(可选，仅当点数 ≤8 时才开),\"gridlines\":true(可选)}——scatter 是 XY 散点/定位图：categories 填 x 轴数值（数字字符串），series 的 values 是对应 y 值，点位标签用独立 text 元素叠在图上；"
  + "comboBarLine 是柱+折线双轴组合图（如收入+增长率）：除最后一个系列为折线走右轴外都是柱，必须 ≥2 个系列；"
  + "图标 {\"type\":\"icon\",\"icon\":\"<图标名>\",\"color\":\"#RRGGBB\",\"x\",\"y\",\"w\",\"h\"}(单色矢量图标；可用名："
  + "arrow-up arrow-down arrow-left arrow-right arrow-trending-up arrow-trending-down arrow-path arrow-top-right-on-square "
  + "check check-circle x-circle x-mark plus minus star heart bell calendar clock "
  + "user users building-office-2 home envelope phone chat-bubble-left-right magnifying-glass "
  + "cog-6-tooth lock-closed lock-open eye globe-alt map-pin shopping-cart credit-card "
  + "chart-bar chart-pie currency-dollar light-bulb rocket-launch flag trophy shield-check "
  + "cloud server-stack circle-stack device-phone-mobile computer-desktop wifi link paper-clip "
  + "trash pencil-square document-text folder photo play exclamation-triangle information-circle "
  + "question-mark-circle hand-thumb-up sparkles bolt sun moon key)。"
  + "表格 {\"type\":\"table\",\"x\",\"y\",\"w\",\"h\",\"rows\":[[单元格,…],…](1~12 行 × 1~8 列；单元格是字符串或 {\"text\",\"bold\",\"color\",\"fill\",\"align\":\"left|center|right\",\"span\":跨列数}；每行跨列总数必须一致，否则整页拒绝),\"colWidths\":[0.9,1,1,1](可选相对列宽),\"rowHeights\":[1.2,1,1](可选相对行高),\"fontSize\":13(可选 9~24,默认 13),\"borderColor\":\"#RRGGBB\",\"horizontalBordersOnly\":true(只画行间横线),\"verticalBordersOnly\":true(只画列间竖线),\"borderWidthPt\":0.5(可选 0.25~3),\"zebra\":\"#RRGGBB\"(可选隔行浅底,自动套在偶数数据行)}。"
  + "line/lineArrow 画的是所在盒子的对角线（水平分隔线 = 高 1px 的盒子加 stroke）。"
  + "限制：每页最多 48 个元素；sizePt 6~160；颜色只写 #RGB/#RRGGBB/#RRGGBBAA。"
  + "引擎硬校验（违规整页拒绝，报错回传后修正该页重试）：① 任何文本中出现 emoji（含变体选择符）直接拒绝——图标用 icon 元素；"
  + "② 任何两个「有文字的元素」（文本框或带文字的形状）的估算文字区域相交（留 6px 容差）直接拒绝；"
  + "③ 构建时按真实排版实测：单元格折行把表格撑得超出声明框高、或文本框实际高度伸出画布底边，整页拒绝——按报错里的实测数字砍行数、缩短单元格文字或加大框高，数据量大时拆成两页，不要缩字号硬塞。"
  + "示例页：{\"background\":\"#FFFFFF\",\"elements\":[{\"type\":\"text\",\"x\":80,\"y\":240,\"w\":1120,\"h\":120,\"paragraphs\":[{\"runs\":[{\"text\":\"季度回顾\",\"sizePt\":44,\"bold\":true,\"color\":\"#1A1A1A\"}],\"align\":\"center\"}]}]}";

const SHEETS_GUIDE = "数据用 sheets→rows 的二维数组表达：每个工作表 {\"name\":\"表名(可选,≤31字符)\",\"rows\":[[单元格…],…]}，"
  + `单元格是 string | number | boolean | null（数字用 JSON number，不要写成带引号的字符串；null/缺省留空）。`
  + "每个表的首行会被当作表头（自动加粗、冻结、列宽自适应）。"
  + `限制：最多 ${MAX_SHEETS} 个表、每表 ${MAX_ROWS} 行 × ${MAX_COLS} 列、单元格文本 ≤ ${MAX_CELL_LENGTH} 字符。`
  + "不要输出 markdown 表格；一个主题一张表，列名放首行。";

function idempotencyKey(prefix: string, runId: string, title: string): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify([runId, title]), "utf8").digest("hex")}`;
}

function optionalFileName(args: Record<string, unknown>, extension: string): string | null {
  const raw = args.fileName;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const fileName = raw.trim().slice(0, 120);
  if (!fileName.toLowerCase().endsWith(extension)) {
    throw new Error(`INVALID_REQUEST: fileName 必须以 ${extension} 结尾`);
  }
  return fileName;
}

/** PPT 大纲（每页一个标题，页序蓝图）；首版骨架页由此合成，模型不再整册输出 PageSpec。 */
function normalizeOutline(outline: unknown): string[] {
  if (!Array.isArray(outline) || outline.length === 0) {
    throw new Error("INVALID_REQUEST: outline 必须是非空字符串数组（每页一个标题，数组顺序即页序）");
  }
  if (outline.length > MAX_SLIDES_PAGES) {
    throw new Error(`INVALID_REQUEST: 页数超过上限（${MAX_SLIDES_PAGES}），请精简内容`);
  }
  return outline.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`INVALID_REQUEST: 第 ${index + 1} 页标题无效（必须是非空字符串）`);
    }
    return item.trim().slice(0, 80);
  });
}

/** 骨架页：中性占位版式（演示标题 + 首页标题），set_page slideIndex=0 时整页替换。 */
export function skeletonPageSpec(deckTitle: string, pageTitle: string, index: number, total: number): string {
  return JSON.stringify({
    background: "#F5F6F8",
    elements: [
      { type: "shape", shape: "rect", x: 80, y: 64, w: 48, h: 6, fill: "#C6CBD4" },
      {
        type: "text", x: 80, y: 96, w: 1120, h: 40,
        paragraphs: [{ runs: [{ text: deckTitle, sizePt: 16, bold: true, color: "#6B7280" }] }],
      },
      {
        type: "text", x: 80, y: 300, w: 1120, h: 84,
        paragraphs: [{ runs: [{ text: pageTitle, sizePt: 40, bold: true, color: "#1F2937" }] }],
      },
      {
        type: "text", x: 80, y: 622, w: 1120, h: 24,
        paragraphs: [{ runs: [{ text: `第 ${index + 1} / ${total} 页 · 待填充`, sizePt: 12, color: "#9CA3AF" }] }],
      },
    ],
  });
}

function normalizeSheets(sheets: unknown): OfficeSheetBridgeInput[] {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error("INVALID_REQUEST: sheets 必须是非空数组");
  }
  if (sheets.length > MAX_SHEETS) throw new Error(`INVALID_REQUEST: 工作表数量超过上限（${MAX_SHEETS}）`);
  return sheets.map((sheet, index) => {
    if (!sheet || typeof sheet !== "object" || !Array.isArray((sheet as { rows?: unknown }).rows)) {
      throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表缺少 rows 二维数组`);
    }
    const rows = (sheet as { rows: unknown[] }).rows;
    if (rows.length === 0) throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表 rows 为空`);
    if (rows.length > MAX_ROWS) throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表行数超过上限（${MAX_ROWS}）`);
    const normalized = rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) throw new Error(`INVALID_REQUEST: 第 ${rowIndex + 1} 行不是数组`);
      if (row.length > MAX_COLS) throw new Error(`INVALID_REQUEST: 第 ${rowIndex + 1} 行列数超过上限（${MAX_COLS}）`);
      return row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
        if (typeof cell === "boolean") return cell;
        if (typeof cell === "string") return cell.slice(0, MAX_CELL_LENGTH);
        return String(cell).slice(0, MAX_CELL_LENGTH);
      });
    });
    const rawName = (sheet as { name?: unknown }).name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 31) : null;
    return { name, rows: normalized };
  });
}

export function officePlugin(
  bridge: OfficeBridgeClient,
  /** PPT 逐页进度上报器（只报不定）：未注入时落页无进度广播。 */
  slidesProgress?: SlidesPageProgressReporter | null,
  /** 落页视觉复检（preset 形态）：未注入或 VLM 未配置时复检整体跳过。 */
  visualReviewer?: SlidesVisualReviewer | null,
  /** 文件库访问（惰性）：注入后才暴露 office_edit / sheets_read / sheets_edit。 */
  files?: () => OfficeFileAccess | null,
): DocumentCapabilityPlugin {
  const officeCreate: DocumentCapabilityTool = {
    name: "office_create",
    title: "生成 Word 文档入 Room",
    description: "用本地 Word 引擎生成一份新的 .docx 文档并加入当前 Room（产物库 Office 产物 + 文件库），"
      + "生成的是真实 Word 排版（表格、列表、代码块、引用），适合正式报告、交付文档、需要 Word 排版的内容。"
      + "普通速记、笔记、随手总结仍用文档创建工具（markdown），不要用本工具。"
      + `title 用作文档标题与默认文件名（<title>.docx，可用 fileName 覆盖）。${HTML_GUIDE}`
      + "生成完成后桌面端会自动打开预览；在回复中告知文件名即可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "文档标题（同时是默认文件名）" },
        html: { type: "string", minLength: 1, maxLength: MAX_HTML_LENGTH, description: "文档正文（受限 HTML 片段）" },
        fileName: { type: "string", minLength: 5, maxLength: 120, description: "可选文件名，必须以 .docx 结尾" },
        format: { type: "string", enum: ["docx"], description: "文档格式，当前仅支持 docx" },
      },
      required: ["title", "html"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const html = stringArg(args, "html");
      if (html.length > MAX_HTML_LENGTH) {
        throw new Error(`INVALID_REQUEST: html 超过长度上限（${MAX_HTML_LENGTH} 字符），请拆分内容`);
      }
      const format = args.format === undefined ? "docx" : args.format;
      if (format !== "docx") throw new Error("INVALID_REQUEST: 目前仅支持 docx 格式");
      const fileName = optionalFileName(args, ".docx");
      // 同 run 同标题幂等：桌面侧以 sourceKey=agent:word:<key> 去重/续版本链。
      const result = await bridge.generate({
        title,
        html,
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-word", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "docx",
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        // Room 资料页投影由路由决策异步完成（知识路由关闭时会降级为仅入库）。
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const slidesCreate: DocumentCapabilityTool = {
    name: "slides_create",
    title: "创建 PPT 入 Room",
    description: "创建一份新 .pptx 演示文稿并加入当前 Room（产物库 Office 产物 + 文件库），"
      + "适合汇报、提案、培训等演示场景。只传 outline（每页一个标题，是页序蓝图：数组顺序即页序、"
      + `长度即页数上限，共 1~${MAX_SLIDES_PAGES} 页）；创建的文件初始只有 1 页骨架，页数随后续逐页生成增长。`
      + "第二步必须用 slides_set_page 一页一页生成——slideIndex=0 替换骨架页，"
      + "此后 slideIndex=当前页数 时自动在末尾追加新页；生成到第几页，文件就有几页完整成形的页，中途失败不会留空壳页。"
      + "title 用作默认文件名（<title>.pptx，可用 fileName 覆盖）。"
      + "不要在本工具里写任何页面内容——内容全部通过逐页生成完成。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "演示标题（同时是默认文件名）" },
        outline: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SLIDES_PAGES,
          description: "页序蓝图：每页的标题（数组顺序即页序；第 1 项是封面标题；长度即页数上限）。只要标题，不要写页面内容",
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .pptx 结尾" },
      },
      required: ["title", "outline"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const outline = normalizeOutline(args.outline);
      const fileName = optionalFileName(args, ".pptx");
      const pages = [skeletonPageSpec(title, outline[0]!, 0, outline.length)];
      const result = await bridge.generate({
        title,
        format: "pptx",
        pages,
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-slides", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      visualReviewer?.forgetDeck(result.fileEntryId);
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "pptx",
        pages: 1,
        outline,
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        roomRoutingRequested: result.roomRequested,
        nextAction: "fill_pages",
        ...(visualReviewer ? { visualReview: "enabled" } : {}),
        hint: `文件已创建并正在自动打开（初始只有 1 页骨架）；接下来用 slides_set_page（fileId=${result.fileEntryId} 或 \"active\"）一页一页生成：先填 slideIndex=0（替换骨架页），此后每页 slideIndex=当前页数，会自动在末尾追加新页；每页成功再继续下一页。`,
      });
    },
  };

  const slidesSetPage: DocumentCapabilityTool = {
    name: "slides_set_page",
    title: "逐页生成 PPT",
    description: "生成已打开 PPT 的一页（spec 形态：整页 PageSpec 直填）：slideIndex 小于当前页数时原地替换该页（旧内容整体丢弃）；"
      + "slideIndex 等于当前页数时在末尾追加新页（页数 +1）。"
      + "这是 PPT 生成的第二步：slides_create 建好文件（1 页骨架）后，用本工具一页一页生成——"
      + "从 slideIndex=0 起按 0、1、2… 顺序推进，每页等成功结果（用户实时看到该页成形）再继续下一页；"
      + "某页失败只需重试该页，不影响已完成的页；生成到第几页，文件就有几页。"
      + `${PAGESPEC_GUIDE}`
      + "落页成功后系统会把该页渲染成图并做视觉复检（配置视觉模型时启用），结果在返回值 visualReview 字段："
      + "不通过（status=fail）时按 issues 指出的位置修正该页后重新 set_page 同一页，retriesExhausted=true 时停止重试继续下一页。"
      + "刚创建的文件会自动打开，fileId 用 create 返回的 fileEntryId 或 \"active\"。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；\"active\" = 当前打开的那个 PPT" },
        slideIndex: { type: "integer", minimum: 0, maximum: MAX_SLIDES_PAGES - 1, description: "页序号，从 0 开始（第 1 页 = 0）；等于当前页数时表示追加新页" },
        spec: { type: "object", additionalProperties: true, description: "该页完整的 PageSpec 对象（整页替换；elements 按绘制顺序排列）" },
      },
      required: ["fileId", "slideIndex", "spec"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const fileId = stringArg(args, "fileId").trim();
      const slideIndex = args.slideIndex;
      if (typeof slideIndex !== "number" || !Number.isInteger(slideIndex) || slideIndex < 0) {
        throw new Error("INVALID_REQUEST: slideIndex 必须是非负整数（0 = 第 1 页）");
      }
      const spec = args.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("INVALID_REQUEST: spec 必须是该页完整的 PageSpec 对象");
      }
      const specJson = JSON.stringify(spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        throw new Error(`INVALID_REQUEST: 单页 PageSpec 超过长度上限（${MAX_PAGE_SPEC_LENGTH} 字符），请精简该页`);
      }
      const result = await bridge.fillPage({ fileId, slideIndex, specJson });
      if (!result.ok) throw new Error(`OFFICE_EDIT_FAILED: ${result.error ?? "桌面端填充失败"}`);
      // 逐页进度（只报不定）：成功落页即广播快照，进度卡逐页打勾；
      // 不停等、不决策——内容确认在草稿文档阶段，修改在成品批注阶段。
      if (result.applied === true) {
        slidesProgress?.notify(context.runId, slideIndex);
      }
      // 视觉复检：落页成功后截图 → VLM 封闭清单判定；结果进
      // 工具返回，模型按 SYSTEM.md 纪律修正重落（同页最多一次，超限放行）。
      let visualReview: VisualReviewOutcome | null = null;
      if (result.applied === true && visualReviewer) {
        visualReview = await visualReviewer.reviewPage({
          fileId,
          slideIndex,
          fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId, slideIndex }), "base64"),
        });
      }
      const reviewStatus = visualReview?.status;
      const nextAction = result.applied !== true
        ? "fix_spec_and_retry"
        : reviewStatus === "fail"
          ? (visualReview?.status === "fail" && visualReview.retriesExhausted ? "fill_next_page" : "revise_page_and_retry")
          : "fill_next_page";
      return success({
        fileId,
        slideIndex,
        applied: result.applied === true,
        ...(result.records ? { records: result.records } : {}),
        ...(result.failures?.length ? { failures: result.failures } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        ...(result.saved !== undefined ? { saved: result.saved } : {}),
        ...(result.saveError ? { saveError: result.saveError } : {}),
        ...(result.outline ? { outline: result.outline } : {}),
        ...(visualReview ? { visualReview: visualReviewToolPayload(visualReview) } : {}),
        nextAction,
      });
    },
  };

  const sheetsCreate: DocumentCapabilityTool = {
    name: "sheets_create",
    title: "生成 Excel 表格入 Room",
    description: "生成本地排版的一份新 .xlsx 电子表格并加入当前 Room（产物库 Office 产物 + 文件库），"
      + "适合数据清单、预算、对比表、统计汇总等结构化数据。title 用作默认文件名（<title>.xlsx，可用 fileName 覆盖）。"
      + `sheets 是工作表数组。${SHEETS_GUIDE}`
      + "生成完成后桌面端会自动打开预览；在回复中告知文件名与表结构即可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "表格标题（同时是默认文件名）" },
        sheets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SHEETS,
          description: "工作表数组，每项 {name?, rows}",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 31, description: "工作表名（可选）" },
              rows: {
                type: "array",
                minItems: 1,
                description: "二维数组；每行是单元格数组（string|number|boolean|null）；首行视为表头",
                items: { type: "array", items: {} },
              },
            },
            required: ["rows"],
          },
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .xlsx 结尾" },
      },
      required: ["title", "sheets"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const sheets = normalizeSheets(args.sheets);
      const fileName = optionalFileName(args, ".xlsx");
      const result = await bridge.generate({
        title,
        format: "xlsx",
        sheets,
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-sheets", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "xlsx",
        sheets: sheets.length,
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const slidesRead: DocumentCapabilityTool = {
    name: "slides_read",
    title: "读取 PPT 大纲与操作词汇",
    description: "读取一份 Room 产物库中的 .pptx 产物的大纲与可编辑操作词汇表。"
      + "fileId 缺省（或 \"active\"）= 用户当前打开的那个 PPT；传显式 fileEntryId 时未打开的 PPT 会自动以可编辑方式打开（应用重启后同会话也能继续改）。"
      + "大纲列出每页的元素（id | 类型 | 文本摘要），是编辑时定位元素的唯一依据；"
      + "opVocabulary 列出 slides_edit 可用的全部操作及其签名。"
      + "文件不存在会报错并列出当前打开的 Office 文件；editable=false 表示只读打开（能读大纲，"
      + "要编辑需用户在产物库重新以可编辑方式打开）。"
      + "编辑前先读本工具，之后按大纲里的元素 id 发编辑事务。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；缺省或 \"active\" = 当前打开的那个 PPT；显式 id 未打开会自动打开" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const rawFileId = args.fileId;
      const fileId = typeof rawFileId === "string" && rawFileId.trim() ? rawFileId.trim() : "active";
      const info = await bridge.readDeck(fileId);
      if (!info.outline) throw new Error("OFFICE_EDIT_FAILED: 桌面端未返回大纲");
      return success({
        fileId,
        outline: info.outline,
        opVocabulary: info.opVocabulary,
        ...(info.editable !== undefined ? { editable: info.editable } : {}),
        nextAction: info.editable === false ? "guide_reopen_editable" : "edit",
      });
    },
  };

  const slidesEdit: DocumentCapabilityTool = {
    name: "slides_edit",
    title: "编辑已打开的 PPT",
    description: "向一份 Room 产物库中的 .pptx 产物应用一个操作事务（ops 数组，原子生效）。"
      + "fileId 可用 \"active\"（当前打开的那个）或显式 fileEntryId（未打开会自动以可编辑方式打开）。"
      + "常用操作：setText/setFont/setFill 改已有元素，addElement/addSlideWithLayout 新增，"
      + "deleteElement/deleteSlide 删除，moveSlide 调序，findReplace 全稿替换，setNotes 备注页；"
      + "完整词汇与签名见 slides_read 返回的 opVocabulary（每项自带用法，失败信息也会带用法提示）。"
      + "元素用 read 大纲里的 id 定位（target.slide 从 0 计）；一次事务 1~50 个 op。"
      + "编辑会实时显示在打开的视图上并自动保存（版本链 +1）。返回新 outline，可直接链式编辑。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；\"active\" = 当前打开的那个 PPT；显式 id 未打开会自动打开" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "操作数组，每项 {op, target?, …字段}；默认整体原子（任一失败全部不生效），isolation=per_op 可放开",
          items: { type: "object", additionalProperties: true },
        },
        isolation: { type: "string", enum: ["atomic", "per_op"], description: "atomic（默认）：任一失败全部回滚；per_op：成功的保留" },
        dryRun: { type: "boolean", description: "true 只校验并返回计划，不落盘" },
      },
      required: ["fileId", "ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const fileId = stringArg(args, "fileId").trim();
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组（每项一个操作对象）");
      }
      const isolation =
        args.isolation === "per_op" ? "per_op" : args.isolation === "atomic" ? "atomic" : undefined;
      const result = await bridge.editDeck({
        fileId,
        ops: args.ops,
        ...(isolation ? { isolation } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun === true } : {}),
      });
      if (!result.ok) throw new Error(`OFFICE_EDIT_FAILED: ${result.error ?? "桌面端编辑失败"}`);
      return success({
        fileId,
        applied: result.applied === true,
        ...(result.dryRun ? { dryRun: true, plan: result.plan ?? [] } : {}),
        ...(result.records ? { records: result.records } : {}),
        ...(result.failures?.length ? { failures: result.failures } : {}),
        ...(result.saved !== undefined ? { saved: result.saved } : {}),
        ...(result.saveError ? { saveError: result.saveError } : {}),
        ...(result.outline ? { outline: result.outline } : {}),
        nextAction: result.applied === true ? "report_result" : "fix_ops_and_retry",
      });
    },
  };

  // ── 改写「用户正开着的那份」Word/Excel ────────────────────────

  async function resolveEditableTarget(
    args: Record<string, unknown>,
    context: { activeFile?: { fileId: string } },
  ): Promise<{
    fileId: string;
    entry: NonNullable<ReturnType<OfficeFileAccess["catalogEntry"]>>;
    buffer: Buffer;
  }> {
    const access = files?.();
    if (!access) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");
    const explicit = typeof args.fileId === "string" ? args.fileId.trim() : "";
    const fileId = explicit || context.activeFile?.fileId || "";
    if (!fileId) {
      throw new Error("NO_ACTIVE_FILE: 当前没有打开 Office 文件；请用户先打开要修改的文件，或显式传 fileId");
    }
    const entry = access.catalogEntry(fileId);
    if (!entry) {
      throw new Error(`FILE_NOT_FOUND: ${fileId} 不在文件库中（可能仍在导入或已被删除）`);
    }
    if (!entry.contentHash) {
      throw new Error(`FILE_CONTENT_UNAVAILABLE: 《${entry.displayName ?? entry.originalName}》还没有可用的文件版本`);
    }
    const content = await access.catalogContentOf(fileId);
    if (!content) throw new Error(`FILE_CONTENT_UNAVAILABLE: 读取《${entry.originalName}》失败`);
    if (content.buffer.byteLength > MAX_EDIT_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: 文件 ${(content.buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过单次编辑上限（25MB）`,
      );
    }
    return { fileId, entry, buffer: content.buffer };
  }

  function applyFailureMessage(title: string, result: OfficeApplyBytesResult): string {
    switch (result.reason) {
      case "not_open":
        return `FILE_NOT_OPEN: 《${title}》没有以可编辑方式打开。请用户在文件页打开它后再让我修改（不要假装已经改好）。`;
      case "not_editable":
        return `FILE_READONLY: 《${title}》是只读打开的，或该格式不支持在线编辑。请用户以可编辑方式重新打开。`;
      case "unsaved":
        return `FILE_UNSAVED: 《${title}》里有未保存的修改。请用户先保存（⌘S），保存后再重试这次修改。`;
      case "conflict":
        return `FILE_CONFLICT: 《${title}》在生成修改期间又被保存过，本次修改没有落盘。重新读取文档后再改一次。`;
      default:
        return `FILE_APPLY_FAILED: ${result.message ?? "桌面端写回失败"}`;
    }
  }

  const officeRead: DocumentCapabilityTool = {
    name: "office_read",
    title: "读取当前打开的 Word 段落",
    description: "按文档顺序列出 .docx 的段落纯文本（0 基序号 + 段落样式），fileId 省略 = 用户当前浏览的文件。"
      + "office_edit 的 find 必须照抄这里的段落原文：file_read 返回的是 Markdown（带 # 与 ** 标记），"
      + "直接拿 Markdown 文本去 find 会匹配不上。写之前先 office_read。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        maxParagraphs: { type: "integer", minimum: 1, maximum: 1000, description: "最多返回多少段（默认 300）" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: office_read 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      const paragraphs = await readDocxParagraphs(target.buffer);
      const limit = typeof args.maxParagraphs === "number"
        ? Math.min(Math.max(args.maxParagraphs, 1), 1000)
        : 300;
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        totalParagraphs: paragraphs.length,
        paragraphs: paragraphs.slice(0, limit).map((paragraph) => ({
          index: paragraph.index,
          text: paragraph.text.slice(0, 2_000),
          ...(paragraph.style ? { style: paragraph.style } : {}),
        })),
        truncated: paragraphs.length > limit,
      });
    },
  };

  const officeEdit: DocumentCapabilityTool = {
    name: "office_edit",
    title: "修改当前打开的 Word 文档",
    description: "直接修改用户当前浏览的 .docx（或显式 fileId 指定的 .docx），改完立即落盘并重开预览。"
      + "按段落文本定位，不要求 blockId：先用 office_read 看段落原文（不要用 file_read 的 Markdown 标记），再按原文片段构造 ops。"
      + "只支持文本级编辑，保留原有段落样式/编号/分页："
      + "replace_text（{find, replace, all?} 段内子串替换，all=true 替换全文所有匹配）；"
      + "replace_paragraph（{find, text} 整段替换，find 必须唯一命中一个段落）；"
      + "insert_paragraph_after（{find, text} 在锚点段后插入新段落，沿用锚点段格式）；"
      + "append_paragraph（{text} 文末追加）；delete_paragraph（{find} 删除整段）。"
      + "一次最多 20 条，按数组顺序执行；任一条失败整批不落盘。"
      + "不支持跨段落查找、改图片/表格结构/页眉页脚；整段替换后段内混合格式会统一。"
      + "文件必须已经由用户以可编辑方式打开，且有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id（fileEntryId）；省略 = 用户当前正在浏览的文件" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "编辑操作数组（replace_text / replace_paragraph / insert_paragraph_after / append_paragraph / delete_paragraph）",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["type"],
            properties: { type: { type: "string" } },
          },
        },
      },
      required: ["ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(
          `INVALID_TARGET: office_edit 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`
          + (/\.(xlsx)$/i.test(target.entry.originalName) ? "。表格请改用 sheets_edit" : ""),
        );
      }
      let outcome: Awaited<ReturnType<typeof applyDocxOps>>;
      try {
        outcome = await applyDocxOps(target.buffer, args.ops as DocxEditOp[]);
      } catch (error) {
        if (error instanceof DocxEditError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const applied = await bridge.applyFileBytes({
        fileId: target.fileId,
        bytesBase64: outcome.buffer.toString("base64"),
        expectedContentHash: target.entry.contentHash,
      });
      if (!applied.ok) {
        throw new Error(applyFailureMessage(target.entry.displayName ?? target.entry.originalName, applied));
      }
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        applied: true,
        changes: outcome.changes,
        ...(applied.version !== undefined ? { version: applied.version } : {}),
        nextAction: "report_result",
        hint: "修改已写入文件并更新版本；回复里只说明改了什么，不要复述整段正文。",
      });
    },
  };

  const sheetsRead: DocumentCapabilityTool = {
    name: "sheets_read",
    title: "读取当前打开的 Excel 表格",
    description: "读取 .xlsx 的工作表清单、单元格值与公式（fileId 省略 = 用户当前浏览的文件）。"
      + "先读再改：sheets_edit 的单元格地址、行号都以这里返回的结构为准。"
      + "range 用 A1 或 A1:D20；缺省读已用区域的前 200 行 × 50 列。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        sheet: { type: "string", minLength: 1, description: "工作表名；省略读汇总 + 第一个工作表" },
        range: { type: "string", minLength: 1, description: "A1 或 A1:D20；省略读已用区域" },
        maxRows: { type: "integer", minimum: 1, maximum: 5000, description: "最多返回多少行（默认 200）" },
        maxColumns: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少列（默认 50）" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_read 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      const read = await readXlsx(target.buffer, {
        ...(typeof args.sheet === "string" && args.sheet.trim() ? { sheet: args.sheet.trim() } : {}),
        ...(typeof args.range === "string" && args.range.trim() ? { range: args.range.trim() } : {}),
        ...(typeof args.maxRows === "number" ? { maxRows: args.maxRows } : {}),
        ...(typeof args.maxColumns === "number" ? { maxColumns: args.maxColumns } : {}),
      });
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        ...read,
      });
    },
  };

  const sheetsEdit: DocumentCapabilityTool = {
    name: "sheets_edit",
    title: "修改当前打开的 Excel 表格",
    description: "直接修改用户当前浏览的 .xlsx（或显式 fileId），改完立即落盘并重开预览。"
      + "先用 sheets_read 确认工作表名、单元格地址与现有数据，再构造 ops（按数组顺序执行，最多 50 条，任一条失败整批不落盘）："
      + "set_cells（{sheet?, cells:[{address, value?, formula?, numberFormat?}]}，formula 不带等号）；"
      + "set_range（{sheet?, start, rows: [[...]]}，从 start 向右/向下铺开）；"
      + "insert_rows / delete_rows（{sheet?, start, count?}，行号从 1 起）；"
      + "add_sheet / rename_sheet / delete_sheet。"
      + "写入会保留大多数样式、合并单元格、列宽与公式，但图表/图片等对象可能退化；"
      + "文件必须有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "编辑操作数组（set_cells / set_range / insert_rows / delete_rows / add_sheet / rename_sheet / delete_sheet）",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["type"],
            properties: { type: { type: "string" } },
          },
        },
      },
      required: ["ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(
          `INVALID_TARGET: sheets_edit 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`
          + (/\.docx$/i.test(target.entry.originalName) ? "。Word 文档请改用 office_edit" : ""),
        );
      }
      let outcome: Awaited<ReturnType<typeof applyXlsxOps>>;
      try {
        outcome = await applyXlsxOps(target.buffer, args.ops as XlsxEditOp[]);
      } catch (error) {
        if (error instanceof XlsxEditError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const applied = await bridge.applyFileBytes({
        fileId: target.fileId,
        bytesBase64: outcome.buffer.toString("base64"),
        expectedContentHash: target.entry.contentHash,
      });
      if (!applied.ok) {
        throw new Error(applyFailureMessage(target.entry.displayName ?? target.entry.originalName, applied));
      }
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        applied: true,
        changes: outcome.changes,
        ...(applied.version !== undefined ? { version: applied.version } : {}),
        nextAction: "report_result",
        hint: "修改已写入文件并更新版本；回复里只说明改了哪些单元格/工作表。",
      });
    },
  };

  // ── 活 Word/Excel 宿主执行器（渲染层 AI 工具直通：块级/富文本编辑 + propose_operations DSL）──

  const agentToolsFailureMessage = (title: string, message: string): string =>
    `《${title}》无法执行：${message}`;

  const wordAgentRead: DocumentCapabilityTool = {
    name: "word_agent_read",
    title: "读取当前 Word 的块结构与工具指南",
    description: "读取用户当前浏览（或显式 fileId）的 .docx 的活文档状态：块列表（index|type|内容预览）、全文统计、"
      + "以及可用的编辑工具词汇表（insert_content/replace_blocks/apply_commands 等）与 HTML 片段规则、命令指南。"
      + "块索引是 word_agent_edit 的定位依据：每次编辑后索引会变，需要最新索引时重新调用本工具。"
      + "只读打开的文件也能读。比 office_read 的段落列表更精确（含块类型/预览截断标记）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_read 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      try {
        const described = await bridge.describeAgentArtifact({ kind: "docx", fileId: target.fileId });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...described,
          hint: "用 context 里的块索引驱动 word_agent_edit 的工具调用；replace_blocks/insert_content 的 html 遵循 htmlRules。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  const wordAgentEdit: DocumentCapabilityTool = {
    name: "word_agent_edit",
    title: "用文档 AI 工具链编辑当前 Word",
    description: "把 GenOffice Docs 的编辑器 AI 工具调用直接作用到用户正开着的 .docx 上（编辑实时重绘，随后静默保存并更新版本）。"
      + "先 word_agent_read 拿块索引与规则。可用工具（本环境不支持联网类工具）："
      + "get_document_context（刷新块列表）、read_blocks（读块全文）、"
      + "insert_content（{afterIndex, html} 插入）、replace_blocks（{start, end, html} 区间替换）、"
      + "apply_commands（格式/结构/查找替换/批处理，命令见 word_agent_read 返回的 commandsGuide）、"
      + "read_revisions / read_comments / reply_comment / resolve_comment（修订与评论）、"
      + "insert_chart / edit_chart（图表）、set_header_footer（页眉页脚，text 里 {PAGE}/{NUMPAGES} 是页码/总页数域，\n 分行）、"
      + "set_watermark（{text} 设置文字水印如 机密/草稿，text:null 移除；当前水印见 word_agent_read 的 watermark 字段）、"
      + "set_page_setup（{orientation/paperSize/margins(单位 twip, 1cm=567)/columns/pageColor/theme} 页面设置与主题；当前值见 pageSetup 字段）、"
      + "insert_image_base64（{base64, mime, afterIndex?, maxWidthPx?} 插图：宿主外的取图由你自己完成后传 base64 字节）、"
      + "add_comment（{startIndex, endIndex?, text} 在块上建批注）、delete_comment（{id} 删整个批注线程）、"
      + "insert_shape（{prst, widthEmu?, heightEmu?, afterIndex?} 插入形状，prst 如 rect/roundRect/ellipse/triangle/star5/lineArrow）、"
      + "update_toc（{} 重建目录并回填真实页码）。"
      + "一次最多 50 条，按序执行；结果逐条返回（isError=true 表示该条失败，不影响已执行的其他条）。"
      + "文件必须以可编辑方式打开且有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "工具调用数组（{id, name, input}），name 必须是 word_agent_read 返回的 tools 之一",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name", "input"],
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
            },
          },
        },
      },
      required: ["calls"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.calls) || args.calls.length === 0) {
        throw new Error("INVALID_REQUEST: calls 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_edit 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      try {
        const applied = await bridge.applyAgentArtifactTools({
          kind: "docx",
          fileId: target.fileId,
          calls: args.calls as OfficeAgentToolCall[],
        });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...applied,
          nextAction: "report_result",
          hint: applied.results?.some((r) => r.isError)
            ? "部分调用失败：读每条 output 修正后重试失败的调用；成功条目已生效，不要重复执行。"
            : "修改已生效并保存；回复里只说明改了什么。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  const sheetsAgentRead: DocumentCapabilityTool = {
    name: "sheets_agent_read",
    title: "读取当前 Excel 的工作簿上下文与操作指南",
    description: "读取用户当前浏览（或显式 fileId）的 .xlsx 的活工作簿状态：工作表清单（id/名称/数据范围）、当前选区、"
      + "已知非空单元格，以及 propose_operations DSL 的工具词汇表与全部操作指南（writing/formatting/layout/structure/charts/…）。"
      + "sheetId 是 sheets_agent_edit 里操作的定位依据（不是工作表名）。"
      + "只读打开的文件也能读。比 sheets_read 更适合作为 propose_operations 的前置。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_agent_read 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      try {
        const described = await bridge.describeAgentArtifact({ kind: "spreadsheet", fileId: target.fileId });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...described,
          hint: "读单元格用 read_range/read_cells；写改动用 propose_operations（op 字段定义在 guides 里，先查再写）。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  const sheetsAgentEdit: DocumentCapabilityTool = {
    name: "sheets_agent_edit",
    title: "用表格 AI 工具链编辑当前 Excel",
    description: "把 GenOffice Sheets 的编辑器 AI 工具调用直接作用到用户正开着的 .xlsx 上（编辑实时重绘，随后静默保存并更新版本）。"
      + "先 sheets_agent_read 拿工作簿上下文与指南。常用工具："
      + "read_range / read_cells（读值与公式）、find_cells（全簿搜索）、select_range（选区定位）、"
      + "aggregate_range（大批量统计）、propose_operations（{operations, summary} 唯一的写路径，op 定义见指南）、"
      + "trace_precedents / trace_dependents（公式审计）。"
      + "打印控制走 set_page_setup（含 printArea/printTitles/header/footer（&P 页码 &N 总页数 &D 日期 &A 表名）/rowBreaks/colBreaks）、"
      + "条件格式支持 iconSet 图标集。"
      + "一次最多 50 条，按序执行；结果逐条返回（isError=true 表示该条失败，不影响已执行的其他条）。"
      + "文件必须以可编辑方式打开且有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "工具调用数组（{id, name, input}），name 必须是 sheets_agent_read 返回的 tools 之一",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name", "input"],
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
            },
          },
        },
      },
      required: ["calls"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.calls) || args.calls.length === 0) {
        throw new Error("INVALID_REQUEST: calls 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_agent_edit 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      try {
        const applied = await bridge.applyAgentArtifactTools({
          kind: "spreadsheet",
          fileId: target.fileId,
          calls: args.calls as OfficeAgentToolCall[],
        });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...applied,
          nextAction: "report_result",
          hint: applied.results?.some((r) => r.isError)
            ? "部分调用失败：读每条 output 修正后重试失败的调用；成功条目已生效，不要重复执行。"
            : "修改已生效并保存；回复里只说明改了哪些单元格/工作表。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  return {
    manifest: manifest("office.create", "mutation", null, null, false),
    promptGuidelines: [
      "用户需要正式 Office 文档时按格式选工具：Word 报告/交付物用 office_create，"
      + "数据表格用 sheets_create；演示/汇报（PPT）不在本组工具内，一律经 slides_draft 调度 slides 子代理（create 先方案后落页，edit 直改）完成；"
      + "普通笔记、速记、随手总结用文档创建工具（markdown），不要用 Office 工具。",
      "Word 的 html 入参必须是受限 HTML 子集（仅标题/段落/列表/表格/链接/强调/pre/code/blockquote 标签）；"
      + "长文用 h2/h3 分节；表格首行用 th、单元格纯文本；不要输出 markdown 或解释性文字。",
      "Excel 的 sheets→rows 用 JSON 二维数组；数字必须是 JSON number；每个表首行放表头。",
      "生成成功后在回复中告知文件名；桌面端会自动打开预览，文档在 Room 产物库（Office 产物）和文件库可见。",
      "用户要求修改“我正开着的/这份 Word 或 Excel”时：Word 先 office_read 拿段落原文、Excel 先 sheets_read 看结构，"
      + "再用 office_edit / sheets_edit 按原文片段或单元格地址改；不要用 office_create/sheets_create 重建一份新文件。"
      + "被 FILE_UNSAVED 拒绝时先把“先保存再改”告诉用户，保存后重试；被 FILE_NOT_OPEN 拒绝时请用户先以可编辑方式打开文件。",
    ],
    tools: [
      officeCreate,
      slidesCreate,
      slidesSetPage,
      sheetsCreate,
      slidesRead,
      slidesEdit,
      ...(files ? [officeRead, officeEdit, sheetsRead, sheetsEdit] : []),
      ...(files ? [wordAgentRead, wordAgentEdit, sheetsAgentRead, sheetsAgentEdit] : []),
    ],
  };
}
