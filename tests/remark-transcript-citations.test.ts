import assert from 'node:assert/strict'
import test from 'node:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import { remarkTranscriptCitations } from '../src/lib/remark-transcript-citations'

const parser = unified().use(remarkParse).use(remarkTranscriptCitations)
const citation = '\uE200cite\uE202turn944082view0\uE201'
function nodes(tree: Root | RootContent): (Root | RootContent)[] {
  return [tree, ...('children' in tree ? tree.children.flatMap(nodes) : [])]
}
async function render(source: string) {
  return nodes(await parser.run(parser.parse(source)))
}

test('hides unresolved turn944082view0 without inventing sources or changing Markdown links', async () => {
  const source = `Answer.${citation} See [the source](https://example.com/source).\n\n**More.${citation}**`
  const tree = await render(source)
  assert.equal(tree.filter(node => node.type === 'text').map(node => node.value).join(''), 'Answer. See the source.More.')
  assert.deepEqual(tree.filter(node => node.type === 'link').map(node => node.url), ['https://example.com/source'])
  assert.ok(source.includes(citation), 'stored source stays unchanged')
})

test('does not flash citation syntax at any streaming chunk boundary', async () => {
  for (let length = 1; length <= citation.length; length++) {
    const tree = await render(`Answer.${citation.slice(0, length)}`)
    assert.equal(tree.filter(node => node.type === 'text').map(node => node.value).join(''), 'Answer.', `prefix ${length}`)
  }
  const tree = await render(`Answer.${citation} Next.`)
  assert.equal(tree.filter(node => node.type === 'text').map(node => node.value).join(''), 'Answer. Next.')
})

test('retains literal code, including unfinished fences, and unrelated private directives', async () => {
  for (const source of [`\`${citation}\``, `\`\`\`text\n${citation}\n\`\`\``, `\`\`\`text\n${citation}`]) {
    const tree = await render(source)
    assert.equal(tree.filter(node => node.type === 'code' || node.type === 'inlineCode')[0]?.value, citation)
  }
  const source = '\uE200other\uE202value\uE201 and cite turn944082view0'
  assert.equal((await render(source)).filter(node => node.type === 'text').map(node => node.value).join(''), source)
})

test('handles multiple references without swallowing surrounding prose', async () => {
  const source = `One.\uE200cite\uE202turn1search0\uE202turn2view0\uE201 Two.${citation}`
  assert.equal((await render(source)).filter(node => node.type === 'text').map(node => node.value).join(''), 'One. Two.')
})
