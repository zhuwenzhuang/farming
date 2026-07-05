const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { WorkspaceFileService } = require('../workspace-file-service');
const { createWorkspaceFileRouter } = require('../workspace-file-router');

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
  const service = new WorkspaceFileService({ maxFileSize: 64, maxWriteSize: 1024 * 32 });

  try {
    fs.mkdirSync(mainWorkspace, { recursive: true });
    fs.writeFileSync(path.join(projectWorkspace, 'README.md'), 'hello farming\n');
    fs.writeFileSync(path.join(projectWorkspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(projectWorkspace, 'large.log'), `${'large text line\n'.repeat(8)}`);
    fs.writeFileSync(path.join(projectWorkspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64'
    ));

    const agentManager = {
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

      const read = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=README.md');
      assert.strictEqual(read.response.status, 200);
      assert.strictEqual(read.body.file.content, 'hello farming\n');

      const previewFile = await fetchJson(baseUrl, '/api/files/file?agentId=agent-main&path=preview.png');
      assert.strictEqual(previewFile.response.status, 200);
      assert.strictEqual(previewFile.body.file.binary, true);
      assert.strictEqual(previewFile.body.file.preview.mediaType, 'image/png');
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
        const changes = await fetchJson(baseUrl, '/api/files/changes?agentId=agent-main');
        assert.strictEqual(changes.response.status, 200);
        assert.strictEqual(changes.body.changes.truncated, false);
        const changeByPath = new Map(changes.body.changes.items.map(item => [item.path, item]));
        assert.strictEqual(changeByPath.get('README.md').gitStatus, 'modified');
        assert.strictEqual(changeByPath.get('README.md').gitStatusLabel, 'M');
        assert.strictEqual(changeByPath.get('new-name.md').gitStatus, 'renamed');
        assert.strictEqual(changeByPath.get('new-name.md').gitStatusLabel, 'R');
        assert.strictEqual(changeByPath.get('new-name.md').previousPath, 'old-name.md');
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
