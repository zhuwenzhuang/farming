const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { WorkspaceFileService } = require('../workspace-file-service.cjs');
const {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  PROJECT_FILES_WORKSPACE_PREFIX,
  createWorkspaceFileRouter,
} = require('../workspace-file-router.cjs');

type HttpServer = import('http').Server;

type WorkspaceChangeFixture = {
  gitStatus: string;
  gitStatusLabel: string;
  type: string;
  previousPath?: string;
};

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

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

async function fetchWithRetry(url, options: RequestInit = {}) {
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

async function fetchJson(baseUrl, pathname, options: RequestInit = {}) {
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

async function fetchRaw(baseUrl, pathname, options: RequestInit = {}) {
  const response = await fetchWithRetry(`${baseUrl}${pathname}`, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-file-router-'));
  const projectWorkspace = path.join(tmpRoot, 'project');
  const mainWorkspace = path.join(projectWorkspace, '.farming');
  const externalWorkspace = path.join(tmpRoot, 'external-workspace');
  const liveProjectWorkspace = path.join(tmpRoot, 'live-project');
  const agentHomeWorkspace = path.join(tmpRoot, 'agent-home');
  const projectWorkspaces = [projectWorkspace];
  let branchSwitchRequest: Record<string, unknown> | null = null;
  let branchSwitchCalls = 0;
  const branchInventory = {
    isGitRepo: true,
    workspace: projectWorkspace,
    mainWorkspace: projectWorkspace,
    currentBranch: 'feature/current',
    head: 'a'.repeat(40),
    dirtyCount: 0,
    canSwitch: true,
    blockedReason: '',
    blockedReasonCode: '',
    blockingAgentIds: [],
    items: [
      {
        name: 'feature/current',
        head: 'a'.repeat(40),
        current: true,
        checkedOutWorkspace: projectWorkspace,
      },
      { name: 'main', head: 'b'.repeat(40), current: false, checkedOutWorkspace: '' },
    ],
    truncated: false,
  };
  const service = new WorkspaceFileService({
    maxFileSize: 64,
    maxWriteSize: 1024 * 32,
    maxPreviewFileSize: 128,
  });

  try {
    fs.mkdirSync(mainWorkspace, { recursive: true });
    branchInventory.workspace = fs.realpathSync(projectWorkspace);
    branchInventory.mainWorkspace = branchInventory.workspace;
    branchInventory.items[0].checkedOutWorkspace = branchInventory.workspace;
    fs.mkdirSync(externalWorkspace, { recursive: true });
    fs.mkdirSync(liveProjectWorkspace, { recursive: true });
    fs.mkdirSync(agentHomeWorkspace, { recursive: true });
    fs.writeFileSync(path.join(liveProjectWorkspace, 'live.txt'), 'live project\n');
    fs.writeFileSync(path.join(externalWorkspace, 'reference.md'), 'external router reference\n');
    fs.symlinkSync(externalWorkspace, path.join(projectWorkspace, 'reference-link'));
    fs.writeFileSync(path.join(projectWorkspace, 'README.md'), 'hello farming\n');
    fs.mkdirSync(path.join(projectWorkspace, '..foo'), { recursive: true });
    const dotDotNameFile = path.join(projectWorkspace, '..foo', 'legal.md');
    fs.writeFileSync(dotDotNameFile, 'legal dot-dot name\n');
    fs.writeFileSync(path.join(projectWorkspace, '..foo', 'index.html'), '<link rel="stylesheet" href="legal.css"><h1>Dot-dot name</h1>\n');
    fs.writeFileSync(path.join(projectWorkspace, '..foo', 'legal.css'), 'h1 { color: rgb(7, 8, 9); }\n');
    fs.writeFileSync(path.join(projectWorkspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(projectWorkspace, 'large.log'), `${'large text line\n'.repeat(8)}`);
    fs.writeFileSync(path.join(projectWorkspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64'
    ));
    fs.writeFileSync(path.join(projectWorkspace, 'icon.svg'), '<svg><rect/></svg>\n');
    fs.mkdirSync(path.join(projectWorkspace, 'site', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectWorkspace, 'site', 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>Preview</h1>\n');
    fs.writeFileSync(path.join(projectWorkspace, 'site', 'assets', 'site.css'), 'h1 { color: rgb(1, 2, 3); }\n');
    fs.writeFileSync(path.join(projectWorkspace, 'site', 'UPPER.HTML'), '<link href="/root.css"><img src="/root.png"><h1>Uppercase</h1>\n');
    fs.writeFileSync(path.join(projectWorkspace, 'site', 'assets', 'space name.css'), 'body { color: purple; }\n');
    fs.writeFileSync(path.join(projectWorkspace, 'site', 'assets', 'large.dat'), Buffer.alloc(256, 1));
    fs.mkdirSync(path.join(projectWorkspace, 'site', 'folder.html'));
    const globalReadFile = path.join(projectWorkspace, 'global-note.md');
    fs.writeFileSync(globalReadFile, 'global file\n');
    const forbiddenGlobalReadFile = path.join(tmpRoot, 'outside-project.md');
    fs.writeFileSync(forbiddenGlobalReadFile, 'outside project\n');
    fs.symlinkSync(forbiddenGlobalReadFile, path.join(projectWorkspace, 'site', 'escape-link.md'));
    fs.symlinkSync(forbiddenGlobalReadFile, path.join(projectWorkspace, '..foo', 'escape-link.md'));
    const exactExternalPreviewFile = path.join(tmpRoot, 'outside-project.png');
    fs.writeFileSync(exactExternalPreviewFile, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64'
    ));
    const exactExternalHtmlRoot = path.join(tmpRoot, 'external-site');
    fs.mkdirSync(path.join(exactExternalHtmlRoot, 'assets'), { recursive: true });
    const exactExternalHtmlFile = path.join(exactExternalHtmlRoot, 'index.html');
    fs.writeFileSync(exactExternalHtmlFile, '<link rel="stylesheet" href="assets/site.css"><h1>External preview</h1>\n');
    fs.writeFileSync(path.join(exactExternalHtmlRoot, 'assets', 'site.css'), 'h1 { color: rgb(4, 5, 6); }\n');
    fs.symlinkSync(forbiddenGlobalReadFile, path.join(exactExternalHtmlRoot, 'assets', 'escape.md'));

    const agentManager = {
      configManager: {
        getSettings() {
          return {
            workspaceHistory: [externalWorkspace],
            projectWorkspaces,
            agentHomes: { codex: [{ id: 'test-home', path: agentHomeWorkspace }] },
          };
        },
      },
      getAgentWorkspaceRoot(agentId) {
        if (agentId === 'agent-main') return projectWorkspace;
        return null;
      },
      getState() {
        return {
          agents: [
            { id: 'agent-main', cwd: mainWorkspace, projectWorkspace, isMain: true },
            { id: 'agent-live', cwd: liveProjectWorkspace, projectWorkspace: liveProjectWorkspace, isMain: false },
          ],
        };
      },
      async inspectProjectBranches(workspace) {
        assert.strictEqual(workspace, branchInventory.workspace);
        return branchInventory;
      },
      async switchProjectBranch(workspace, request) {
        assert.strictEqual(workspace, branchInventory.workspace);
        branchSwitchCalls += 1;
        branchSwitchRequest = request;
        if (request.branch === 'blocked') {
          return {
            inventory: {
              ...branchInventory,
              canSwitch: false,
              blockedReason: 'Workspace has one uncommitted change',
              blockedReasonCode: 'dirty-worktree',
              dirtyCount: 1,
            },
            switched: false,
            uncertain: false,
            error: 'Workspace has one uncommitted change',
          };
        }
        if (request.branch === 'uncertain') {
          return {
            switched: false,
            uncertain: true,
            error: 'Fresh Git state could not be inspected',
          };
        }
        return {
          inventory: {
            ...branchInventory,
            currentBranch: 'main',
            head: 'b'.repeat(40),
            items: branchInventory.items.map(item => ({
              ...item,
              current: item.name === 'main',
              checkedOutWorkspace: item.name === 'main' ? branchInventory.workspace : '',
            })),
          },
          switched: true,
          uncertain: false,
          previousBranch: 'feature/current',
          previousHead: 'a'.repeat(40),
        };
      },
    };

    const app = express();
    app.use((req, _res, next) => {
      if (req.headers['x-farming-test-access'] === 'read-only') {
        (req as typeof req & { authAccessMode?: 'read-only' }).authAccessMode = 'read-only';
      }
      next();
    });
    app.use('/api/files', createWorkspaceFileRouter(agentManager, service));
    const server = await new Promise<HttpServer>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

    try {
      const tree = await fetchJson(baseUrl, '/api/files/tree?agentId=agent-main');
      assert.strictEqual(tree.response.status, 200);
      assert(tree.body.tree.items.some(item => item.path === 'README.md'));
      const configuredProjectId = `${PROJECT_FILES_WORKSPACE_PREFIX}${encodeURIComponent(projectWorkspace)}`;
      const configuredProjectTree = await fetchJson(baseUrl, `/api/files/tree?agentId=${encodeURIComponent(configuredProjectId)}`);
      assert.strictEqual(configuredProjectTree.response.status, 200);
      const liveProjectId = `${PROJECT_FILES_WORKSPACE_PREFIX}${encodeURIComponent(liveProjectWorkspace)}`;
      const liveProjectTree = await fetchJson(baseUrl, `/api/files/tree?agentId=${encodeURIComponent(liveProjectId)}`);
      assert.strictEqual(liveProjectTree.response.status, 200);
      assert(liveProjectTree.body.tree.items.some(item => item.path === 'live.txt'));
      const unrelatedProjectId = `${PROJECT_FILES_WORKSPACE_PREFIX}${encodeURIComponent(path.join(liveProjectWorkspace, 'nested'))}`;
      const unrelatedProjectTree = await fetchJson(baseUrl, `/api/files/tree?agentId=${encodeURIComponent(unrelatedProjectId)}`);
      assert.strictEqual(unrelatedProjectTree.response.status, 404);
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
      const branches = await fetchJson(baseUrl, '/api/files/branches?agentId=agent-main');
      assert.strictEqual(branches.response.status, 200);
      assert.deepStrictEqual(branches.body, branchInventory);
      const switchedBranch = await fetchJson(baseUrl, '/api/files/switch-branch', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          branch: 'main',
          expectedBranch: 'feature/current',
          expectedHead: 'a'.repeat(40),
          requestId: 'file-router-switch-branch',
        }),
      });
      assert.strictEqual(switchedBranch.response.status, 200);
      assert.strictEqual(switchedBranch.body.switched, true);
      assert.strictEqual(switchedBranch.body.uncertain, false);
      assert.strictEqual(switchedBranch.body.currentBranch, 'main');
      assert.strictEqual(switchedBranch.body.requestId, 'file-router-switch-branch');
      assert.deepStrictEqual(branchSwitchRequest, {
        branch: 'main',
        expectedBranch: 'feature/current',
        expectedHead: 'a'.repeat(40),
        requestId: 'file-router-switch-branch',
      });
      const roots = await fetchJson(baseUrl, '/api/files/roots');
      const agentHomeRoot = roots.body.roots.find(root => root.kind === 'agent-home');
      assert(agentHomeRoot);
      const branchSwitchCallsBeforeAgentHome = branchSwitchCalls;
      const agentHomeBranchSwitch = await fetchJson(baseUrl, '/api/files/switch-branch', {
        method: 'POST',
        body: JSON.stringify({
          rootId: agentHomeRoot.rootId,
          branch: 'main',
          expectedBranch: 'feature/current',
          expectedHead: 'a'.repeat(40),
          requestId: 'file-router-agent-home-switch',
        }),
      });
      assert.strictEqual(agentHomeBranchSwitch.response.status, 403);
      assert.strictEqual(branchSwitchCalls, branchSwitchCallsBeforeAgentHome);
      const invalidBranchSwitch = await fetchJson(baseUrl, '/api/files/switch-branch', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          branch: 'main',
          expectedBranch: 'feature/current',
          expectedHead: 'a'.repeat(40),
          requestId: 'invalid request id',
        }),
      });
      assert.strictEqual(invalidBranchSwitch.response.status, 400);
      const blockedBranchSwitch = await fetchJson(baseUrl, '/api/files/switch-branch', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          branch: 'blocked',
          expectedBranch: 'feature/current',
          expectedHead: 'a'.repeat(40),
          requestId: 'file-router-switch-branch-blocked',
        }),
      });
      assert.strictEqual(blockedBranchSwitch.response.status, 409);
      assert.strictEqual(blockedBranchSwitch.body.switched, false);
      assert.strictEqual(blockedBranchSwitch.body.uncertain, false);
      assert.strictEqual(blockedBranchSwitch.body.blockedReasonCode, 'dirty-worktree');
      const uncertainBranchSwitch = await fetchJson(baseUrl, '/api/files/switch-branch', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          branch: 'uncertain',
          expectedBranch: 'feature/current',
          expectedHead: 'a'.repeat(40),
          requestId: 'file-router-switch-branch-uncertain',
        }),
      });
      assert.strictEqual(uncertainBranchSwitch.response.status, 504);
      assert.strictEqual(uncertainBranchSwitch.body.switched, false);
      assert.strictEqual(uncertainBranchSwitch.body.uncertain, true);
      assert.strictEqual(uncertainBranchSwitch.body.currentBranch, undefined);
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
      assert.strictEqual(read.response.headers.get('cache-control'), 'no-store');
      assert.strictEqual(read.body.file.content, 'hello farming\n');
      const globalReadPath = globalReadFile.replace(/^\/+/, '');
      const globalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(globalReadPath)}`);
      assert.strictEqual(globalRead.response.status, 200);
      assert.strictEqual(globalRead.body.root, '/');
      assert.strictEqual(globalRead.body.file.content, 'global file\n');
      const forbiddenGlobalReadPath = forbiddenGlobalReadFile.replace(/^\/+/, '');
      const forbiddenGlobalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(forbiddenGlobalReadPath)}`);
      assert.strictEqual(forbiddenGlobalRead.response.status, 403);
      const exactExternalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(forbiddenGlobalReadPath)}&exact=1`);
      assert.strictEqual(exactExternalRead.response.status, 200);
      assert.strictEqual(exactExternalRead.body.file.content, 'outside project\n');
      const readOnlyWorkspaceRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(globalReadPath)}`, {
        headers: { 'X-Farming-Test-Access': 'read-only' },
      });
      assert.strictEqual(readOnlyWorkspaceRead.response.status, 200);
      const readOnlyExactExternalRead = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(forbiddenGlobalReadPath)}&exact=1`, {
        headers: { 'X-Farming-Test-Access': 'read-only' },
      });
      assert.strictEqual(readOnlyExactExternalRead.response.status, 403);
      const exactExternalDirectory = await fetchJson(baseUrl, `/api/files/file?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(tmpRoot.replace(/^\/+/, ''))}&exact=1`);
      assert.strictEqual(exactExternalDirectory.response.status, 400);
      const exactExternalRaw = await fetchRaw(baseUrl, `/api/files/raw?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(exactExternalPreviewFile.replace(/^\/+/, ''))}&exact=1`);
      assert.strictEqual(exactExternalRaw.response.status, 200);
      assert(exactExternalRaw.response.headers.get('content-type').includes('image/png'));
      const readOnlyExactExternalRaw = await fetchRaw(baseUrl, `/api/files/raw?agentId=${GLOBAL_WORKSPACE_FILES_AGENT_ID}&path=${encodeURIComponent(exactExternalPreviewFile.replace(/^\/+/, ''))}&exact=1`, {
        headers: { 'X-Farming-Test-Access': 'read-only' },
      });
      assert.strictEqual(readOnlyExactExternalRaw.response.status, 403);
      const exactExternalHtmlPath = exactExternalHtmlFile.replace(/^\/+/, '');
      const deniedExternalHtmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: GLOBAL_WORKSPACE_FILES_AGENT_ID, path: exactExternalHtmlPath }),
      });
      assert.strictEqual(deniedExternalHtmlPreview.response.status, 403);
      const exactExternalHtmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({
          agentId: GLOBAL_WORKSPACE_FILES_AGENT_ID,
          path: exactExternalHtmlPath,
          exact: true,
        }),
      });
      assert.strictEqual(exactExternalHtmlPreview.response.status, 201);
      const exactExternalHtmlPreviewId = exactExternalHtmlPreview.body.preview.id;
      const exactExternalHtmlCss = await fetchRaw(baseUrl, `/api/files/previews/${exactExternalHtmlPreviewId}/base/assets/site.css`);
      assert.strictEqual(exactExternalHtmlCss.response.status, 200);
      assert(exactExternalHtmlCss.buffer.toString('utf8').includes('rgb(4, 5, 6)'));
      const exactExternalHtmlEscape = await fetchJson(baseUrl, `/api/files/previews/${exactExternalHtmlPreviewId}/base/..%2Foutside-project.md`);
      assert.strictEqual(exactExternalHtmlEscape.response.status, 403);
      const exactExternalHtmlSymlinkEscape = await fetchJson(baseUrl, `/api/files/previews/${exactExternalHtmlPreviewId}/base/assets/escape.md`);
      assert.strictEqual(exactExternalHtmlSymlinkEscape.response.status, 403);
      const exactExternalRootScopeEscape = await fetchJson(baseUrl, `/api/files/previews/${exactExternalHtmlPreviewId}/root/${forbiddenGlobalReadPath}`);
      assert.strictEqual(exactExternalRootScopeEscape.response.status, 403);
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

      const dotDotNamePreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: '..foo/index.html' }),
      });
      assert.strictEqual(dotDotNamePreview.response.status, 201);
      const dotDotNamePreviewId = dotDotNamePreview.body.preview.id;
      const dotDotNamePreviewHtml = await fetchRaw(baseUrl, `/api/files/previews/${dotDotNamePreviewId}/base/index.html`);
      assert.strictEqual(dotDotNamePreviewHtml.response.status, 200);
      assert(dotDotNamePreviewHtml.buffer.toString('utf8').includes('Dot-dot name'));
      const dotDotNamePreviewCss = await fetchRaw(baseUrl, `/api/files/previews/${dotDotNamePreviewId}/base/legal.css`);
      assert.strictEqual(dotDotNamePreviewCss.response.status, 200);
      assert(dotDotNamePreviewCss.buffer.toString('utf8').includes('rgb(7, 8, 9)'));
      const dotDotNamePreviewEscape = await fetchJson(baseUrl, `/api/files/previews/${dotDotNamePreviewId}/base/escape-link.md`);
      assert.strictEqual(dotDotNamePreviewEscape.response.status, 403);

      const htmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: 'site/index.html' }),
      });
      assert.strictEqual(htmlPreview.response.status, 201);
      assert.strictEqual(htmlPreview.body.preview.kind, 'static');
      assert(Number.isFinite(htmlPreview.body.preview.expiresAt));
      const previewId = htmlPreview.body.preview.id;
      const previewHtml = await fetchRaw(baseUrl, `/api/files/previews/${previewId}/base/index.html`);
      assert.strictEqual(previewHtml.response.status, 200);
      assert(previewHtml.response.headers.get('content-type').includes('text/html'));
      assert(previewHtml.response.headers.get('content-security-policy').includes("script-src 'none'"));
      assert.strictEqual(previewHtml.response.headers.get('cache-control'), 'no-store');
      assert.strictEqual(previewHtml.response.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(Number(previewHtml.response.headers.get('content-length')), previewHtml.buffer.length);
      assert(previewHtml.buffer.toString('utf8').includes('<h1>Preview</h1>'));
      const previewCss = await fetchRaw(baseUrl, `/api/files/previews/${previewId}/base/assets/site.css`);
      assert.strictEqual(previewCss.response.status, 200);
      assert(previewCss.response.headers.get('content-type').includes('text/css'));
      assert(previewCss.buffer.toString('utf8').includes('rgb(1, 2, 3)'));
      const previewCssWithSpace = await fetchRaw(baseUrl, `/api/files/previews/${previewId}/base/assets/space%20name.css`);
      assert.strictEqual(previewCssWithSpace.response.status, 200);
      assert(previewCssWithSpace.buffer.toString('utf8').includes('purple'));
      const oversizedPreviewAsset = await fetchJson(baseUrl, `/api/files/previews/${previewId}/base/assets/large.dat`);
      assert.strictEqual(oversizedPreviewAsset.response.status, 413);
      const missingPreviewAsset = await fetchJson(baseUrl, `/api/files/previews/${previewId}/base/assets/missing.css`);
      assert.strictEqual(missingPreviewAsset.response.status, 404);
      const invalidPreviewScope = await fetchJson(baseUrl, `/api/files/previews/${previewId}/invalid/index.html`);
      assert.strictEqual(invalidPreviewScope.response.status, 400);
      const previewEscape = await fetchJson(baseUrl, `/api/files/previews/${previewId}/base/..%2F..%2Foutside-project.md`);
      assert.strictEqual(previewEscape.response.status, 403);
      const previewSymlinkEscape = await fetchJson(baseUrl, `/api/files/previews/${previewId}/base/escape-link.md`);
      assert.strictEqual(previewSymlinkEscape.response.status, 403);
      const deletedPreview = await fetchWithRetry(`${baseUrl}/api/files/previews/${previewId}`, { method: 'DELETE' });
      assert.strictEqual(deletedPreview.status, 204);
      const expiredPreview = await fetchJson(baseUrl, `/api/files/previews/${previewId}/base/index.html`);
      assert.strictEqual(expiredPreview.response.status, 404);
      const nonHtmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: 'README.md' }),
      });
      assert.strictEqual(nonHtmlPreview.response.status, 415);
      const uppercaseHtmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: 'site/UPPER.HTML' }),
      });
      assert.strictEqual(uppercaseHtmlPreview.response.status, 201);
      const uppercasePreviewId = uppercaseHtmlPreview.body.preview.id;
      const rewrittenUppercaseHtml = await fetchRaw(baseUrl, `/api/files/previews/${uppercasePreviewId}/base/UPPER.HTML`);
      assert.strictEqual(rewrittenUppercaseHtml.response.status, 200);
      const rewrittenUppercaseSource = rewrittenUppercaseHtml.buffer.toString('utf8');
      assert(rewrittenUppercaseSource.includes(`/api/files/previews/${uppercasePreviewId}/root/root.css`));
      assert(rewrittenUppercaseSource.includes(`/api/files/previews/${uppercasePreviewId}/root/root.png`));
      assert.strictEqual(Number(rewrittenUppercaseHtml.response.headers.get('content-length')), rewrittenUppercaseHtml.buffer.length);
      const htmlDirectoryPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: 'site/folder.html' }),
      });
      assert.strictEqual(htmlDirectoryPreview.response.status, 400);
      const missingHtmlPreview = await fetchJson(baseUrl, '/api/files/previews', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-main', path: 'site/missing.html' }),
      });
      assert.strictEqual(missingHtmlPreview.response.status, 404);

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
        const linkedProjectAgentId = `${PROJECT_FILES_WORKSPACE_PREFIX}${encodeURIComponent(linkedWorkspace)}`;
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
        const changeByPath = new Map<string, WorkspaceChangeFixture>(
          changes.body.changes.items.map(item => [item.path, item]),
        );
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
      assert(createdFile.body.entry.version);

      const renamed = await fetchJson(baseUrl, '/api/files/entry', {
        method: 'PATCH',
        body: JSON.stringify({
          agentId: 'agent-main',
          path: 'src/app.ts',
          name: 'index.ts',
          expectedVersion: createdFile.body.entry.version,
        }),
      });
      assert.strictEqual(renamed.response.status, 200);
      assert.strictEqual(renamed.body.move.sourcePath, 'src/app.ts');
      assert.strictEqual(renamed.body.move.targetPath, 'src/index.ts');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src', 'index.ts')), true);

      const staleDelete = await fetchJson(
        baseUrl,
        '/api/files/entry?agentId=agent-main&path=src%2Findex.ts&expectedVersion=stale',
        { method: 'DELETE' }
      );
      assert.strictEqual(staleDelete.response.status, 409);
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src', 'index.ts')), true);

      const deleted = await fetchJson(
        baseUrl,
        `/api/files/entry?agentId=agent-main&path=src%2Findex.ts&expectedVersion=${renamed.body.move.targetVersion}`,
        {
        method: 'DELETE',
        }
      );
      assert.strictEqual(deleted.response.status, 200);
      assert.strictEqual(deleted.body.deleted.path, 'src/index.ts');
      assert.strictEqual(fs.existsSync(path.join(projectWorkspace, 'src', 'index.ts')), false);

      fs.mkdirSync(path.join(projectWorkspace, 'docs'), { recursive: true });
      const treeBeforeMove = await fetchJson(baseUrl, '/api/files/tree?agentId=agent-main');
      const readmeBeforeMove = treeBeforeMove.body.tree.items.find(item => item.path === 'README.md');
      const moved = await fetchJson(baseUrl, '/api/files/move', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'agent-main',
          sourcePath: 'README.md',
          targetDirectory: 'docs',
          expectedVersion: readmeBeforeMove.version,
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
