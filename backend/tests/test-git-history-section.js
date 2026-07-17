const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const projectFiles = read('src/components/files/ProjectFilesSection.tsx');
  const section = read('src/components/files/GitHistorySection.tsx');
  const graph = read('src/components/files/GitHistoryGraph.tsx');
  const graphModel = read('src/lib/git-history-graph.ts');
  const api = read('src/lib/workspace-files.ts');
  const router = read('backend/workspace-file-router.js');
  const copy = read('src/components/code/copy.ts');
  const styles = `${read('src/styles/main.css')}\n${read('src/styles/code-dark.css')}`;
  const notices = read('THIRD_PARTY_NOTICES.md');

  assert(projectFiles.includes("import { GitHistorySection } from './GitHistorySection'"));
  assert(projectFiles.includes('<GitHistorySection'));
  assert(projectFiles.indexOf('<GitHistorySection') > projectFiles.indexOf('className={`code-files-section'));
  assert(section.includes('fetchWorkspaceGitHistory('));
  assert(section.includes('fetchWorkspaceGitHistoryChanges('));
  assert(section.includes('toGitHistoryItemViewModelArray('));
  assert(section.includes('GIT_HISTORY_PAGE_SIZE = 50'));
  assert(section.includes('commit.parentIds.length > 1'));
  assert(section.includes('selectedChanges.comparisonBase'));
  assert(section.includes('window.open(appPath(`/review?'));
  assert(section.includes("params.append('path', filePath)"));
  assert(section.includes('data-testid="code-git-history-entry"'));
  assert(section.includes('<GitHistoryGraphPlaceholder columns={viewModel.outputSwimlanes} />'));
  assert(section.includes('copy.reviewChanges'));
  assert(section.includes('gitHistoryCurrentBranch'));
  assert(section.includes('gitHistoryAllBranches'));
  assert(section.includes('data-testid="code-git-history-scope-menu"'));
  assert(section.includes('role="menuitemradio"'));
  assert(!section.includes('<select\n              className="code-git-history-scope"'));
  assert(section.includes('commitMessageBody(commit)'));
  assert(section.includes('code-git-history-message-body'));
  assert(section.includes('<ExternalLinkGlyph />'));
  assert(graph.includes('renderGitHistoryItemGraph'));
  assert(graph.includes('renderGitHistoryGraphPlaceholder'));
  assert(graph.includes('new ResizeObserver(render)'));
  assert(graphModel.includes('Copyright (c) Microsoft Corporation'));
  assert(graphModel.includes('0217c2f1a0defc7fdbfb4feba74e71e366de6822'));
  assert(graphModel.includes('GIT_HISTORY_GRAPH_COLORS'));
  assert(api.includes('/api/files/history?'));
  assert(api.includes("params.set('scope', options.scope)"));
  assert(api.includes('/api/files/history/changes?'));
  assert(router.includes("router.get('/history'"));
  assert(router.includes("router.get('/history/changes'"));
  assert(copy.includes("gitHistory: 'History'"));
  assert(copy.includes("gitHistory: '历史'"));
  assert(styles.includes('.code-git-history-section'));
  assert(styles.includes('.code-files-section > .code-git-history-section'));
  assert(styles.includes('.code-git-history-graph-placeholder'));
  assert(styles.includes("[data-appearance='dark'] .code-git-history-section"));
  assert(notices.includes('Visual Studio Code SCM history graph'));

  console.log('test-git-history-section passed');
}

run();
