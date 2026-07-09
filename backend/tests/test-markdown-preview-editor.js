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
  const codeMainAreaSource = read('src/components/code/CodeMainArea.tsx');
  const workspaceSource = read('src/components/CodeWorkspace.tsx');
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
      editorModelSource.includes('markdownSplitOpen?: boolean') &&
      editorModelSource.includes('markdownPreviewOpen?: boolean') &&
      editorModelSource.includes('showMarkdownSplit: boolean') &&
      editorModelSource.includes('showMarkdownPreview: boolean') &&
      editorModelSource.includes('const showMarkdownSurface = !showDiffView && !showDiffOnlyPreview') &&
      editorModelSource.includes('const showMarkdownSplit = Boolean(options.markdownSplitOpen)') &&
      editorModelSource.includes('const showMarkdownPreview = Boolean(options.markdownPreviewOpen)') &&
      editorModelSource.includes('canPreviewMarkdown?: boolean') &&
      editorModelSource.includes('canPreviewSource?: boolean'),
    'Editor model should keep Markdown recognition and preview/diff priority in shared state helpers'
  );

  assert(
    editorPaneSource.includes('isWorkspaceMarkdownFile(openFile.file.path)') &&
      editorPaneSource.includes('sourcePreviewByFileKey') &&
      editorPaneSource.includes('markdownSplitByFileKey') &&
      editorPaneSource.includes('workspaceEditorModelKey(openFile)') &&
      editorPaneSource.includes('canPreviewMarkdown || canPreviewSource') &&
      editorPaneSource.includes('sourcePreviewPreference !== false') &&
      editorPaneSource.includes('const sourceVisualPreviewOpen = canPreviewSource && sourcePreviewOpen') &&
      editorPaneSource.includes('[activeFileKey]: nextSourcePreviewOpen') &&
      editorPaneSource.includes('const markdownReadingOpen = canPreviewMarkdown && sourcePreviewOpen') &&
      editorPaneSource.includes('const markdownSplitOpen = markdownReadingOpen') &&
      editorPaneSource.includes('const markdownPreviewOpen = markdownReadingOpen && !markdownSplitOpen') &&
      editorPaneSource.includes('code-mobile-markdown-reading') &&
      editorPaneSource.includes("markdownReadingOpen ? 'markdown-reading' : ''") &&
      editorPaneSource.includes('toggleMarkdownSplit') &&
      editorPaneSource.includes('markdownPreviewOpen={markdownPreviewOpen}') &&
      editorPaneSource.includes('markdownSplitOpen={markdownSplitOpen}') &&
      editorPaneSource.includes('onOpenFilePath={onOpenFilePath}') &&
      editorPaneSource.includes('canPreviewMarkdown={canPreviewMarkdown}') &&
      editorPaneSource.includes('onToggleSourcePreview={toggleSourcePreview}'),
    'FileEditorPane should default Markdown to preview, store source/split as per-open-file frontend view state, and mark mobile reading mode'
  );

  assert(
    editorHeaderSource.includes('canPreviewMarkdown') &&
      editorHeaderSource.includes('onToggleSourcePreview') &&
      editorHeaderSource.includes('onToggleMarkdownSplit') &&
      editorHeaderSource.includes('markdownSplitOpen') &&
      editorHeaderSource.includes('sourcePreviewOpen') &&
      editorActionsSource.includes('actions.showMarkdownPreview || actions.showSourcePreview') &&
      editorActionsSource.includes('code-file-editor-action source-preview') &&
      editorActionsSource.includes('code-file-editor-action markdown-split') &&
      editorActionsSource.includes('function MarkdownSplitPreviewIcon') &&
      editorActionsSource.includes('function MarkdownPreviewIcon') &&
      editorActionsSource.includes('className="code-file-editor-action-svg"') &&
      editorActionsSource.includes('copy.openMarkdownSplitPreview') &&
      editorActionsSource.includes('copy.showMarkdownSource : copy.openMarkdownPreview'),
    'Editor header actions should expose Markdown source/preview and explicit split-preview controls only when the model allows them'
  );

  assert(
      editorSurfaceSource.includes('<FileEditorMarkdownPreview') &&
      editorSurfaceSource.includes('surface.showMarkdownSplit') &&
      editorSurfaceSource.includes('surface.showMarkdownPreview') &&
      editorSurfaceSource.includes('markdownSplitOpen,') &&
      editorSurfaceSource.includes('markdownPreviewOpen,') &&
      editorSurfaceSource.includes('code-file-editor-source-region') &&
      editorSurfaceSource.includes("surface.showMonaco || surface.showMarkdownSplit ? '' : 'hidden'") &&
      editorSurfaceSource.includes('code-file-markdown-split') &&
      !editorSurfaceSource.includes('if (surface.showMarkdownSplit)') &&
      !editorSurfaceSource.includes('editor.onDidScrollChange') &&
      !editorSurfaceSource.includes("preview.addEventListener('scroll', syncEditorFromPreview") &&
      !editorSurfaceSource.includes('editor.setScrollTop') &&
      editorSurfaceSource.includes('ref={markdownPreviewRef}') &&
      editorSurfaceSource.includes('onOpenFilePath={onOpenFilePath}') &&
      markdownPreviewSource.includes('ReactMarkdown') &&
      markdownPreviewSource.includes('forwardRef<HTMLElement, FileEditorMarkdownPreviewProps>') &&
      markdownPreviewSource.includes('remarkGfm') &&
      markdownPreviewSource.includes('remarkMath') &&
      markdownPreviewSource.includes('rehypeKatex') &&
      markdownPreviewSource.includes('rehypeHighlight') &&
      markdownPreviewSource.includes("parse as parseYaml") &&
      markdownPreviewSource.includes("import 'katex/dist/katex.min.css'") &&
      markdownPreviewSource.includes('createHeadingIdFactory') &&
      markdownPreviewSource.includes('createContext') &&
      markdownPreviewSource.includes('MarkdownPreviewContext.Provider') &&
      markdownPreviewSource.includes('const MARKDOWN_COMPONENTS: Components') &&
      markdownPreviewSource.includes('const MarkdownPre: Components') &&
      !markdownPreviewSource.includes('const components: Components = {') &&
      markdownPreviewSource.includes('MarkdownFrontMatterTable') &&
      markdownPreviewSource.includes('code-markdown-heading-anchor') &&
      markdownPreviewSource.includes('data-language={language || undefined}') &&
      markdownPreviewSource.includes("import('mermaid')") &&
      markdownPreviewSource.includes('language-mermaid') &&
      markdownPreviewSource.includes('mermaid.parse(source)') &&
      markdownPreviewSource.includes('useMermaidAppearance') &&
      markdownPreviewSource.includes('code-markdown-mermaid-toolbar') &&
      markdownPreviewSource.includes('handleWheel') &&
      markdownPreviewSource.includes('event.altKey') &&
      markdownPreviewSource.includes('event.ctrlKey') &&
      markdownPreviewSource.includes('mermaidPanMode') &&
      markdownPreviewSource.includes('mermaidEnterFullscreen') &&
      markdownPreviewSource.includes('isFullscreen') &&
      markdownPreviewSource.includes('fitFullscreenDiagram') &&
      markdownPreviewSource.includes('fullscreenCanvasSize') &&
      markdownPreviewSource.includes('viewBox.width') &&
      markdownPreviewSource.includes('didPanRef') &&
      markdownPreviewSource.includes('code-markdown-mermaid-error-message') &&
      markdownPreviewSource.includes('skipHtml') &&
      markdownPreviewSource.includes('rawWorkspaceFileUrl(openFile.agentId') &&
      markdownPreviewSource.includes('markdownWorkspaceLinkPath') &&
      markdownPreviewSource.includes('void onOpenFilePath(openFile.agentId, workspacePath)') &&
      !markdownPreviewSource.includes('function markdownLinkUrl') &&
      codeMainAreaSource.includes('onOpenFilePath={onOpenWorkspaceFilePath}') &&
      workspaceSource.includes('onOpenWorkspaceFilePath={openWorkspaceFilePath}') &&
      workspaceSource.includes('const openWorkspaceFilePath = useCallback(async (agentId: string, filePath: string') &&
      (workspaceSource.includes('if (selectOpenWorkspaceFile(agentId, filePath, target)) return') || workspaceSource.includes('if (selectOpenWorkspaceFile(fileAgentId, resolvedFilePath, resolvedTarget)) return')) &&
      workspaceSource.includes('await fetchWorkspaceTree(agentId, filePath)') &&
      (workspaceSource.includes("revealWorkspaceFileInExplorer(agentId, filePath, 'directory')") || workspaceSource.includes("revealWorkspaceFileInExplorer(fileAgentId, resolvedFilePath, 'directory')")) &&
      workspaceSource.includes('focusWorkspaceFilesSearch(agentId, filePath)') &&
      markdownPreviewSource.includes('data-testid="code-file-markdown-preview"'),
    'Editor surface should render Markdown as preview by default, expose explicit split source/preview without scroll sync, and support GFM, math, front matter, heading anchors, stable renderers that avoid Mermaid remount flicker, code labels/highlighting, themed Mermaid controls/errors, safe HTML skipping, raw workspace images, and app-routed workspace links including relative directory links'
  );

  assert(
    copySource.includes('openMarkdownPreview') &&
      copySource.includes('showMarkdownSource') &&
      copySource.includes('openMarkdownSplitPreview') &&
      copySource.includes('closeMarkdownSplitPreview') &&
      copySource.includes('markdownPreviewFor') &&
      copySource.includes('markdownFrontMatter') &&
      copySource.includes('markdownHeadingAnchor') &&
      copySource.includes('mermaidZoomIn') &&
      copySource.includes('mermaidPanMode') &&
      copySource.includes('mermaidEnterFullscreen') &&
      copySource.includes('mermaidRenderFailed') &&
      stylesSource.includes('.code-file-preview-panel.markdown') &&
      stylesSource.includes('.code-file-editor-split.markdown') &&
      stylesSource.includes('.code-file-editor-split.markdown .code-file-monaco') &&
      stylesSource.includes('.code-file-editor-source-region.markdown-split') &&
      stylesSource.includes('.code-file-editor-source-region.markdown-split .code-file-monaco') &&
      stylesSource.includes('.code-markdown-preview') &&
      stylesSource.includes('.code-markdown-preview .katex-display') &&
      stylesSource.includes('.code-markdown-preview pre[data-language]::before') &&
      stylesSource.includes('.code-markdown-heading-anchor') &&
      stylesSource.includes('.code-markdown-preview .hljs-keyword') &&
      stylesSource.includes('.code-markdown-preview .code-markdown-frontmatter') &&
      stylesSource.includes('.code-mobile-markdown-reading .code-mobile-topbar-title') &&
      stylesSource.includes('.code-mobile-markdown-reading .code-mobile-topbar-button.more') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-tab-strip') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-action.source-preview') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-action.markdown-split') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-split.markdown .code-file-monaco') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-source-region.markdown-split .code-file-monaco') &&
      stylesSource.includes('.code-file-editor.markdown-reading .code-file-editor-action.source-preview::after') &&
      stylesSource.includes('.code-markdown-mermaid') &&
      stylesSource.includes('.code-markdown-mermaid-toolbar') &&
      stylesSource.includes('.code-markdown-mermaid.fullscreen') &&
      stylesSource.includes('.code-markdown-mermaid-viewport') &&
      stylesSource.includes('.code-markdown-mermaid.fullscreen .code-markdown-mermaid-canvas') &&
      stylesSource.includes('.code-markdown-mermaid.error') &&
      darkStylesSource.includes('.code-markdown-preview .katex') &&
      darkStylesSource.includes('.code-markdown-preview .hljs-keyword') &&
      darkStylesSource.includes('.code-markdown-preview .code-markdown-frontmatter') &&
      darkStylesSource.includes('.code-mobile-markdown-reading .code-mobile-topbar') &&
      darkStylesSource.includes('.code-markdown-mermaid') &&
      darkStylesSource.includes('.code-markdown-mermaid-toolbar') &&
      darkStylesSource.includes('.code-markdown-preview'),
    'Markdown preview should have toolbar copy plus light/dark editor-panel, mobile reading mode, math, code-label/highlight, front-matter, heading-anchor, and Mermaid interaction styling'
  );
}

run();
console.log('markdown preview editor assertions passed');
