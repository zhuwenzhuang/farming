const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const monacoSource = read('src/lib/workspace-editor-monaco.ts');
  const designSource = read('docs/products/code/project-files-section-design.md');
  const designZhSource = read('docs/products/code/project-files-section-design.zh_cn.md');

  assert(
    monacoSource.includes('const WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS = {') &&
      monacoSource.includes('noSemanticValidation: true') &&
      monacoSource.includes('noSyntaxValidation: false') &&
      monacoSource.includes('noSuggestionDiagnostics: true') &&
      monacoSource.includes('monaco.typescript.typescriptDefaults.setDiagnosticsOptions(WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS)') &&
      monacoSource.includes('monaco.typescript.javascriptDefaults.setDiagnosticsOptions(WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS)'),
    'Workspace TypeScript and JavaScript diagnostics should remain syntax-only until a project-backed language service exists'
  );

  assert(
    designSource.includes('disable its semantic and suggestion diagnostics until Farming has a project-backed language service') &&
      designZhSource.includes('接入基于真实 Project 的语言服务前关闭 semantic 和 suggestion diagnostics'),
    'Project Files design docs should state the syntax-only diagnostics boundary'
  );

  console.log('file editor diagnostics assertions passed');
}

run();
