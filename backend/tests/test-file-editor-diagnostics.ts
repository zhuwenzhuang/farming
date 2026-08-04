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
  const normalizedDesign = designSource.replace(/\s+/g, ' ');
  const normalizedDesignZh = designZhSource.replace(/\s+/g, ' ');

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
    normalizedDesign.includes("Keep Monaco syntax diagnostics but disable Monaco's isolated semantic and suggestion diagnostics") &&
      normalizedDesign.includes('Project-level diagnostics appear through the managed Language Server path') &&
      normalizedDesignZh.includes('保留 Monaco 的语法诊断，但关闭 Monaco 隔离环境中的 Semantic 和 Suggestion Diagnostics') &&
      normalizedDesignZh.includes('项目级诊断通过托管 Language Server 路径提供'),
    'Project Files design docs should state the syntax-only diagnostics boundary'
  );

  console.log('file editor diagnostics assertions passed');
}

run();
