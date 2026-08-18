import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
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
