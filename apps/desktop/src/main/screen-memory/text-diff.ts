// 屏幕记忆去重判据：文本差异为主（定案 2026-10-12）。
// 行级归一化 + 相似度阈值，时钟/时间戳样式的易变行不参与差异判定。

const VOLATILE_LINE_PATTERNS: RegExp[] = [
  /^\d{1,2}:\d{2}(:\d{2})?$/,                                     // 14:23 / 14:23:45
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/, // 2026-10-12 / 2026.10.12 14:30
  /^(上午|下午|早上|晚上|凌晨)?\s*\d{1,2}:\d{2}$/,                   // 下午 3:05
  /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
]

export const LINE_SIMILARITY_THRESHOLD = 0.9

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, '').toLowerCase()
}

export function isVolatileLine(line: string): boolean {
  const normalized = line.trim()
  if (normalized.length === 0) return true
  return VOLATILE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const left = normalizeLine(a)
  const right = normalizeLine(b)
  if (left === right) return 1
  const maxLen = Math.max(left.length, right.length)
  if (maxLen === 0) return 1
  const distance = editDistance(left, right)
  return 1 - distance / maxLen
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let previous = Array.from({ length: n + 1 }, (_, index) => index)
  let current = new Array<number>(n + 1)
  for (let i = 1; i <= m; i += 1) {
    current[0] = i
    for (let j = 1; j <= n; j += 1) {
      const substitutionCost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + substitutionCost,
      )
    }
    ;[previous, current] = [current, previous]
  }
  return previous[n]!
}

export interface TextDiffDecision {
  changed: boolean
  stableLines: string[]
  newLines: string[]
}

/**
 * 判定新关键帧文本相对上一关键帧是否构成内容变化。
 * 规则：稳定行（非易变）里存在「既不与旧行相似、也不被旧行集合吸收」的行即视为变化；
 * newLines 返回本次新增的稳定行（原样大小写），供区间文本并集使用。
 */
export function diffKeyframeText(previousStableLines: string[], nextLines: string[]): TextDiffDecision {
  const normalizedPrevious = new Set(previousStableLines.map((line) => normalizeLine(line)))
  const newLines: string[] = []
  for (const line of nextLines) {
    if (isVolatileLine(line)) continue
    const normalized = normalizeLine(line)
    if (normalized.length === 0) continue
    if (normalizedPrevious.has(normalized)) continue
    const absorbed = previousStableLines.some(
      (oldLine) => lineSimilarity(oldLine, line) >= LINE_SIMILARITY_THRESHOLD,
    )
    if (!absorbed) newLines.push(line)
  }
  return { changed: newLines.length > 0, stableLines: nextLines.filter((line) => !isVolatileLine(line)), newLines }
}
