const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const mainAreaSource = read('src/components/code/CodeMainArea.tsx');
  const monacoSource = read('src/lib/workspace-editor-monaco.ts');

  assert(
    mainAreaSource.includes('let fileEditorPaneLoadPromise') &&
      mainAreaSource.includes('function loadFileEditorPaneModule()') &&
      mainAreaSource.includes("import('../files/FileEditorPane')") &&
      mainAreaSource.includes("import('@/lib/workspace-editor-monaco')") &&
      mainAreaSource.includes('void editorMonaco.preloadWorkspaceEditorMonaco()') &&
      mainAreaSource.includes('let loadedFileEditorPane') &&
      mainAreaSource.includes('function preloadFileEditorPane(') &&
      mainAreaSource.includes('const ReadyFileEditorPane = fileEditorPane ?? loadedFileEditorPane') &&
      mainAreaSource.includes('ReadyFileEditorPane ? (') &&
      !mainAreaSource.includes('lazy(() => loadFileEditorPane())'),
    'CodeMainArea should start one shared editor preload after its first render without routing background failures through page reload recovery'
  );

  assert(
    monacoSource.includes('WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS') &&
      monacoSource.includes("'typescript'") &&
      monacoSource.includes("'javascript'") &&
      monacoSource.includes("'markdown'") &&
      monacoSource.includes("'python'") &&
      monacoSource.includes("'java'") &&
      monacoSource.includes("'sql'") &&
      monacoSource.includes("'yaml'") &&
      monacoSource.includes('let workspaceEditorPreloadPromise') &&
      monacoSource.includes('Promise.allSettled(') &&
      monacoSource.includes("monaco.editor.colorize('', languageId, { tabSize: 2 })"),
    'Workspace editor preload should reuse one promise and warm common Monaco tokenizers without holding the editor pane behind unrelated languages'
  );

  console.log('file editor preload assertions passed');
}

run();
