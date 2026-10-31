# Word 操作区 → Agent 操作覆盖清单

> 目的：GenOffice Word 编辑器的**操作区（Ribbon/工具栏/命令入口）可以隐藏，只留正文画布**；用户需要的一切文档操作由 EverRoom agent 完成。本文逐项对照「操作区入口 → agent 能力」。
> 相关：`docs/word-agent-editing-implementation.zh-CN.md`、`word-agent-test-prompts.md`
> 状态：2026-10-31，`word_agent_ops` 共 **58 个 op / 9 个域** + 原有 `word_agent_edit` 工具链。

## 1. 为什么隐藏操作区不影响能力

- Agent 的工具/op **不点击 Ribbon**，而是直接调用编辑器内部与按钮相同的命令/helper（`apply_commands`、`@tiptap/pm/tables`、ribbon 的 insert/format helper、review/references helper 等），一套实现、两个入口（UI 与 agent）。
- 干净画布模式只隐藏 chrome：Ribbon、状态栏、标尺、导航、页眉页脚浮动 chips；正文画布、查找/批注/比较面板、对话框保留。
- 恢复入口：右上角「显示工具栏」胶囊、`⌘⇧F`、宿主 `window.desktop.office.toggleChrome()`。
- 因此“隐藏操作区”不会降低 agent 能力；反过来，agent 的能力就是操作区能力的并集（下表）。

## 2. 覆盖对照

图例：✅ 已覆盖（agent 与 UI 同一实现）｜◐ 部分/有边界｜— 非目标或明确不支持（返回清晰错误，不伪造成功）

### 2.1 开始（Home）

| 操作区项 | Agent 能力 |
|---|---|
| 字体、字号、加粗/斜体/下划线/删除线、上下标、颜色、突出显示 | ✅ `apply_commands.updateTextStyle` |
| 增大/减小字号 | ✅ `updateTextStyle.sizeHalfPoints` |
| 清除格式 | ✅ `format.clear` |
| 更改大小写 | ✅ `format.changeCase` |
| 段落对齐、行距、段前段后、左/右/首行/悬挂缩进、底纹、边框、段前分页 | ✅ `apply_commands.updateParagraphStyle` |
| 文字方向 LTR/RTL | ✅ `format.setBidi` |
| 段落对话框的制表位/前导符 | ✅ `format.setTabStops` |
| 样式库（正文/标题1-3） | ✅ `format.applyStyle` |
| 字符样式卡（强调/Strong、文档字符样式） | ✅ `format.applyCharacterStyle` |
| 项目符号/编号库、自定义多级列表 | ✅ `format.applyListStyle`、`format.multilevelList` |
| 列表重新开始/继续编号 | ✅ `format.listRestart` / `format.listContinue` |
| 查找与替换（全部替换、忽略大小写） | ✅ `apply_commands.replaceAllText` |
| 整词匹配 / 只替换第一处 | ✅ `replaceAllText.wholeWord` / `replaceFirstOnly` |
| 剪切/复制/粘贴 | — 非目标；用 `insert_content`/`replace_blocks`/`moveBlocks` 语义覆盖 |

### 2.2 插入（Insert）

| 操作区项 | Agent 能力 |
|---|---|
| 插入表格（含自定义行列） | ✅ `table.insert` |
| 图片（本地/网络/生成） | ✅ `insert_image_base64 {path\|url\|base64}`、`word_agent_illustration` |
| 图表（柱/折线/饼）与改数据 | ✅ `insert_chart` / `edit_chart` |
| 形状（预设图形/线条） | ✅ `insert_shape`、`object.shape.format` |
| 文本框 / WordArt / 首字下沉 | ✅ `object.textbox.insert` / `object.wordArt.insert` / `object.dropCap` |
| 公式插入 | ✅ `insert_content` 的 `<formula>` 或 `object.equation.insert` |
| 公式再编辑 | ✅ `object.equation.update`（原位更新，不新增） |
| 符号 / 不间断空格等 | ✅ `object.symbol.insert` |
| 页眉页脚（文字、页码、首页不同/奇偶页） | ✅ `set_header_footer` |
| 页码格式与起始页 | ✅ `page.numberFormat` |
| 域（PAGE/NUMPAGES/DATE/TIME/FILENAME）与 F9 刷新 | ✅ `field.insert` / `field.updateAll` |
| 超链接/书签/交叉引用 | ✅ `insert_content` 的 `<a>` / `reference.bookmark.insert` / `reference.crossRef.insert` |
| 分页符 / 空白页 / 封面 | ✅ `page.break` / `page.blank` / `page.cover` |
| 换行符 / 分栏符 | ✅ `format.insertBreak` |
| 页眉页脚内嵌图片 | — 明确不支持（需要宿主图片字节；后续可补） |

### 2.3 布局（Layout）与设计（Design）

| 操作区项 | Agent 能力 |
|---|---|
| 页边距、纸张大小、方向 | ✅ `set_page_setup` / `section.set` |
| 分栏（1-3 栏） | ✅ `set_page_setup.columns` / `section.set.columns` |
| 分节符（下一页/连续/奇数页/偶数页） | ✅ `section.break` |
| 按节页面设置 | ✅ `section.set {sectionIndex}` |
| 页面背景色、主题字体/主题色、主题预设 | ✅ `set_page_setup` / `section.set` |
| 水印（设置/移除） | ✅ `set_watermark` |
| 页面边框 | ✅ `page.borders` |

### 2.4 引用（References）

| 操作区项 | Agent 能力 |
|---|---|
| 目录插入/更新 | ✅ `apply_commands.insertToc` / `update_toc` |
| 脚注 / 尾注（插入/编辑/删除） | ✅ `notes.insert` / `notes.update` / `notes.delete` |
| 题注 | ✅ `reference.caption.insert` |
| 书签（增删） | ✅ `reference.bookmark.insert` / `reference.bookmark.remove` |
| 交叉引用 | ✅ `reference.crossRef.insert` |
| 文献来源、引用、参考文献表 | ✅ `reference.source.add` / `reference.citation.insert` / `reference.bibliography.insert` |
| 索引标记 / 插入索引 | ✅ `reference.index.mark` / `reference.index.insert` |
| 目录样式/级别配置 | — 当前 UI 未暴露独立入口；如需后续单独立项 |

### 2.5 审阅（Review）

| 操作区项 | Agent 能力 |
|---|---|
| 新建批注 / 回复 / 解决 / 删除 | ✅ `add_comment` / `reply_comment` / `resolve_comment` / `delete_comment` |
| 修订开关（track changes） | ✅ `review.trackChanges` |
| 接受/拒绝修订（单条按 `[rN]` / 全部） | ✅ `review.accept` / `review.reject`（必须 `confirm:true`） |
| 保护文档（只读/批注/表单等） | ✅ `review.protect`（必须 `confirm:true`；密码不回显） |
| 文档加密/取消密码 | ✅ `review.encrypt`（必须 `confirm:true`；密码不回显） |
| 文档比较（Compare） | — 明确不支持（跨文件比较，后续单独立项） |

### 2.6 表格上下文 / 图片格式

| 操作区项 | Agent 能力 |
|---|---|
| 插入/删除行列、删除表格、合并/拆分单元格 | ✅ `table.insertRow/deleteRow/insertColumn/deleteColumn/delete/mergeCells/splitCell` |
| 单元格内容、底纹、边框、垂直对齐、宽度 | ✅ `table.setCell` |
| 表格对齐、缩进、行高、列宽、边框、重复标题行、样式预设、look 选项 | ✅ `table.setProperties`（B5 增加 `look`） |
| AutoFit（窗口/内容/固定） | ✅ `table.autoFit` |
| 表格排序 | — UI 本身未实现（disabled） |
| 图片尺寸/对齐/环绕/位置/旋转/翻转/z-order | ✅ `object.image.format` |
| 图片替换 / 裁剪 / 去背景 | — 明确不支持（需要宿主图片字节/像素编辑；先用外部工具处理再 `insert_image_base64`，或插图+删旧块） |
| 导入形状的 z-order | ◐ 引擎限制：仅编辑器内创建的形状可重排 |

### 2.7 视图 / 绘图 / 文件

| 操作区项 | Agent 能力 |
|---|---|
| 缩放、标尺、导航、深色画布、阅读模式、分屏 | — 视图设置，不属于文档内容；干净画布下本来就被隐藏 |
| 手绘（钢笔/荧光笔/橡皮） | — 明确不支持；可插入图片替代 |
| 打印、导出 PDF | — 宿主级能力，不在 `word_agent_ops`（EverRoom 有独立导出入口） |
| 保存/另存为 | ✅ 保存由编辑器/宿主自动完成；agent 编辑后静默保存并回填版本链 |

## 3. 干净画布隐藏了哪些

`chrome-hidden` 时隐藏：`.ribbon`（全部 Tab/下拉/对话框入口）、`.status-bar`、`.nav-pane`、`.ruler`、`.hf-variant-chips`。
保留：正文画布与内联编辑、查找面板（⌘F）、批注/比较面板（用户主动打开时）、各类对话框。
恢复：右上角胶囊 / `⌘⇧F` / 宿主 toggle。

## 4. 已知限制汇总

1. 图片替换/裁剪/去背景、页眉页脚内嵌图片：需要宿主图片字节或像素操作，暂不支持。
2. 文档比较、打印/导出 PDF：跨文件/宿主级能力，未做成 op。
3. 手绘 ink：未支持，用图片替代。
4. 字符样式：两个内置预设（强调/Strong）+ 文档已有字符样式；不支持新建字符样式定义。
5. 整词替换的边界按 ASCII 字母/数字/下划线判定；CJK 没有词边界（文档内已注明）。
6. 公式再编辑只能在块级↔块级、行内↔行内原位更新，不能互相转换。
7. 导入形状的 z-order 不可改（原始锚点保留）。