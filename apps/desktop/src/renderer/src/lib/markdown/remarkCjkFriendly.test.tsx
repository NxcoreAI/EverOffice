import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkCjkFriendly } from './remarkCjkFriendly'

/** 与 AgentChatView 等入口一致的渲染管线（components 不影响 emphasis 判定，省略）。 */
function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{markdown}</ReactMarkdown>,
  )
}

describe('remarkCjkFriendly：CJK 邻接的 emphasis 修复', () => {
  it('真实案例：全角括号结尾的加粗后紧跟汉字，重建为 strong', () => {
    // 该文本在无插件时整段按字面输出（** 原样显示），是「上班人格」工作空间渲染异常的原样复现。
    const html = render('**Super Agent（超级智能体）**指一种跨会话保持记忆的形态。')
    expect(html).toContain('<strong>Super Agent（超级智能体）</strong>')
    expect(html).not.toContain('**')
  })

  it('各类全角标点结尾 + 紧跟汉字：全部修复', () => {
    for (const punct of ['。', '！', '、', '；', '？', '》', '”', '』', '—', '…', '：']) {
      const html = render(`**结论${punct}**后续文字`)
      expect(html.includes(`<strong>结论${punct}</strong>`)).toBe(true)
    }
  })

  it('镜像场景：汉字后紧跟 **，内部以全角标点开头（左侧侧翼失败）', () => {
    const html = render('中文**（注释）**后文')
    expect(html).toContain('中文<strong>（注释）</strong>后文')
  })

  it('斜体与 GFM 删除线同样修复', () => {
    expect(render('*注意：*后面的文字')).toContain('<em>注意：</em>')
    expect(render('~~删除说明）~~后续')).toContain('<del>删除说明）</del>')
  })

  it('正文中的普通强调不受影响', () => {
    const html = render('普通 **加粗**、*斜体* 与 ~~删除~~ 混排。')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<em>斜体</em>')
    expect(html).toContain('<del>删除</del>')
  })

  it('标题与表格单元格内同样生效', () => {
    expect(render('## 标题 **X）**指')).toContain('<strong>X）</strong>')
    const table = render('| 列 **X）**指 |\n| --- |\n| 值 |')
    expect(table).toContain('<strong>X）</strong>')
  })

  it('同一段落多处命中一并修复', () => {
    const html = render('先说 **第一点）**然后，再说 **第二点）**结束。')
    expect(html).toContain('<strong>第一点）</strong>')
    expect(html).toContain('<strong>第二点）</strong>')
    expect(html).not.toContain('**')
  })
})

describe('remarkCjkFriendly：不干预的场景', () => {
  it('行内代码与代码块中的星号原样保留', () => {
    expect(render('行内 `**X）**指` 代码')).toContain('<code>**X）**指</code>')
    const fenced = render('```\n**X）**指\n```')
    expect(fenced).toContain('**X）**指')
  })

  it('转义星号不被当作强调', () => {
    const html = render('转义 \\*\\*不是加粗\\*\\* 完')
    expect(html).toContain('**不是加粗**')
    expect(html).not.toContain('<strong>')
  })

  it('纯英文文本（无 CJK 邻接）保持规范行为不干预', () => {
    // CommonMark 对该输入本就拒绝加粗（点号结尾+紧跟字母），无 CJK 时不修复，与 GitHub 一致。
    const html = render('**word.**tail no cjk')
    expect(html).toContain('**word.**tail')
  })

  it('列表项、引用内正常渲染不受影响', () => {
    const html = render('- 列表项 **加粗** 正常\n\n> 引用 **X）**指 也修复')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<strong>X）</strong>')
  })

  it('链接文本与 URL 不受干扰', () => {
    const html = render('见 [**说明）**详情](https://example.com/a) 链接')
    expect(html).toContain('<a href="https://example.com/a">')
    expect(html).toContain('<strong>说明）</strong>')
  })

  it('普通中文文本零改动', () => {
    const html = render('完全普通的中文段落，没有任何标记。')
    expect(html).toBe('<p>完全普通的中文段落，没有任何标记。</p>')
  })
})
