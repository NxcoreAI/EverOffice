/**
 * 分级答复标记的展示侧清洗（`[[details]]` 协议，与 gateway answer-tiering 同语义）。
 *
 * gateway 在 message.completed 落库/广播时才做分级解析（content=去标记全文，
 * displayContent=默认展示层），message.delta 流式增量原样透传——模型写出的
 * `[[details]]` 标记行会随 delta 累计留在 activity 的流式答案（finalAnswer/
 * pendingAnswer）与未完成 run 的消息 content 里，直接渲染就会把标记当正文
 * 显示（展开「查看详情」首行必现 `[[details]]`）。展示侧在"流式原文变成
 * 最终展示文本"的入口统一清洗。
 *
 * 语义与 gateway splitAgentAnswer 对齐：只移除第一个独立成行的标记，标记
 * 前后拼接成一个空行（与落库 content 同形）；行内出现的标记词、第二次及
 * 之后的标记行都视为正文，不动。
 */

/** 标记行：允许前后空白（含 CRLF 残留的 \r），行内不允许其他字符。 */
const DETAILS_MARKER_LINE = /^\s*\[\[details\]\]\s*$/

/**
 * 去掉第一个独立成行的 `[[details]]` 标记行；无标记时原样返回（零分配，
 * 历史消息每帧重渲也不产生额外开销）。
 */
export function stripAgentAnswerMarker(raw: string): string {
  if (!raw.includes("[[details]]")) return raw
  const lines = raw.split("\n")
  const markerIndex = lines.findIndex((line) => DETAILS_MARKER_LINE.test(line))
  if (markerIndex === -1) return raw
  const before = lines.slice(0, markerIndex).join("\n").trimEnd()
  const after = lines.slice(markerIndex + 1).join("\n").replace(/^\s*\n?/, "").trimStart()
  return after ? `${before}\n\n${after}` : before
}
