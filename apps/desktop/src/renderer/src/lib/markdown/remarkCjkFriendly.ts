/**
 * remark CJK 友好化插件：修复 CommonMark 侧翼（flanking）规则对中文的误伤。
 *
 * 背景：CommonMark 0.30+ 要求 emphasis 闭合定界符满足「右侧侧翼」——
 * 前面不是空白，且（前面不是标点 或 后面是空白/标点）。中文加粗常以全角标点
 * （）、。：等）结尾，且闭合 ** 后紧跟汉字（中文不加空格），两个条件同时不满足，
 * 整个加粗失效、星号原样输出。镜像情况（开头的 ** 前是汉字、后是全角标点）同理。
 *
 * 策略：解析后的 mdast 上重建。代码块/行内代码是独立节点天然免疫；文本里
 * 字面成对的 **…** / *…* / ~~…~~ 若符合「CJK 邻接导致的侧翼失败」特征，重建成
 * strong/emphasis/delete 节点。无 CJK 参与的文本（纯英文习惯）不干预，
 * 保持与 GitHub 等规范渲染器一致。
 *
 * 保守边界：跨节点拆散的定界符（如外层 ** 内已解析出子强调）不处理；
 * 用 `\*` 转义的星号不处理（其 text 节点 value 相同，但源码含反斜杠——本插件
 * 只按 CommonMark 拒绝侧翼的特征判定，转义场景不满足该特征，天然跳过）。
 */

import type { Options as ReactMarkdownOptions } from 'react-markdown'

// 最小结构类型：不引入 mdast/unified 类型依赖（本包未直接声明这两个依赖）。
// 插件运行时拿到的是完整 mdast 节点，这里只声明用到的字段。
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/** CJK 字符与全角区（含谚文、注音、CJK 标点、全角 ASCII、半角片假名等）。 */
const CJK_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
/** Unicode 标点或符号（与 micromark-util-character 的 unicodePunctuation 同口径）。 */
const PUNCT_RE = /\p{P}|\p{S}/u
/** CommonMark 定义的 Unicode 空白。 */
const WS_RE = /\s/u

const isPunct = (ch: string | undefined): boolean => ch !== undefined && PUNCT_RE.test(ch)
const isWhitespace = (ch: string | undefined): boolean => ch === undefined || WS_RE.test(ch)
const touchesCjk = (chars: Array<string | undefined>): boolean =>
  chars.some((ch) => ch !== undefined && CJK_RE.test(ch))

/** 可重建的定界符对：正则 + 重建出的 mdast 节点类型。~~ 先于 ** 先于 *（长的优先）。 */
const DELIMITERS: ReadonlyArray<{ re: RegExp; nodeType: 'delete' | 'strong' | 'emphasis' }> = [
  { re: /~~([^~\n]+?)~~/g, nodeType: 'delete' },
  { re: /\*\*([^*\n]+?)\*\*/g, nodeType: 'strong' },
  { re: /\*([^*\n]+?)\*/g, nodeType: 'emphasis' },
]

/**
 * 单个 text 值内的重建。返回 null 表示无 CJK 侧翼失败、保持原样；
 * 否则返回替代该 text 节点的子节点序列。
 */
function rebuildTextValue(value: string): MdNode[] | null {
  let pieces: MdNode[] = [{ type: 'text', value }]
  let changed = false

  for (const { re, nodeType } of DELIMITERS) {
    const next: MdNode[] = []
    for (const piece of pieces) {
      if (piece.type !== 'text' || piece.value === undefined) {
        next.push(piece)
        continue
      }
      const rebuilt = splitOneDelimiter(piece.value, re, nodeType)
      if (rebuilt) {
        changed = true
        next.push(...rebuilt)
      } else {
        next.push(piece)
      }
    }
    pieces = next
  }

  return changed ? pieces : null
}

/** 在单个 text 值里按定界符正则扫描，重建立场命中（CJK 邻接侧翼失败）的对。 */
function splitOneDelimiter(value: string, re: RegExp, nodeType: 'strong' | 'emphasis' | 'delete'): MdNode[] | null {
  const out: MdNode[] = []
  let last = 0
  let changed = false
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(value)) !== null) {
    const inner = m[1]!
    const before = m.index === 0 ? undefined : value[m.index - 1]!
    const after = value[m.index + m[0].length]!
    // 闭合侧失败：内部末字符是标点，且闭合定界符后是字母/数字（非空白非标点）。
    const closingFail = isPunct(inner.slice(-1)) && !isWhitespace(after) && !isPunct(after)
    // 开启侧失败（镜像）：开启定界符前是字母/数字，且内部首字符是标点。
    const openingFail = !isWhitespace(before) && !isPunct(before) && isPunct(inner.slice(0, 1))
    const cjkInvolved = touchesCjk([before, after, inner.slice(-1), inner.slice(0, 1)])
    if ((closingFail || openingFail) && cjkInvolved) {
      changed = true
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
      out.push({ type: nodeType, children: [{ type: 'text', value: inner }] })
      last = m.index + m[0].length
    }
  }
  if (!changed) return null
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

/** 行内容器：只有这些节点的直接 text 子节点参与重建（blockquote/列表项经由段落间接命中，
 *  link/emphasis/strong 等行内节点的 children 也是 phrasing content，一并纳入）。 */
const PHRASE_CONTAINERS = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'tableHeader',
  'link',
  'linkReference',
  'emphasis',
  'strong',
  'delete',
])

function rewriteInlineText(node: MdNode): void {
  const children = node.children
  if (children) for (const child of children) rewriteInlineText(child)
  if (!PHRASE_CONTAINERS.has(node.type) || !Array.isArray(children)) return

  const next: MdNode[] = []
  for (const child of children) {
    if (child.type === 'text' && child.value !== undefined) {
      const rebuilt = rebuildTextValue(child.value)
      if (rebuilt) next.push(...rebuilt)
      else next.push(child)
    } else {
      next.push(child)
    }
  }
  node.children = next
}

/** remark 插件：作为 remarkPlugins 一员传给 react-markdown，放在 remark-gfm 之后。 */
export const remarkCjkFriendly: NonNullable<ReactMarkdownOptions['remarkPlugins']>[number] =
  function remarkCjkFriendly() {
    return (tree: MdNode) => {
      rewriteInlineText(tree)
    }
  }
