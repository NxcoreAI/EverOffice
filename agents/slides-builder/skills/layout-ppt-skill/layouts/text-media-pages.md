---
name: text-media-pages
description: 文字与图文页预设字段说明：封面 P1a/b/c、大图压字 P2、章节 P3、目录 P4、引用 P5、半图半卡 P6、双栏图文 P7、履历 P8、封底 P9。填封面/章节/图文页前必读。
---

# 文字与图文页预设（二级）

## P1 封面（a/b/c 三选一）

封面必须有一个视觉锚点（由预设保证：深底/大色块/超大字）；封面只放身份信息（主标题、副标题、日期/机构行），不放参数规格、特性清单、KPI。

### P1a 深色大字封面（默认选它）

```json
{"id":"P1a","eyebrow":"PROJECT PROPOSAL · 2026","title":"主标题","subtitle":"副标题","ghostText":"背景大字"}
```

全页深色底；左对齐文字组垂直居中。`ghostText` 可选（≤4 字的背景层次大字，只此一个）。

### P1b 大色块封面

```json
{"id":"P1b","eyebrow":"…","title":"主标题","subtitle":"…","band":"right"}
```

`band`："right"（右侧竖向色带，缺省）或 "bottom"（下半横带）；主标题在色块内白字。

### P1c 超大字白底封面

```json
{"id":"P1c","eyebrow":"…","title":"主标题","subtitle":"…"}
```

白底、超大字即锚点；仅当风格本身是白底大留白系才用。

## P2 大图压字愿景页

```json
{"id":"P2","image":{"url":"https://…","fit":"cover"},"claim":"一句主张","sub":"副句"}
```

全幅大图 + 自动深色遮罩 + 居中白字两行。每篇大图页（P2/P9）合计 ≤3。

## P3 深色章节页

```json
{"id":"P3","sectionNo":"02","title":"章节标题","subtitle":"一行副句"}
```

全页深底居中大字；`sectionNo` 可选（背景超大序号）。每篇 ≤2。

## P4 目录页

```json
{"id":"P4","heading":"目录","tagline":"可选主线副题","items":["第一部分","第二部分","第三部分","第四部分"]}
```

`items` 4~6 条，左侧「目录」大字 + 右侧编号条目行。

## P5 大引用页

```json
{"id":"P5","quote":"金句正文（最多三行）","author":"人名","role":"头衔"}
```

大引号锚点 + 引言 + 右对齐署名；背景纯色无装饰。

## P6 半图半卡痛点页

```json
{"id":"P6","title":"行动标题","image":{"url":"…","fit":"cover"},"ratio":"62/38","imageSide":"left","cards":[{"icon":"bolt","title":"痛点小标题","body":"两行说明"},×3]}
```

`cards` 恰好 3 张；`ratio` 可选 "62/38"（缺省，图重）/"50/50"/"38/62"（卡重）；`imageSide` 缺省 left。

## P7 双栏图文页

```json
{"id":"P7","title":"行动标题","image":{"url":"…","fit":"contain"},"ratio":"50/50","imageSide":"left","heading":"栏内小标题","body":"一段正文","bullets":["要点一","要点二"]}
```

`ratio` 可选 "50/50"（缺省）/"62/38"（图重）/"38/62"；`bullets` 可选 ≤4 条。图在左或在右按叙事定，相邻页交替。产品图等主体必须完整的图传 `fit:"contain"`。

## P8 履历/竖轴页

```json
{"id":"P8","title":"…","entries":[{"period":"2019-2021","title":"节点标题","body":"两三行正文"},×3~4],"highlight":{"title":"右侧大引言/核心成就","body":"支撑说明"}}
```

左列竖向节点轴，右列大引言区。

## P9 封底联系页

```json
{"id":"P9","logoText":"品牌名","slogan":"一句话口号","contacts":[{"icon":"envelope","text":"hello@example.com"},…≤4],"image":{"url":"…"}}
```

左侧品牌/口号/联系方式，右侧大图压满（无图时右侧为大色块）。
