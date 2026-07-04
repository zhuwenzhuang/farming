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
      packageSource.includes('"remark-gfm"'),
    'Markdown preview should use mature React Markdown/GFM rendering dependencies'
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
      markdownPreviewSource.includes('skipHtml') &&
      markdownPreviewSource.includes('rawWorkspaceFileUrl(openFile.agentId') &&
      markdownPreviewSource.includes('data-testid="code-file-markdown-preview"'),
    'Editor surface should render Markdown preview in the main editor panel with GFM, safe HTML skipping, and workspace image/link support'
  );

  assert(
    copySource.includes('openMarkdownPreview') &&
      copySource.includes('showMarkdownSource') &&
      copySource.includes('markdownPreviewFor') &&
      stylesSource.includes('.code-file-preview-panel.markdown') &&
      stylesSource.includes('.code-markdown-preview') &&
      darkStylesSource.includes('.code-markdown-preview'),
    'Markdown preview should have toolbar copy plus light and dark editor-panel styling'
  );
}

run();
console.log('markdown preview editor assertions passed');
