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
