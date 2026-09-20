import assert from 'node:assert/strict'
import test from 'node:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import type { Root, RootContent } from 'mdast'
import { remarkLiteralShellDollars } from '../src/lib/remark-literal-shell-dollars'

const parser = unified().use(remarkParse).use(remarkMath).use(remarkLiteralShellDollars)
function nodes(tree: Root | RootContent): (Root | RootContent)[] {
  return [tree, ...('children' in tree ? tree.children.flatMap(nodes) : [])]
}
for (const source of [
  '"$S/venv/bin/python" "$S/host_client.py" poll job-id',
  'Run "$HOME/bin/tool" then "$PATH".',
  'Run ${HOME}/bin/tool with ${VENV}/bin/python.',
  'Run $(pwd)/tool with $(pwd)/script.',
]) {
  test(`shell dollars remain literal: ${source}`, async () => {
    const tree = await parser.run(parser.parse(source), { value: source })
    assert.equal(nodes(tree).filter(node => node.type === 'inlineMath').length, 0)
    assert.equal(nodes(tree).filter(node => node.type === 'text').map(node => node.value).join(''), source)
  })
}
test('retains real inline/display math and fenced shell source', async () => {
  const source = '$x$ and $a/b$ and $K \\in [0,1]$\n\n$$\nE=mc^2\n$$\n\n`"$S/a" "$S/b"`'
  const tree = await parser.run(parser.parse(source), { value: source })
  assert.equal(nodes(tree).filter(node => node.type === 'inlineMath').length, 3)
  assert.equal(nodes(tree).filter(node => node.type === 'math').length, 1)
  assert.equal(nodes(tree).filter(node => node.type === 'inlineCode').length, 1)
})
