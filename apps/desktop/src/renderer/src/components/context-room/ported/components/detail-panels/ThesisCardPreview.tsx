/**
 * 论文格式卡样张预览：纯 CSS 按卡数据（ThesisFormatCard JSON）渲染纸样。
 * mini=排版面板列表里的缩略示意；full=大预览弹窗（封面页+正文页，
 * mm/pt 按真实比例换算成 px）。卡字段不完整时逐项兜默认，保证可渲染。
 */

const SIZE_PT: Record<string, number> = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 七号: 5.5,
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sizePt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return SIZE_PT[value] ?? fallback;
  return fallback;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 卡的渲染投影：只取样张需要的字段，全部兜默认。 */
export interface ThesisCardView {
  widthMm: number;
  heightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  eastAsia: string;
  ascii: string;
  baseSizePt: number;
  lineSpacingMultiple: number;
  firstLineIndentChars: number;
  h1: { eastAsia: string; ascii: string; sizePt: number; bold: boolean; align: string };
  schoolName: string;
  degreeLine: string;
  yearLine: string;
  footerLine: string;
  schoolSizePt: number;
  schoolBold: boolean;
  coverFields: string[];
  headerEnabled: boolean;
  headerTemplate: string;
  headerUnderline: boolean;
}

export function readThesisCardView(raw: Record<string, unknown>): ThesisCardView {
  const page = rec(raw.page);
  const base = rec(raw.base);
  const baseFont = rec(base.font);
  const baseParagraph = rec(base.paragraph);
  const headings = list(raw.headings).map(rec);
  const h1 = headings[0] ? rec(headings[0].font) : {};
  const heading = headings[0] ?? {};
  const cover = rec(raw.cover);
  const schoolFont = rec(cover.schoolFont);
  const header = rec(raw.header);
  return {
    widthMm: num(page.widthMm, 210),
    heightMm: num(page.heightMm, 297),
    marginTopMm: num(page.marginTopMm, 25),
    marginBottomMm: num(page.marginBottomMm, 25),
    marginLeftMm: num(page.marginLeftMm, 30),
    marginRightMm: num(page.marginRightMm, 30),
    eastAsia: str(baseFont.eastAsia, '宋体'),
    ascii: str(baseFont.ascii, 'Times New Roman'),
    baseSizePt: sizePt(baseFont.size, 12),
    lineSpacingMultiple: num(baseParagraph.lineSpacingMultiple, 1.25),
    firstLineIndentChars: num(baseParagraph.firstLineIndentChars, 2),
    h1: {
      eastAsia: str(h1.eastAsia, '黑体'),
      ascii: str(h1.ascii, 'Times New Roman'),
      sizePt: sizePt(h1.size, 16),
      bold: h1.bold !== false,
      align: str(heading.align, 'center'),
    },
    schoolName: str(cover.schoolName, '××大学'),
    degreeLine: str(cover.degreeLine, '本科毕业论文（设计）'),
    yearLine: str(cover.yearLine, '二〇二六年六月'),
    footerLine: str(cover.footerLine, ''),
    schoolSizePt: sizePt(schoolFont.size, 26),
    schoolBold: schoolFont.bold !== false,
    coverFields: list(cover.fields).map((field) => str(rec(field).label)).filter(Boolean).slice(0, 6),
    headerEnabled: header.enabled === true,
    headerTemplate: str(header.template, '{title}'),
    headerUnderline: header.underline === true,
  };
}

function paperFont(eastAsia: string, ascii: string): string {
  const cnAlias = eastAsia.includes('黑') ? '"Heiti SC"'
    : eastAsia.includes('楷') ? '"Kaiti SC"'
      : '"Songti SC"';
  return `"${ascii}", "${eastAsia}", ${cnAlias}, "PingFang SC", serif`;
}

/** 面板列表里的缩略纸样：比例真实、内容为示意（校名真字 + 层级行条）。 */
export function ThesisMiniPaper({ card }: { card: ThesisCardView }) {
  const padX = (card.marginLeftMm / card.widthMm) * 100;
  const padY = (card.marginTopMm / card.heightMm) * 100;
  return (
    <span
      className="context-room-thesis-mini-paper"
      style={{
        aspectRatio: `${card.widthMm} / ${card.heightMm}`,
        padding: `${padY * 0.6}% ${padX}%`,
      }}
      aria-hidden="true"
    >
      <span className="context-room-thesis-mini-school" style={{ fontWeight: card.schoolBold ? 700 : 400 }}>
        {card.schoolName}
      </span>
      <span className="context-room-thesis-mini-rule" />
      <span className="context-room-thesis-mini-h1" style={{ fontWeight: card.h1.bold ? 700 : 400 }} />
      <span className="context-room-thesis-mini-line is-w1" />
      <span className="context-room-thesis-mini-line is-w2" />
      <span className="context-room-thesis-mini-line is-w3" />
      <span className="context-room-thesis-mini-page">1</span>
    </span>
  );
}

const SAMPLE_TITLE = '基于深度学习的×××研究';
const SAMPLE_PARAGRAPHS = [
  '本课题围绕×××展开研究。首先分析国内外研究现状，然后给出总体设计方案，最后通过实验验证方案的有效性。',
  '实验结果表明，所提出的方法在准确率与运行效率两方面均优于基线方案，达到了预期的设计目标。',
];

/** 大预览：封面页 + 正文页，按 mm/pt 真实比例换算（paperWidthPx 为纸宽像素）。 */
export function ThesisFullPaper({ card }: { card: ThesisCardView }) {
  const paperWidthPx = 460;
  const pxPerMm = paperWidthPx / card.widthMm;
  const ptToPx = (pt: number) => pt * 0.3528 * pxPerMm;
  const pageStyle = {
    width: paperWidthPx,
    height: Math.round(card.heightMm * pxPerMm),
    paddingTop: Math.round(card.marginTopMm * pxPerMm),
    paddingBottom: Math.round(card.marginBottomMm * pxPerMm),
    paddingLeft: Math.round(card.marginLeftMm * pxPerMm),
    paddingRight: Math.round(card.marginRightMm * pxPerMm),
  } as const;
  const bodyFont = {
    fontFamily: paperFont(card.eastAsia, card.ascii),
    fontSize: ptToPx(card.baseSizePt),
    lineHeight: card.lineSpacingMultiple,
  } as const;

  return (
    <div className="context-room-thesis-full-wrap">
      <section className="context-room-thesis-full-paper" style={pageStyle}>
        <div
          className="context-room-thesis-full-school"
          style={{
            fontFamily: paperFont(card.eastAsia, card.ascii),
            fontSize: ptToPx(card.schoolSizePt),
            fontWeight: card.schoolBold ? 700 : 400,
          }}
        >
          {card.schoolName}
        </div>
        <div
          className="context-room-thesis-full-degree"
          style={{ ...bodyFont, fontSize: ptToPx(card.baseSizePt + 4) }}
        >
          {card.degreeLine}
        </div>
        <div className="context-room-thesis-full-fields">
          {card.coverFields.map((label) => (
            <span
              key={label}
              className="context-room-thesis-full-field"
              style={bodyFont}
            >
              <em>{label}</em>
              <u aria-hidden="true" />
            </span>
          ))}
        </div>
        <div className="context-room-thesis-full-year" style={bodyFont}>{card.yearLine}</div>
        {card.footerLine ? (
          <div className="context-room-thesis-full-cover-footer" style={bodyFont}>{card.footerLine}</div>
        ) : null}
      </section>
      <section className="context-room-thesis-full-paper" style={pageStyle}>
        {card.headerEnabled ? (
          <header
            className="context-room-thesis-full-header"
            style={{
              ...bodyFont,
              borderBottom: card.headerUnderline ? '1px solid currentColor' : undefined,
            }}
          >
            {card.headerTemplate.replace('{title}', SAMPLE_TITLE)}
          </header>
        ) : null}
        <h3
          className="context-room-thesis-full-h1"
          style={{
            fontFamily: paperFont(card.h1.eastAsia, card.h1.ascii),
            fontSize: ptToPx(card.h1.sizePt),
            fontWeight: card.h1.bold ? 700 : 400,
            textAlign: card.h1.align === 'left' ? 'left' : 'center',
          }}
        >
          第一章&nbsp;&nbsp;绪论
        </h3>
        {SAMPLE_PARAGRAPHS.map((paragraph, index) => (
          <p
            key={index}
            className="context-room-thesis-full-para"
            style={{ ...bodyFont, textIndent: `${card.firstLineIndentChars}em` }}
          >
            {paragraph}
          </p>
        ))}
        <footer className="context-room-thesis-full-footer" style={bodyFont}>1</footer>
      </section>
    </div>
  );
}
