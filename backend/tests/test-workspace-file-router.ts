const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PreviewSessionManager } = require('../preview-session-manager.cjs');
const { WorkspaceFileService } = require('../workspace-file-service.cjs');
const {
  createWorkspaceFileRouter,
  executeWorkspaceFileRequest,
} = require('../workspace-file-router.cjs');

type HttpServer = import('http').Server;

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function fetchJson(baseUrl: string, pathname: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

async function fetchRaw(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { response, buffer: Buffer.from(await response.arrayBuffer()) };
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-file-transport-'));
  const workspace = path.join(tempRoot, 'project');
  const previewSessions = new PreviewSessionManager();
  const service = new WorkspaceFileService({
    maxFileSize: 256,
    maxWriteSize: 1024 * 32,
    maxPreviewFileSize: 128,
  });
  let branchRequest: Record<string, unknown> | null = null;

  try {
    fs.mkdirSync(path.join(workspace, 'site', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), 'hello farming\n');
    fs.writeFileSync(path.join(workspace, 'large.log'), 'large text line\n'.repeat(8));
    fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(workspace, 'site', 'index.html'), '<link rel="stylesheet" href="assets/site.css"><h1>Preview</h1>\n');
    fs.writeFileSync(path.join(workspace, 'site', 'assets', 'site.css'), 'h1 { color: green; }\n');

    const agentManager = {
      configManager: {
        getSettings: () => ({ projectWorkspaces: [workspace], workspaceHistory: [] }),
      },
      getAgentWorkspaceRoot: (agentId: string) => agentId === 'agent-main' ? workspace : null,
      getState: () => ({
        agents: [{ id: 'agent-main', cwd: workspace, projectWorkspace: workspace, isMain: true }],
      }),
      inspectProjectBranches: async () => ({
        isGitRepo: true,
        workspace,
        mainWorkspace: workspace,
        currentBranch: 'main',
        head: 'a'.repeat(40),
        dirtyCount: 0,
        canSwitch: true,
        blockedReason: '',
        blockedReasonCode: '',
        blockingAgentIds: [],
        items: [],
        truncated: false,
      }),
      switchProjectBranch: async (_workspace: string, request: Record<string, unknown>) => {
        branchRequest = request;
        return { switched: true, uncertain: false, previousBranch: 'main', previousHead: 'a'.repeat(40) };
      },
    };
    const requestOptions = { previewSessionManager: previewSessions, maxInlineResponseBytes: 32 };

    const tree = await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'tree', rootId: 'agent-main', path: '',
    }, requestOptions);
    assert(tree.items.some((item: { path: string }) => item.path === 'README.md'));

    const read = await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'read-file', rootId: 'agent-main', path: 'README.md',
    }, { ...requestOptions, maxInlineResponseBytes: 1024 });
    assert.strictEqual(read.content, 'hello farming\n');

    const largeRead = await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'read-file', rootId: 'agent-main', path: 'large.log',
    }, requestOptions);
    assert.deepStrictEqual(largeRead.transfer, { kind: 'http' });
    assert.strictEqual(largeRead.content, '');

    await assert.rejects(
      executeWorkspaceFileRequest(agentManager, service, {
        operation: 'delete-entry', rootId: 'agent-main', path: 'README.md',
      }, { accessMode: 'read-only' }),
      (error: Error) => /read-only/.test(error.message),
    );

    await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'create-entry', rootId: 'agent-main', parentPath: '', name: 'draft.md', entryType: 'file',
    });
    await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'save-file', rootId: 'agent-main', path: 'draft.md', content: 'draft\n', overwrite: true,
    });
    const renamed = await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'rename-entry', rootId: 'agent-main', path: 'draft.md', name: 'ready.md',
    });
    assert.strictEqual(renamed.targetPath, 'ready.md');
    await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'delete-entry', rootId: 'agent-main', path: 'ready.md',
    });
    assert.strictEqual(fs.existsSync(path.join(workspace, 'ready.md')), false);

    await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'switch-branch',
      rootId: 'agent-main',
      branch: 'feature/ws',
      expectedBranch: 'main',
      expectedHead: 'a'.repeat(40),
      operationId: 'switch-1',
    });
    assert.strictEqual(branchRequest?.requestId, 'switch-1');

    const preview = await executeWorkspaceFileRequest(agentManager, service, {
      operation: 'create-preview', rootId: 'agent-main', path: 'site/index.html',
    }, requestOptions);

    const app = express();
    app.use('/api/files', createWorkspaceFileRouter(agentManager, service, {
      previewSessionManager: previewSessions,
    }));
    const server = await new Promise<HttpServer>(resolve => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
      for (const legacy of ['/tree?agentId=agent-main', '/file?agentId=agent-main&path=README.md', '/search?agentId=agent-main&q=hello']) {
        const response = await fetch(`${baseUrl}/api/files${legacy}`);
        assert.strictEqual(response.status, 404, `${legacy} must not keep an HTTP control-plane fallback`);
      }

      const transferred = await fetchRaw(
        baseUrl,
        `/api/files/raw?agentId=agent-main&path=large.log&transfer=1&sha1=${largeRead.sha1}`,
      );
      assert.strictEqual(transferred.response.status, 200);
      assert.strictEqual(transferred.buffer.toString('utf8'), 'large text line\n'.repeat(8));

      const stale = await fetchJson(
        baseUrl,
        '/api/files/raw?agentId=agent-main&path=large.log&transfer=1&sha1=stale',
      );
      assert.strictEqual(stale.response.status, 409);

      const binary = await fetchJson(baseUrl, '/api/files/raw?agentId=agent-main&path=binary.bin');
      assert.strictEqual(binary.response.status, 415);

      const html = await fetchRaw(baseUrl, `/api/files/previews/${preview.id}/base/index.html`);
      assert.strictEqual(html.response.status, 200);
      assert.match(html.buffer.toString('utf8'), /Preview/);
      const css = await fetchRaw(baseUrl, `/api/files/previews/${preview.id}/base/assets/site.css`);
      assert.strictEqual(css.response.status, 200);
      assert.match(css.buffer.toString('utf8'), /green/);

      const save = await fetchJson(baseUrl, '/api/files/file', {
        method: 'PUT',
        body: JSON.stringify({ agentId: 'agent-main', path: 'bulk.txt', content: 'bulk\n', overwrite: true }),
      });
      assert.strictEqual(save.response.status, 200);
      assert.strictEqual(fs.readFileSync(path.join(workspace, 'bulk.txt'), 'utf8'), 'bulk\n');

      const deleted = await executeWorkspaceFileRequest(agentManager, service, {
        operation: 'delete-preview', rootId: 'agent-main', previewId: preview.id,
      }, requestOptions);
      assert.strictEqual(deleted.deleted, true);
      const expired = await fetch(`${baseUrl}/api/files/previews/${preview.id}/base/index.html`);
      assert.strictEqual(expired.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await service.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.strictEqual(fs.existsSync(tempRoot), false);
  console.log('Workspace File WebSocket control and HTTP data-plane regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
