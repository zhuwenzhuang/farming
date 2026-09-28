import assert from 'node:assert/strict'
import test from 'node:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Root, RootContent } from 'mdast'
import { remarkChineseStrong } from '../src/lib/remark-chinese-strong'
import { remarkStreamingContent } from '../src/lib/streaming-markdown'

const standard = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const compatible = standard().use(remarkChineseStrong)
function nodes(tree: Root | RootContent): (Root | RootContent)[] {
  return [tree, ...('children' in tree ? tree.children.flatMap(nodes) : [])]
}
function strong(source: string) {
  return nodes(compatible.parse(source)).filter(node => node.type === 'strong')
}
for (const source of [
  '**不会越重试越高。**判断的是 attempt 类型。',
  '**不会跨越 stage 的顺序。**NaturalOrder 保留档位。',
  '这是**“重点”**然后继续。',
  '这是**（重点）**然后继续。',
  '这是**「重点」**然后继续。',
  '前文**注意：**后文',
  '提示，**正常加粗**继续。',
]) {
  test(`Chinese punctuation permits paired strong: ${source}`, () => {
    assert.equal(strong(source).length, 1)
    assert.equal(nodes(compatible.parse(source)).filter(node => node.type === 'text').some(node => node.value.includes('**')), false)
  })
}
for (const source of [
  '`**中文。**正文`',
  '```md\n**中文。**正文\n```',
  '    **中文。**正文',
  '\\*\\*中文。\\*\\*正文',
  '**中文。\\*\\*正文',
  '**中文。 **正文',
  '** 中文。**正文',
  '**中文。',
  '**开头\n\n结尾。**正文',
  '[链接](https://example.com/**中文。**正文)',
  '***中文。***正文',
  '*中文。*正文',
  '__中文。__正文',
  '**English.**followed',
  'a**(English)**b',
  '<span title="**中文。**正文">',
  '$**中文。**正文$',
  '**ordinary** and *emphasis* and ~~deleted~~',
  '***nested***',
  '---\n\n****',
]) {
  test(`preserves standard parsing: ${source}`, () => {
    assert.deepEqual(compatible.parse(source), standard.parse(source))
  })
}
test('keeps nested inline content, link destinations, positions and separate pairs', () => {
  const source = '**用 `code` 和 [链接](https://example.com/a**b)，强调 *内容*。**继续。**第二句！**结束'
  const tree = compatible.parse(source)
  assert.equal(strong(source).length, 2)
  for (const type of ['inlineCode', 'link', 'emphasis']) {
    assert.equal(nodes(tree).filter(node => node.type === type).length, 1)
  }
  const first = strong(source)[0]!
  assert.equal(source.slice(first.position!.start.offset, first.position!.end.offset), '**用 `code` 和 [链接](https://example.com/a**b)，强调 *内容*。**')
})
test('streaming prefixes never synthesize closing stars and complete pairs survive following text', async () => {
  const source = '**不会越重试越高。**判断的是 attempt 类型。'
  const close = source.indexOf('**', 2) + 2
  for (const phase of ['streaming', 'settled', 'interrupted'] as const) {
    const parser = compatible().use(remarkStreamingContent, { phase })
    for (let end = 1; end <= source.length; end++) {
      const value = source.slice(0, end)
      const tree = await parser.run(parser.parse(value), { value })
      assert.equal(nodes(tree).filter(node => node.type === 'strong').length, end >= close ? 1 : 0, `${phase}: ${value}`)
    }
  }
})

test('image alt text follows normal emphasis stripping without changing its destination', () => {
  const node = nodes(compatible.parse('![**中文。**正文](image.png)')).find(node => node.type === 'image')
  assert.equal(node?.type, 'image')
  if (node?.type === 'image') {
    assert.equal(node.alt, '中文。正文')
    assert.equal(node.url, 'image.png')
  }
})
