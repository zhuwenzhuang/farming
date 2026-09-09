import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import { remarkStreamingContent, hasClosingCodeFence, richContentPhase } from '../../src/lib/streaming-markdown'
import { rehypeGuardInvalidKatex } from '../../src/lib/markdown-preview-compatibility'
import { createMermaidRenderer } from '../../src/lib/mermaid-renderer'

async function main() {
  for (const raw of ['```mermaid\nA --> B\n```', '~~~~mermaid\nA --> B\n~~~~~', '```mermaid\nA --> B\n> ```']) assert(hasClosingCodeFence(raw))
  for (const raw of ['```mermaid', '```mermaid\nA --> B', '````mermaid\nA --> B\n```', '```mermaid\nA --> B\n~~~']) assert(!hasClosingCodeFence(raw))
  for (const prefix of ['', '> ', '- ']) {
    const raw = `${prefix}\`\`\`mermaid\n${prefix === '> ' ? '> ' : prefix === '- ' ? '  ' : ''}A["unfinished`
    const processor = unified().use(remarkParse).use(remarkStreamingContent, { phase: 'streaming' })
    const tree = await processor.run(processor.parse(raw), { value: raw })
    assert(JSON.stringify(tree).includes('data-content-pending'), `nested unclosed fence: ${prefix}`)
  }
  const render = (source: string, pending: boolean) => renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source, remarkPlugins: [remarkMath], rehypePlugins: [[rehypeGuardInvalidKatex, { pending }], rehypeKatex],
  }))
  assert(render('$$\n\\frac{a', true).includes('data-math-pending'))
  assert(!render('$$\n\\frac{a', true).includes('ParseError'))
  assert(render('$$\n\\frac{a', false).includes('data-math-error'))
  assert(render('$$\n\\frac{a}{b}\n$$', true).includes('katex-mathml'))
  assert.equal(richContentPhase('inProgress'), 'streaming')
  assert.equal(richContentPhase('interrupted'), 'interrupted')
  assert.equal(richContentPhase('completed'), 'settled')
  assert.equal(richContentPhase('completed', 'cancelled'), 'interrupted')
  assert.equal(richContentPhase('inProgress', 'cancelled'), 'streaming')

  // Configuration belongs to an entire render transaction, even when another
  // diagram is requested while the first parse is suspended.
  const order: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const renderDiagram = createMermaidRenderer(async () => ({
    initialize(config) { order.push(`init:${config?.theme}`) },
    async parse(source) { order.push(`parse:${source}`); if (source === 'first') await gate; return { diagramType: 'flowchart-v2', config: {} } },
    async render(id) { order.push(`render:${id}`); return { svg: `<svg id="${id}"/>`, diagramType: 'flowchart-v2' } },
  }))
  const first = renderDiagram('one', 'first', { theme: 'dark' }, () => true)
  let current = true
  const obsolete = renderDiagram('old', 'old', { theme: 'base' }, () => current).catch(() => {})
  const second = renderDiagram('two', 'second', { theme: 'base' }, () => true)
  current = false
  release()
  await Promise.all([first, obsolete, second])
  assert.deepEqual(order, ['init:dark', 'parse:first', 'render:one', 'init:base', 'parse:second', 'render:two'])
  console.log('streaming Markdown lifecycle and serialized rendering passed')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
