import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  isWorkspaceMarkdownFile,
  workspaceEditorSurfaceState,
} from '../src/lib/workspace-editor-model'
import {
  workspaceFileSupportsViewer,
  workspaceFileViewerContributions,
} from '../src/lib/workspace-viewer-registry'
import { decodeMermaidCharacterReferences } from '../src/lib/mermaid-source'
import { splitLargeMarkdownSections } from '../src/lib/large-markdown-sections'
import {
  normalizeMarkdownPreviewSource,
  rehypeGuardInvalidKatex,
  remarkMarkdownPreviewCompatibility,
} from '../src/lib/markdown-preview-compatibility'
import { markdownTextContent, mermaidCodeBlockSource } from '../src/lib/react-markdown-content'

test('recognizes the supported Markdown file extensions through the viewer registry', () => {
  assert.equal(isWorkspaceMarkdownFile('README.md'), true)
  assert.equal(isWorkspaceMarkdownFile('docs/guide.MARKDOWN'), true)
  assert.equal(isWorkspaceMarkdownFile('notes/plan.mdown'), true)
  assert.equal(isWorkspaceMarkdownFile('src/main.ts'), false)
  assert.deepEqual(workspaceFileViewerContributions('docs/guide.mkd'), [{
    id: 'markdown.preview',
    extensions: ['.md', '.markdown', '.mdown', '.mkd'],
    renderMode: 'native',
  }])
  assert.equal(workspaceFileSupportsViewer('assets/logo.svg', 'markdown.preview'), false)
})

test('gives Markdown preview and split view the expected surface priority', () => {
  assert.deepEqual(workspaceEditorSurfaceState({
    diffOnly: false,
    diffOpen: false,
    markdownPreviewOpen: true,
    visualPreview: false,
  }), {
    showDiffView: false,
    showDiffOnlyPreview: false,
    showMarkdownSplit: false,
    showMarkdownPreview: true,
    showSourcePreview: false,
    showMonaco: false,
    showEditorOverlays: false,
  })

  assert.deepEqual(workspaceEditorSurfaceState({
    diffOnly: false,
    diffOpen: false,
    markdownPreviewOpen: true,
    markdownSplitOpen: true,
    visualPreview: false,
  }), {
    showDiffView: false,
    showDiffOnlyPreview: false,
    showMarkdownSplit: true,
    showMarkdownPreview: false,
    showSourcePreview: false,
    showMonaco: false,
    showEditorOverlays: true,
  })

  assert.deepEqual(workspaceEditorSurfaceState({
    diffOnly: false,
    diffOpen: true,
    markdownPreviewOpen: true,
    markdownSplitOpen: true,
    visualPreview: false,
  }), {
    showDiffView: true,
    showDiffOnlyPreview: false,
    showMarkdownSplit: false,
    showMarkdownPreview: false,
    showSourcePreview: false,
    showMonaco: false,
    showEditorOverlays: false,
  })
})

test('normalizes Mermaid source without changing unknown references or non-Mermaid code', () => {
  const mermaidCode = createElement('code', { className: 'language-mermaid' }, [
    'graph ',
    createElement('strong', { key: 'direction' }, 'TD'),
    '\n',
  ])

  assert.equal(decodeMermaidCharacterReferences('A[&quot;one &amp; two&#33;&quot;]'), 'A["one & two!"]')
  assert.equal(decodeMermaidCharacterReferences('A[&unknown; &amp;lt;]'), 'A[&unknown; &lt;]')
  assert.equal(markdownTextContent(mermaidCode), 'graph TD\n')
  assert.equal(mermaidCodeBlockSource(mermaidCode), 'graph TD')
  assert.equal(mermaidCodeBlockSource(createElement('code', { className: 'language-ts' }, 'const x = 1')), null)
})

test('segments large Markdown at real block boundaries with stable headings and references', () => {
  const source = [
    '# Repeated title',
    '',
    '```md',
    '## This fenced heading stays in the first section',
    '```',
    '',
    '[Shared reference][target]',
    '',
    '## Repeated title',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| one | two |',
    '',
    '$$',
    'x^2 + y^2',
    '$$',
    '',
    '[target]: https://example.com/reference',
  ].join('\n')

  const sections = splitLargeMarkdownSections(source, 40)
  assert.equal(sections.length, 2)
  assert.deepEqual(sections.map(section => section.headingIds), [
    ['repeated-title'],
    ['repeated-title-1'],
  ])
  assert.match(sections[0]?.source ?? '', /fenced heading/)
  assert.doesNotMatch(sections[0]?.source ?? '', /^## Repeated title$/m)
  assert.match(sections[0]?.renderSource ?? '', /\[target\]: https:\/\/example\.com\/reference/)
  assert.match(sections[1]?.source ?? '', /\| Column \| Value \|/)
  assert.match(sections[1]?.source ?? '', /x\^2 \+ y\^2/)
})

test('bounds heading-free large Markdown sections by top-level block count', () => {
  const source = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].join('\n\n')
  const sections = splitLargeMarkdownSections(source, 2)
  assert.equal(sections.length, 2)
  assert.match(sections[0]?.source ?? '', /First paragraph[\s\S]*Second paragraph/)
  assert.equal(sections[1]?.source.trim(), 'Third paragraph.')
})

test('never starts a bounded section inside list continuation indentation', () => {
  const source = [
    'First paragraph.',
    '',
    '- List item',
    '',
    '  continued list content',
    '',
    'Final paragraph.',
  ].join('\n')
  const sections = splitLargeMarkdownSections(source, 1)
  assert.equal(sections.length, 2)
  assert.match(sections[0]?.source ?? '', /List item[\s\S]*continued list content/)
  assert.equal(sections[1]?.source.trim(), 'Final paragraph.')
})

test('keeps protected Markdown content out of heading and definition discovery', () => {
  const source = [
    '# <https://example.test> &amp; B ![ignored](image.png)',
    '',
    '```md',
    'Fake setext title',
    '---',
    '[target]: https://example.com/wrong',
    '```',
    '',
    '[Shared reference][target]',
    '[shortcut]',
    '',
    'Setext title',
    '---',
    '',
    '[target]: https://example.com/right',
    '[shortcut]: https://example.com/shortcut',
  ].join('\n')

  const sections = splitLargeMarkdownSections(source, 2)
  assert.deepEqual(sections.flatMap(section => section.headingIds), ['httpsexampletest-b', 'setext-title'])
  assert.match(sections.find(section => section.source.includes('Shared reference'))?.renderSource ?? '', /example\.com\/right/)
  assert.doesNotMatch(sections.find(section => section.source.includes('Shared reference'))?.renderSource ?? '', /example\.com\/wrong/)
  assert.match(sections.find(section => section.source.includes('shortcut'))?.renderSource ?? '', /example\.com\/shortcut/)
})

test('keeps separator-rich large Markdown normalization linear and non-destructive', () => {
  const pattern = ['header', '--- ---', 'value'] as const
  const source = [
    'paragraph',
    ...Array.from({ length: 50_000 }, (_, index) => pattern[index % pattern.length]),
  ].join('\n')
  const startedAt = performance.now()
  const normalized = normalizeMarkdownPreviewSource(source)
  const elapsedMs = performance.now() - startedAt

  assert.equal(normalized, source)
  assert(elapsedMs < 1_000, `separator-rich Markdown normalization took ${elapsedMs.toFixed(1)}ms`)
})

test('normalizes Pandoc simple tables without changing fenced examples', () => {
  const source = [
    '  策略                   键：固定   键：动态（手动）                                        键：动态（工作负载）',
    '  ---------------------- ---------- ------------------------------------------------------- -----------------------------------------------------',
    '  全表                   遗留系统                                                           Qd-tree',
    '  新数据                            Iceberg、Delta Lake                                  Databricks',
    '',
    '    步骤 操作',
    '  ------ ---------------------------------------------------------------------------------------------------',
    '       1 $Recluster(boundaries)$',
    '       2 **if** $|\\mathcal{P}| > 0$ **then**',
    '  ------ ---------------------------------------------------------------------------------------------------',
    '',
    '  -------   ------ ----------   -------',
    '       12   12        12             12',
    '      123   123       123           123',
    '  -------   ------ ----------   -------',
    'Table: Headerless values',
    '',
    '  Name    Value',
    '  ------  ------',
    '  first   second',
    '  ----------------',
    'Following paragraph',
    '',
    'Oxide      石英',
    '-------  ------',
    'SiO2        100',
    '',
    '-------------------------------------------------',
    '  Centered Header                 Default Header',
    '-----------                      --------------',
    '  First row                      remains multiline',
    '                                 continuation',
    '-------------------------------------------------',
    '',
    '```text',
    'Header One',
    '------ -----',
    'value  value',
    '```',
  ].join('\n')

  const normalized = normalizeMarkdownPreviewSource(source)
  assert.match(normalized, /\| 策略 \| 键：固定 \| 键：动态（手动） \| 键：动态（工作负载） \|/)
  assert.match(normalized, /\| 新数据 \|  \| Iceberg、Delta Lake \| Databricks \|/)
  assert.match(normalized, /\| 2 \| \*\*if\*\* \$\\vert\{\}\\mathcal\{P\}\\vert\{\} > 0\$ \*\*then\*\* \|/)
  assert.match(normalized, /\| ---: \| :--- \|\n\| 1 \| \$Recluster/)
  assert.doesNotMatch(normalized, /\| ------- \| ------ \| ---------- \| ------- \|/)
  assert.match(normalized, /\|  \|  \|  \|  \|\n\| ---: \| :--- \| :---: \| ---: \|\n\| 12 \| 12 \| 12 \| 12 \|/)
  assert.match(normalized, /\| 123 \| 123 \| 123 \| 123 \|\nTable: Headerless values/)
  assert.match(normalized, /\| first \| second \|\nFollowing paragraph/)
  assert.match(normalized, /\| Oxide \| 石英 \|\n\| :--- \| ---: \|\n\| SiO2 \| 100 \|/)
  assert.match(normalized, /Centered Header[\s\S]*-----------[\s\S]*continuation[\s\S]*-------------------------------------------------/)
  assert.match(normalized, /```text\nHeader One\n------ -----\nvalue  value\n```/)
})

test('renders Pandoc anchors and same-line display math without leaking compatibility syntax', () => {
  const source = normalizeMarkdownPreviewSource([
    '[]{#section-1}',
    '',
    '[]{#ref-1} [1] Reference',
    '',
    '$$\\phi(a,b) ≔ \\begin{cases}',
    '0 & a = b\\mspace{6mu}\\text{ or }a > b, \\\\',
    '1 & a \\ne b.',
    '\\end{cases}$$',
    '',
    '$$',
    'a\\mspace{6mu}b',
    '$$',
    '',
    'Inline $a\\mspace{3mu}b$.',
  ].join('\n'))
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkMarkdownPreviewCompatibility],
    rehypePlugins: [rehypeGuardInvalidKatex, rehypeKatex],
  }, source))

  assert.match(html, /id="section-1"/)
  assert.match(html, /id="ref-1"/)
  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /\[\]\{#|katex-error|code-markdown-math-error|undefined|\\mspace/)
})

test('keeps unmatched display math fences from consuming the remaining document', () => {
  for (const fence of ['$$\na + b', '$$a + b']) {
    const source = normalizeMarkdownPreviewSource([
      'Before',
      '',
      fence,
      '',
      'After',
    ].join('\n'))
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkMath, remarkMarkdownPreviewCompatibility],
      rehypePlugins: [rehypeGuardInvalidKatex, rehypeKatex],
    }, source))

    assert.match(html, /Before/)
    assert.match(html, /\$\$/)
    assert.match(html, /a \+ b/)
    assert.match(html, /After/)
    assert.doesNotMatch(html, /katex-display/)
  }
})

test('does not normalize Pandoc math commands inside code', () => {
  const source = normalizeMarkdownPreviewSource([
    '```tex',
    '$$a\\mspace{6mu}b$$',
    '```',
    '',
    '`$a\\mspace{3mu}b$`',
  ].join('\n'))
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkMarkdownPreviewCompatibility],
    rehypePlugins: [rehypeGuardInvalidKatex, rehypeKatex],
  }, source))

  assert.match(html, /\\mspace\{6mu\}/)
  assert.match(html, /\\mspace\{3mu\}/)
  assert.doesNotMatch(html, /class="katex/)
})

test('keeps invalid KaTeX readable as source instead of rendering undefined', () => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath, remarkMarkdownPreviewCompatibility],
    rehypePlugins: [rehypeGuardInvalidKatex, rehypeKatex],
  }, '$\\notARealKatexCommand{value}$'))

  assert.match(html, /code-markdown-math-error/)
  assert.match(html, /\\notARealKatexCommand\{value\}/)
  assert.doesNotMatch(html, /katex-error|>undefined</)
})
