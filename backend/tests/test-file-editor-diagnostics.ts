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
    designSource.includes("keep Monaco syntax diagnostics but disable Monaco's isolated semantic and suggestion diagnostics") &&
      designSource.includes('Project-level diagnostics appear only through a connected VS Code Bridge and only for the saved file') &&
      designZhSource.includes('保留 Monaco 的语法诊断，但关闭 Monaco 隔离环境中的 Semantic 和 Suggestion Diagnostics') &&
      designZhSource.includes('项目级诊断只通过已连接的 VS Code Bridge 提供，并且只针对已保存文件'),
    'Project Files design docs should state the syntax-only diagnostics boundary'
  );

  console.log('file editor diagnostics assertions passed');
}

run();
