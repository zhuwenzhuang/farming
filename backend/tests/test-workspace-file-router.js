const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { WorkspaceFileService } = require('../workspace-file-service');
const {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  PROJECT_FILES_AGENT_PREFIX,
  createWorkspaceFileRouter,
} = require('../workspace-file-router');

function hasCommand(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isRetryableFetchError(error) {
  const code = error?.cause?.code || error?.code;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE';
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetchWithRetry(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

async function fetchRaw(baseUrl, pathname) {
  const response = await fetchWithRetry(`${baseUrl}${pathname}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-file-router-'));
  const projectWorkspace = path.join(tmpRoot, 'project');
  const mainWorkspace = path.join(projectWorkspace, '.farming');
  const externalWorkspace = path.join(tmpRoot, 'external-workspace');
  const projectWorkspaces = [projectWorkspace];
  const service = new WorkspaceFileService({ maxFileSize: 64, maxWriteSize: 1024 * 32 });

  try {
    fs.mkdirSync(mainWorkspace, { recursive: true });
    fs.mkdirSync(externalWorkspace, { recursive: true });
    fs.writeFileSync(path.join(externalWorkspace, 'reference.md'), 'external router reference\n');
    fs.symlinkSync(externalWorkspace, path.join(projectWorkspace, 'reference-link'));
    fs.writeFileSync(path.join(projectWorkspace, 'README.md'), 'hello farming\n');
    fs.writeFileSync(path.join(projectWorkspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(projectWorkspace, 'large.log'), `${'large text line\n'.repeat(8)}`);
    fs.writeFileSync(path.join(projectWorkspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64'
    ));
    fs.writeFileSync(path.join(projectWorkspace, 'icon.svg'), '<svg><rect/></svg>\n');
    const globalReadFile = path.join(projectWorkspace, 'global-note.md');
    fs.writeFileSync(globalReadFile, 'global file\n');
    const forbiddenGlobalReadFile = path.join(tmpRoot, 'outside-project.md');
    fs.writeFileSync(forbiddenGlobalReadFile, 'outside project\n');

    const agentManager = {
      configManager: {
        getSettings() {
          return { workspaceHistory: [externalWorkspace], projectWorkspaces };
        },
      },
      getAgentWorkspaceRoot(agentId) {
        if (agentId === 'agent-main') return projectWorkspace;
        return null;
      },
      getState() {
        return {
          agents: [
            { id: 'agent-main', cwd: mainWorkspace, projectWorkspace },
          ],
        };
      },
    };

    const app = express();
    app.use('/api/files', createWorkspaceFileRouter(agentManager, service));
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const tree = await fetchJson(baseUrl, '/api/files/tree?agentId=agent-main');
      assert.strictEqual(tree.response.status, 200);
      assert(tree.body.tree.items.some(item => item.path === 'README.md'));
      const referenceLink = tree.body.tree.items.find(item => item.path === 'reference-link');
      assert.strictEqual(referenceLink.type, 'directory');
      assert.strictEqual(referenceLink.symbolicLink, true);
      assert.strictEqual(referenceLink.external, true);
      assert.strictEqual(referenceLink.readOnly, true);
      const referenceTree = await fetchJson(baseUrl, '/api/files/tree?agentId=agent-main&path=reference-link');
      assert.strictEqual(referenceTree.response.status, 200);
      assert.strictEqual(referenceTree.body.tree.items[0].path, 'reference-link/reference.md');
      assert.strictEqual(referenceTree.body.tree.items[0].readOnly, true);
      const referenceRead = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=reference-link%2Freference.md');
      assert.strictEqual(referenceRead.response.status, 200);
      assert.strictEqual(referenceRead.body.file.content, 'external router reference\n');
      assert.strictEqual(referenceRead.body.file.readOnly, true);

      const branch = await fetchJson(baseUrl, '/api/files/branch?agentId=agent-main');
      assert.strictEqual(branch.response.status, 200);
      assert.strictEqual(branch.body.branch, '');
      const nonRepositoryWorktrees = await fetchJson(baseUrl, '/api/files/worktrees?agentId=agent-main');
      assert.strictEqual(nonRepositoryWorktrees.response.status, 200);
      assert.strictEqual(nonRepositoryWorktrees.body.worktrees.isGitRepo, false);
      assert.deepStrictEqual(nonRepositoryWorktrees.body.worktrees.items, []);
      const nonRepositoryHistory = await fetchJson(baseUrl, '/api/files/history?agentId=agent-main');
      assert.strictEqual(nonRepositoryHistory.response.status, 200);
      assert.strictEqual(nonRepositoryHistory.body.history.isGitRepo, false);
      assert.deepStrictEqual(nonRepositoryHistory.body.history.items, []);
      const globalHistory = await fetchJson(baseUrl, `/api/files/history?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}`);
      assert.strictEqual(globalHistory.response.status, 403);
      const globalWorktrees = await fetchJson(baseUrl, `/api/files/worktrees?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}`);
      assert.strictEqual(globalWorktrees.response.status, 403);

      const read = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=README.md');
      assert.strictEqual(read.response.status, 200);
      assert.strictEqual(read.body.file.content, 'hello farming\n');
      const globalReadPath = globalReadFile.replace(/^\/+/, '');
      const globalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(globalReadPath)}`);
      assert.strictEqual(globalRead.response.status, 200);
      assert.strictEqual(globalRead.body.root, '/');
      assert.strictEqual(globalRead.body.file.content, 'global file\n');
      const forbiddenGlobalReadPath = forbiddenGlobalReadFile.replace(/^\/+/, '');
      const forbiddenGlobalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(forbiddenGlobalReadPath)}`);
      assert.strictEqual(forbiddenGlobalRead.response.status, 403);
      const globalWrite = await fetchJson(baseUrl, '/api/files/file', {
        method: 'PUT',
        body: JSON.stringify({
          agentId: GLOBAL_WORKSPACE_FILES_AGENT_ID,
          path: globalReadPath,
          content: 'should not save\n',
          baseSha1: globalRead.body.file.sha1,
        }),
      });
      assert.strictEqual(globalWrite.response.status, 403);

      const previewFile = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=preview.png');
      assert.strictEqual(previewFile.response.status, 200);
      assert.strictEqual(previewFile.body.file.binary, true);
      assert.strictEqual(previewFile.body.file.preview.mediaType, 'image/png');
      const svgFile = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=icon.svg');
      assert.strictEqual(svgFile.response.status, 200);
      assert(svgFile.body.file.content.includes('<svg'));
      assert.strictEqual(svgFile.body.file.preview, undefined);
      const binaryFile = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=binary.bin');
      assert.strictEqual(binaryFile.response.status, 200);
      assert.strictEqual(binaryFile.body.file.content, '');
      assert.strictEqual(binaryFile.body.file.binary, true);
      assert.strictEqual(binaryFile.body.file.preview.kind, 'binary');
      const largeTextFile = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=large.log');
      assert.strictEqual(largeTextFile.response.status, 200);
      assert(largeTextFile.body.file.content.startsWith('large text line\n'));
      assert.strictEqual(largeTextFile.body.file.preview.kind, 'large-text');
      assert.strictEqual(largeTextFile.body.file.preview.truncated, true);
      const rawBinary = await fetchJson(baseUrl, '/api/files/raw?agentId=agent-main&path=binary.bin');
      assert.strictEqual(rawBinary.response.status, 415);
      const rawPreview = await fetchRaw(baseUrl, '/api/files/raw?agentId=agent-main&path=preview.png');
      assert.strictEqual(rawPreview.response.status, 200);
      assert(rawPreview.response.headers.get('content-type').includes('image/png'));
      assert(rawPreview.buffer.length > 0);
      const rawSvgPreview = await fetchRaw(baseUrl, '/api/files/raw?agentId=agent-main&path=icon.svg');
      assert.strictEqual(rawSvgPreview.response.status, 200);
      assert(rawSvgPreview.response.headers.get('content-type').includes('image/svg+xml'));
      assert(rawSvgPreview.buffer.toString('utf8').includes('<rect'));
      const rawEscaped = await fetchJson(baseUrl, '/api/files/raw?agentId=agent-main&path=../secret.png');
      assert.strictEqual(rawEscaped.response.status, 403);

      const saved = await fetchJson(baseUrl, '/api/files/file', {
        method: 'PUT',
        body: JSON.stringify({
          agentId: 'agent-main',
          path: 'README.md',
          content: 'saved through api\n',
          baseSha1: read.body.file.sha1,
        }),
      });
      assert.strictEqual(saved.response.status, 200);
      assert.strictEqual(saved.body.file.content, 'saved through api\n');

      if (hasCommand('rg')) {
        const search = await fetchJson(baseUrl, '/api/files/search?agentId=agent-main&q=saved');
        assert.strictEqual(search.response.status, 200);
        assert(search.body.results.matches.some(match => match.path === 'README.md' && match.lineNumber === 1));

        const pathSearch = await fetchJson(baseUrl, '/api/files/search?agentId=agent-main&q=README');
        assert.strictEqual(pathSearch.response.status, 200);
        assert.strictEqual(pathSearch.body.results.matches[0].kind, 'path');
        assert.strictEqual(pathSearch.body.results.matches[0].entryType, 'file');
        assert.strictEqual(pathSearch.body.results.matches[0].path, 'README.md');
      }

      if (hasCommand('git')) {
        execFileSync('git', ['init'], { cwd: projectWorkspace, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: projectWorkspace });
        execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: projectWorkspace });
        execFileSync('git', ['add', 'README.md'], { cwd: projectWorkspace });
        execFileSync('git', ['commit', '-m', 'readme'], { cwd: projectWorkspace, stdio: 'ignore' });
        const readmeCommit = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectWorkspace, encoding: 'utf8' })).trim();
        const linkedWorkspace = path.join(tmpRoot, 'project-topic');
        execFileSync('git', ['worktree', 'add', '-b', 'topic', linkedWorkspace], { cwd: projectWorkspace, stdio: 'ignore' });
        projectWorkspaces.push(linkedWorkspace);
        const canonicalProjectWorkspace = fs.realpathSync(projectWorkspace);
        const canonicalLinkedWorkspace = fs.realpathSync(linkedWorkspace);

        const history = await fetchJson(baseUrl, '/api/files/history?agentId=agent-main&limit=1');
        assert.strictEqual(history.response.status, 200);
        assert.strictEqual(history.body.history.isGitRepo, true);
        assert.strictEqual(history.body.history.head, readmeCommit);
        assert.strictEqual(history.body.history.scope, 'current');
        assert.strictEqual(history.body.history.items[0].subject, 'readme');
        assert.strictEqual(history.body.history.items[0].message, 'readme');
        const worktrees = await fetchJson(baseUrl, '/api/files/worktrees?agentId=agent-main');
        assert.strictEqual(worktrees.response.status, 200);
        assert.strictEqual(worktrees.body.worktrees.isGitRepo, true);
        assert.strictEqual(worktrees.body.worktrees.items.length, 2);
        assert.strictEqual(worktrees.body.worktrees.items.find(item => item.main).workspace, canonicalProjectWorkspace);
        assert.strictEqual(worktrees.body.worktrees.items.find(item => item.current).workspace, canonicalProjectWorkspace);
        const linkedProjectAgentId = `${PROJECT_FILES_AGENT_PREFIX}${encodeURIComponent(linkedWorkspace)}`;
        const linkedTree = await fetchJson(baseUrl, `/api/files/tree?agentId=${encodeURIComponent(linkedProjectAgentId)}`);
        assert.strictEqual(linkedTree.response.status, 200);
        assert(linkedTree.body.tree.items.some(item => item.path === 'README.md'));
        const linkedWorktrees = await fetchJson(baseUrl, `/api/files/worktrees?agentId=${encodeURIComponent(linkedProjectAgentId)}`);
        assert.strictEqual(linkedWorktrees.response.status, 200);
        assert.strictEqual(linkedWorktrees.body.worktrees.currentWorkspace, canonicalLinkedWorkspace);
        assert.strictEqual(linkedWorktrees.body.worktrees.items.find(item => item.current).branch, 'topic');
        const allHistory = await fetchJson(baseUrl, '/api/files/history?agentId=agent-main&limit=1&scope=all');
        assert.strictEqual(allHistory.response.status, 200);
        assert.strictEqual(allHistory.body.history.scope, 'all');
        const historyChanges = await fetchJson(baseUrl, `/api/files/history/changes?agentId=agent-main&commit=${readmeCommit}`);
        assert.strictEqual(historyChanges.response.status, 200);
        assert.strictEqual(historyChanges.body.changes.parent, null);
        assert.strictEqual(historyChanges.body.changes.comparisonBase.length, 40);
        assert(historyChanges.body.changes.items.some(item => item.path === 'README.md' && item.status === 'added'));
        const invalidHistoryChanges = await fetchJson(baseUrl, '/api/files/history/changes?agentId=agent-main&commit=HEAD');
        assert.strictEqual(invalidHistoryChanges.response.status, 400);

        const blame = await fetchJson(baseUrl, '/api/files/blame?agentId=agent-main&path=README.md');
        assert.strictEqual(blame.response.status, 200);
        assert.strictEqual(blame.body.blame.isGitRepo, true);
        assert.strictEqual(blame.body.blame.path, 'README.md');
        assert.strictEqual(blame.body.blame.lines[0].author, 'Farming Test');
        assert.strictEqual(blame.body.blame.lines[0].summary, 'readme');

        const blameCapability = await fetchJson(baseUrl, '/api/files/blame-capability?agentId=agent-main&path=README.md');
        assert.strictEqual(blameCapability.response.status, 200);
        assert.strictEqual(blameCapability.body.capability.isGitRepo, true);
        assert.strictEqual(blameCapability.body.capability.path, 'README.md');
        assert.strictEqual(blameCapability.body.capability.available, true);

        fs.writeFileSync(path.join(projectWorkspace, 'old-name.md'), 'rename through api\n');
        execFileSync('git', ['add', 'old-name.md'], { cwd: projectWorkspace });
        execFileSync('git', ['commit', '-m', 'rename source'], { cwd: projectWorkspace, stdio: 'ignore' });
        execFileSync('git', ['mv', 'old-name.md', 'new-name.md'], { cwd: projectWorkspace });
        fs.writeFileSync(path.join(projectWorkspace, 'README.md'), '# Saved\nchanged\n');
        fs.mkdirSync(path.join(projectWorkspace, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(projectWorkspace, 'scratch/nested.log'), 'nested untracked\n');
        const playbackDir = path.join(projectWorkspace, 'demo-app/packages/viewer/playback_json');
        fs.mkdirSync(playbackDir, { recursive: true });
        execFileSync('git', ['init'], { cwd: playbackDir, stdio: 'ignore' });
        fs.mkdirSync(path.join(playbackDir, '.empty-hooks'), { recursive: true });
        execFileSync('git', ['config', 'core.hooksPath', '.empty-hooks'], { cwd: playbackDir });
        execFileSync('git', ['config', 'user.email', 'nested@example.test'], { cwd: playbackDir });
        execFileSync('git', ['config', 'user.name', 'Nested Repo'], { cwd: playbackDir });
        fs.writeFileSync(path.join(playbackDir, 'README.md'), 'nested repo\n');
        execFileSync('git', ['add', 'README.md'], { cwd: playbackDir });
        execFileSync('git', ['commit', '-m', 'nested repo'], { cwd: playbackDir, stdio: 'ignore' });
        const changes = await fetchJson(baseUrl, '/api/files/changes?agentId=agent-main');
        assert.strictEqual(changes.response.status, 200);
        assert.strictEqual(changes.body.changes.truncated, false);
        const changeByPath = new Map(changes.body.changes.items.map(item => [item.path, item]));
        assert.strictEqual(changeByPath.get('README.md').gitStatus, 'modified');
        assert.strictEqual(changeByPath.get('README.md').gitStatusLabel, 'M');
        assert.strictEqual(changeByPath.get('README.md').type, 'file');
        assert.strictEqual(changeByPath.get('new-name.md').gitStatus, 'renamed');
        assert.strictEqual(changeByPath.get('new-name.md').gitStatusLabel, 'R');
        assert.strictEqual(changeByPath.get('new-name.md').previousPath, 'old-name.md');
        assert.strictEqual(changeByPath.get('scratch/nested.log').gitStatus, 'untracked');
        assert.strictEqual(changeByPath.get('scratch/nested.log').type, 'file');
        assert.strictEqual(changeByPath.has('scratch/'), false);
        assert.strictEqual(changeByPath.get('demo-app/packages/viewer/playback_json').gitStatus, 'untracked');
        assert.strictEqual(changeByPath.get('demo-app/packages/viewer/playback_json').type, 'directory');
        const renamedDiff = await fetchJson(baseUrl, '/api/files/diff?agentId=agent-main&path=new-name.md');
        assert.strictEqual(renamedDiff.response.status, 200);
        assert.strictEqual(renamedDiff.body.diff.originalContent, 'rename through api\n');
        assert.strictEqual(renamedDiff.body.diff.modifiedContent, 'rename through api\n');
        assert.strictEqual(renamedDiff.body.diff.untracked, false);

        const lineChanges = await fetchJson(baseUrl, '/api/files/line-changes?agentId=agent-main&path=README.md&lineNumber=1&mode=working');
        assert.strictEqual(lineChanges.response.status, 200);
        assert.strictEqual(lineChanges.body.changes.isGitRepo, true);
        assert.strictEqual(lineChanges.body.changes.path, 'README.md');
        assert.strictEqual(lineChanges.body.changes.available, true);
        assert(lineChanges.body.changes.patch.includes('+changed'));
      }

      const createdDirectory = await fetchJson(baseUrl, '/api/files/entry', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          parentPath: '',
          name: 'src',
          entryType: 'directory',
        }),
      });
      assert.strictEqual(createdDirectory.response.status, 201);
      assert.strictEqual(createdDirectory.body.entry.path, 'src');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src')), true);

      const createdFile = await fetchJson(baseUrl, '/api/files/entry', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          parentPath: 'src',
          name: 'app.ts',
          entryType: 'file',
          content: 'export {}\n',
        }),
      });
      assert.strictEqual(createdFile.response.status, 201);
      assert.strictEqual(createdFile.body.entry.path, 'src/app.ts');
      assert.strictEqual(createdFile.body.file.content, 'export {}\n');

      const renamed = await fetchJson(baseUrl, '/api/files/entry', {
        method: 'PATCH',
        body: JSON.stringify({
          agentId: 'agent-main',
          path: 'src/app.ts',
          name: 'index.ts',
        }),
      });
      assert.strictEqual(renamed.response.status, 200);
      assert.strictEqual(renamed.body.move.sourcePath, 'src/app.ts');
      assert.strictEqual(renamed.body.move.targetPath, 'src/index.ts');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src', 'index.ts')), true);

      const deleted = await fetchJson(baseUrl, '/api/files/entry?agentId=agent-main&path=src%2Findex.ts', {
        method: 'DELETE',
      });
      assert.strictEqual(deleted.response.status, 200);
      assert.strictEqual(deleted.body.deleted.path, 'src/index.ts');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src', 'index.ts')), false);

      fs.mkdirSync(path.join(projectWorkspace, 'docs'), { recursive: true });
      const moved = await fetchJson(baseUrl, '/api/files/move', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          sourcePath: 'README.md',
          targetDirectory: 'docs',
        }),
      });
      assert.strictEqual(moved.response.status, 200);
      assert.strictEqual(moved.body.move.sourcePath, 'README.md');
      assert.strictEqual(moved.body.move.targetPath, 'docs/README.md');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'docs', 'README.md')), true);

      const escaped = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=../secret.txt');
      assert.strictEqual(escaped.response.status, 403);

      const missingAgent = await fetchJson(baseUrl, '/api/files/tree?agentId=missing');
      assert.strictEqual(missingAgent.response.status, 404);

      console.log('✓ Workspace file router exposes safe project-scoped file APIs');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await service.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
