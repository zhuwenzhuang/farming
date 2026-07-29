const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const editorModelSource = read('src/lib/workspace-editor-model.ts');
  const editorPaneSource = read('src/components/files/FileEditorPane.tsx');
  const editorHeaderSource = read('src/components/files/FileEditorHeader.tsx');
  const editorActionsSource = read('src/components/files/FileEditorActions.tsx');
  const editorMonacoSource = read('src/lib/workspace-editor-monaco.ts');
  const editorMonacoControllerSource = read('src/components/files/useFileEditorMonacoController.ts');
  const copySource = read('src/components/code/copy.ts');

  assert(
    editorModelSource.includes('showWordWrap: boolean') &&
      editorModelSource.includes('const showWordWrap = !mode.visualPreview && !mode.diffOnly') &&
      editorModelSource.includes('showBar: options.showBreadcrumbs || showStatus || showSave || showDiff || showMarkdownPreview || showSourcePreview || showWordWrap'),
    'Editor action state should expose word wrap for source-backed editor surfaces'
  );

  assert(
    editorPaneSource.includes('WORD_WRAP_STORAGE_KEY') &&
      editorPaneSource.includes('const [wordWrapEnabled, setWordWrapEnabled]') &&
      editorPaneSource.includes('writeWordWrapPreference(next)') &&
      editorPaneSource.includes('wordWrapEnabled,') &&
      editorPaneSource.includes('onToggleWordWrap={toggleWordWrap}'),
    'FileEditorPane should keep a persisted frontend word-wrap preference and pass it to Monaco/header'
  );

  assert(
    editorHeaderSource.includes('onToggleWordWrap') &&
      editorHeaderSource.includes('wordWrapEnabled') &&
      editorActionsSource.includes('function WordWrapIcon') &&
      editorActionsSource.includes('code-file-editor-action word-wrap') &&
      editorActionsSource.includes('aria-pressed={wordWrapEnabled}') &&
      editorActionsSource.includes('copy.enableWordWrap') &&
      editorActionsSource.includes('copy.disableWordWrap') &&
      copySource.includes('enableWordWrap:') &&
      copySource.includes('disableWordWrap:'),
    'Editor header should expose an accessible word-wrap toggle with localized labels'
  );

  assert(
    editorMonacoControllerSource.includes('wordWrapEnabledRef') &&
      editorMonacoControllerSource.includes('wordWrapEnabled: boolean') &&
      editorMonacoControllerSource.includes('wordWrapEnabled: wordWrapEnabledRef.current') &&
      editorMonacoControllerSource.includes('updateWorkspaceEditorResponsiveOptions(editor, wordWrapEnabled)') &&
      editorMonacoSource.includes('function workspaceEditorWordWrapValue') &&
      editorMonacoSource.includes("wordWrapEnabled === true || isNarrowWorkspaceEditorViewport() ? 'on' : 'off'") &&
      editorMonacoSource.includes('wordWrap: workspaceEditorWordWrapValue(wordWrapEnabled)'),
    'Monaco editor options should apply manual word wrap without losing narrow-viewport automatic wrapping'
  );

  console.log('file editor word wrap assertions passed');
}

run();
