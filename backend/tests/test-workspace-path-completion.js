const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const serverSource = read('backend/server.js');
  const inputDialogSource = read('src/components/InputDialog.tsx');
  const stylesSource = read('src/styles/main.css');

  assert(
    serverSource.includes("routePath(BASE_PATH, '/api/workspaces/complete')") &&
      serverSource.includes('function listWorkspacePathCompletions') &&
      serverSource.includes('fs.promises.readdir(query.parent, { withFileTypes: true })') &&
      serverSource.includes('entry.isDirectory()') &&
      serverSource.includes("normalizedPrefix.startsWith('.') || !entry.name.startsWith('.')") &&
      serverSource.includes('Math.min(Number(limit) || 12, 100)') &&
      serverSource.includes('suggestions: []'),
    'server should expose a lightweight directory-only workspace path completion API'
  );

  assert(
    inputDialogSource.includes('workspacePathSuggestions') &&
      inputDialogSource.includes("fetch(appPath(`/api/workspaces/complete?${params.toString()}`)") &&
      inputDialogSource.includes('acceptWorkspacePathSuggestion') &&
      inputDialogSource.includes('moveWorkspacePathSelection') &&
      inputDialogSource.includes("limit: '50'") &&
      inputDialogSource.includes("scrollIntoView({ block: 'nearest' })") &&
      inputDialogSource.includes('data-testid="workspace-path-suggestions"') &&
      inputDialogSource.includes("e.key === 'Tab' && workspacePathSuggestions.length > 0"),
    'InputDialog should fetch and accept workspace path suggestions without replacing recent workspaces'
  );

  assert(
    stylesSource.includes('.workspace-path-suggestions') &&
      stylesSource.includes('max-height: min(42vh, 320px)') &&
      stylesSource.includes('overflow-y: auto') &&
      stylesSource.includes('.workspace-path-suggestion.active') &&
      stylesSource.includes('.workspace-path-suggestion-path') &&
      stylesSource.includes('body.code-mode .workspace-path-suggestion.active') &&
      stylesSource.includes('body.code-mode .workspace-path-suggestion-path'),
    'workspace path suggestions should have lightweight terminal and Codex-mode styles'
  );

  console.log('✓ Workspace path completion is wired');
}

run();
