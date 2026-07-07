const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const packageSource = read('package.json');
  const editorModelSource = read('src/lib/workspace-editor-model.ts');
  const editorPaneSource = read('src/components/files/FileEditorPane.tsx');
  const editorHeaderSource = read('src/components/files/FileEditorHeader.tsx');
  const editorActionsSource = read('src/components/files/FileEditorActions.tsx');
  const editorSurfaceSource = read('src/components/files/FileEditorSurface.tsx');
  const markdownPreviewSource = read('src/components/files/FileEditorMarkdownPreview.tsx');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');
  const darkStylesSource = read('src/styles/code-dark.css');

  assert(
    packageSource.includes('"react-markdown"') &&
      packageSource.includes('"remark-gfm"') &&
      packageSource.includes('"remark-math"') &&
      packageSource.includes('"rehype-katex"') &&
      packageSource.includes('"rehype-highlight"') &&
      packageSource.includes('"katex"') &&
      packageSource.includes('"yaml"') &&
      packageSource.includes('"mermaid"'),
    'Markdown preview should use mature React Markdown/GFM/math/highlight/front-matter rendering dependencies and Mermaid diagrams'
  );

  assert(
    editorModelSource.includes('function isWorkspaceMarkdownFile') &&
      editorModelSource.includes("'.markdown'") &&
      editorModelSource.includes('markdownPreviewOpen?: boolean') &&
      editorModelSource.includes('showMarkdownPreview: boolean') &&
      editorModelSource.includes('const showMarkdownPreview = Boolean(options.markdownPreviewOpen)') &&
      editorModelSource.includes('&& !showDiffView && !showDiffOnlyPreview') &&
      editorModelSource.includes('canPreviewMarkdown?: boolean'),
    'Editor model should keep Markdown recognition and preview/diff priority in shared state helpers'
  );

  assert(
    editorPaneSource.includes('isWorkspaceMarkdownFile(openFile.file.path)') &&
      editorPaneSource.includes('markdownPreviewByFileKey') &&
      editorPaneSource.includes('workspaceEditorModelKey(openFile)') &&
      editorPaneSource.includes('markdownPreviewOpen={markdownPreviewOpen}') &&
      editorPaneSource.includes('canPreviewMarkdown={canPreviewMarkdown}') &&
      editorPaneSource.includes('onToggleMarkdownPreview={toggleMarkdownPreview}'),
    'FileEditorPane should store Markdown preview as per-open-file frontend view state'
  );

  assert(
    editorHeaderSource.includes('canPreviewMarkdown') &&
      editorHeaderSource.includes('onToggleMarkdownPreview') &&
      editorHeaderSource.includes('markdownPreviewOpen') &&
      editorActionsSource.includes('{actions.showMarkdownPreview && (') &&
      editorActionsSource.includes('code-file-editor-action markdown-preview') &&
      editorActionsSource.includes('function MarkdownPreviewIcon') &&
      editorActionsSource.includes('className="code-file-editor-action-svg"') &&
      editorActionsSource.includes('copy.showMarkdownSource : copy.openMarkdownPreview'),
    'Editor header actions should expose a Markdown source/preview toggle only when the model allows it'
  );

  assert(
    editorSurfaceSource.includes('<FileEditorMarkdownPreview') &&
      editorSurfaceSource.includes('surface.showMarkdownPreview') &&
      editorSurfaceSource.includes('markdownPreviewOpen,') &&
      markdownPreviewSource.includes('ReactMarkdown') &&
      markdownPreviewSource.includes('remarkGfm') &&
      markdownPreviewSource.includes('remarkMath') &&
      markdownPreviewSource.includes('rehypeKatex') &&
      markdownPreviewSource.includes('rehypeHighlight') &&
      markdownPreviewSource.includes("parse as parseYaml") &&
      markdownPreviewSource.includes("import 'katex/dist/katex.min.css'") &&
      markdownPreviewSource.includes('createHeadingIdFactory') &&
      markdownPreviewSource.includes('MarkdownFrontMatterTable') &&
      markdownPreviewSource.includes('code-markdown-heading-anchor') &&
      markdownPreviewSource.includes('data-language={language || undefined}') &&
      markdownPreviewSource.includes("import('mermaid')") &&
      markdownPreviewSource.includes('language-mermaid') &&
      markdownPreviewSource.includes('mermaid.parse(source)') &&
      markdownPreviewSource.includes('useMermaidAppearance') &&
      markdownPreviewSource.includes('code-markdown-mermaid-toolbar') &&
      markdownPreviewSource.includes('code-markdown-mermaid-error-message') &&
      markdownPreviewSource.includes('skipHtml') &&
      markdownPreviewSource.includes('rawWorkspaceFileUrl(openFile.agentId') &&
      markdownPreviewSource.includes('data-testid="code-file-markdown-preview"'),
    'Editor surface should render Markdown preview in the main editor panel with GFM, math, front matter, heading anchors, code labels/highlighting, themed Mermaid controls/errors, safe HTML skipping, and workspace image/link support'
  );

  assert(
    copySource.includes('openMarkdownPreview') &&
      copySource.includes('showMarkdownSource') &&
      copySource.includes('markdownPreviewFor') &&
      copySource.includes('markdownFrontMatter') &&
      copySource.includes('markdownHeadingAnchor') &&
      copySource.includes('mermaidZoomIn') &&
      copySource.includes('mermaidRenderFailed') &&
      stylesSource.includes('.code-file-preview-panel.markdown') &&
      stylesSource.includes('.code-markdown-preview') &&
      stylesSource.includes('.code-markdown-preview .katex-display') &&
      stylesSource.includes('.code-markdown-preview pre[data-language]::before') &&
      stylesSource.includes('.code-markdown-heading-anchor') &&
      stylesSource.includes('.code-markdown-preview .hljs-keyword') &&
      stylesSource.includes('.code-markdown-preview .code-markdown-frontmatter') &&
      stylesSource.includes('.code-markdown-mermaid') &&
      stylesSource.includes('.code-markdown-mermaid-toolbar') &&
      stylesSource.includes('.code-markdown-mermaid-viewport') &&
      stylesSource.includes('.code-markdown-mermaid.error') &&
      darkStylesSource.includes('.code-markdown-preview .katex') &&
      darkStylesSource.includes('.code-markdown-preview .hljs-keyword') &&
      darkStylesSource.includes('.code-markdown-preview .code-markdown-frontmatter') &&
      darkStylesSource.includes('.code-markdown-mermaid') &&
      darkStylesSource.includes('.code-markdown-mermaid-toolbar') &&
      darkStylesSource.includes('.code-markdown-preview'),
    'Markdown preview should have toolbar copy plus light/dark editor-panel, math, code-label/highlight, front-matter, heading-anchor, and Mermaid interaction styling'
  );
}

run();
console.log('markdown preview editor assertions passed');
