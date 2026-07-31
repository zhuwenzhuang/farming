const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const {
  ComputerResourceManager,
} = require('../../extensions/computer/backend/computer-resource-manager.cjs');
const {
  createComputerRouter,
} = require('../../extensions/computer/backend/computer-router.cjs');
const {
  COMPUTER_IMAGE,
} = require('../../extensions/computer/backend/computer-constants.cjs');
const storageLayout = require('../storage-layout.cjs');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  applyComputerResource,
  applyComputerResourceDeletion,
  applyComputerResourceSnapshot,
  emptyComputerResourceState,
} = importTsModule('extensions/computer/frontend/computer-resource-state.ts');

const CONTAINER_ID = 'a'.repeat(64);

function computerResource(id: string, revision: number, collectionRevision: number) {
  return {
    id,
    ownerAgentId: 'agent_owner',
    projectRootId: 'root_project',
    workspace: '/tmp/project',
    name: id,
    status: 'running',
    generation: 1,
    revision,
    collectionRevision,
    controlOwner: 'agent',
    controlEpoch: 0,
    needsObserve: false,
    containerId: CONTAINER_ID,
    containerName: `farming-${id}`,
    viewerPort: 5901,
    sessionId: `session-${id}`,
    error: '',
    createdAt: revision,
    updatedAt: revision,
  };
}

function testComputerResourceRevisionOrdering() {
  const snapshot = applyComputerResourceSnapshot(emptyComputerResourceState(), {
    collectionRevision: 5,
    resources: [],
  });
  const computerA = computerResource('computer_a', 2, 7);
  const computerB = computerResource('computer_b', 1, 6);
  assert.strictEqual(
    applyComputerResource(snapshot, computerResource('covered', 1, 4)),
    snapshot,
    'Computer updates already covered by a snapshot must be ignored',
  );
  const withA = applyComputerResource(snapshot, computerA);
  const withBoth = applyComputerResource(withA, computerB);
  assert.deepStrictEqual(
    withBoth.resources.map(resource => resource.id).sort(),
    ['computer_a', 'computer_b'],
    'A lower collection revision for another Computer must survive cross-transport reordering',
  );
  assert.strictEqual(
    applyComputerResourceDeletion(withBoth, {
      id: computerA.id,
      collectionRevision: 6,
    }).resources.length,
    2,
    'A delayed delete must not remove a newer Computer revision',
  );
  const withoutB = applyComputerResourceDeletion(withBoth, {
    id: computerB.id,
    collectionRevision: 8,
  });
  assert.strictEqual(
    applyComputerResource(withoutB, computerResource(computerB.id, 1, 7)),
    withoutB,
    'A delayed update must not resurrect a deleted Computer',
  );
  assert.deepStrictEqual(
    applyComputerResourceSnapshot(withoutB, { collectionRevision: 9, resources: [] }).resources,
    [],
    'A reconnect snapshot must correct Computer incremental state',
  );
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function requestJson(port, method, route, body, headers = {}) {
  return new Promise<{
    status: number | undefined;
    body: {
      code?: string;
      resources?: unknown[];
      [key: string]: unknown;
    };
  }>((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: route,
      headers: {
        ...(payload ? {
          'Content-Length': payload.length,
          'Content-Type': 'application/json',
        } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    request.on('error', reject);
    if (payload) request.end(payload);
    else request.end();
  });
}

class FakeDocker {
  viewerPort: number;
  running: boolean;
  removed: boolean;
  labels: Record<string, string>;
  calls: string[][];
  toolCalls: string[];
  blockTool: string | null;
  releaseTool: (() => void) | null;
  blockRemove: boolean;
  releaseRemove: (() => void) | null;

  constructor(viewerPort) {
    this.viewerPort = viewerPort;
    this.running = false;
    this.removed = false;
    this.labels = {};
    this.calls = [];
    this.toolCalls = [];
    this.blockTool = null;
    this.releaseTool = null;
    this.blockRemove = false;
    this.releaseRemove = null;
  }

  run = async args => {
    this.calls.push([...args]);
    if (args[0] === 'version') return { stdout: '20.10.18\n', stderr: '' };
    if (args[0] === 'pull') return { stdout: 'pulled\n', stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { stdout: 'sha256:image\n', stderr: '' };
    }
    if (args[0] === 'run') {
      if (args.includes('farming.dev/kind=computer-browser-probe')) {
        return { stdout: 'Chromium 140.0\n', stderr: '' };
      }
      return { stdout: 'cua-driver 0.12.4\n', stderr: '' };
    }
    if (args[0] === 'create') {
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--label') continue;
        const [key, ...rest] = args[index + 1].split('=');
        this.labels[key] = rest.join('=');
      }
      this.removed = false;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (this.removed) throw new Error('No such container');
      return {
        stdout: JSON.stringify([{
          Id: CONTAINER_ID,
          Config: { Labels: this.labels },
          State: { Running: this.running },
          NetworkSettings: {
            Ports: {
              '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.viewerPort) }],
              '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.viewerPort) }],
            },
          },
          HostConfig: {
            PortBindings: {
              '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
              '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
            },
          },
          Mounts: [{
            Destination: '/opt/farming/chromium',
            RW: false,
          }],
        }]),
        stderr: '',
      };
    }
    if (args[0] === 'start') {
      this.running = true;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'stop') {
      this.running = false;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'rm') {
      if (this.blockRemove) {
        await new Promise<void>(resolve => {
          this.releaseRemove = resolve;
        });
      }
      this.removed = true;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'exec') {
      if (args.includes('--version')) {
        return { stdout: 'cua-driver 0.12.4\n', stderr: '' };
      }
      const callIndex = args.indexOf('call');
      if (callIndex >= 0) {
        const tool = args[callIndex + 1];
        this.toolCalls.push(tool);
        if (this.blockTool === tool) {
          await new Promise<void>(resolve => {
            this.releaseTool = resolve;
          });
        }
        return {
          stdout: JSON.stringify({ ok: true, tool }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected docker call: ${args.join(' ')}`);
  };
}

async function run() {
  testComputerResourceRevisionOrdering();
  const viewerConnectionHeaders = [];
  const viewer = http.createServer((_request, response) => {
    viewerConnectionHeaders.push(_request.headers.connection);
    response.statusCode = 200;
    response.end('viewer');
  });
  const viewerPort = await listen(viewer);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-computer-extension-'));
  const workspace = path.join(tempDir, 'project');
  fs.mkdirSync(workspace);
  const fake = new FakeDocker(viewerPort);
  const settings = {
    computerCompatibilityMode: false,
    computerImage: COMPUTER_IMAGE,
  };
  const manager = new ComputerResourceManager({
    configDir: tempDir,
    isEnabled: () => true,
    getSettings: () => settings,
    dockerRunner: fake.run,
  });
  manager.store.init();

  try {
    const capability = await manager.capability();
    assert.strictEqual(capability.dockerAvailable, true);
    assert.strictEqual(capability.imageReady, true);
    assert.strictEqual(capability.driverVersion, '0.12.4');

    const prepared = await manager.prepare();
    assert.strictEqual(prepared.available, true);

    const created = manager.create({
      ownerAgentId: 'agent_owner',
      projectRootId: 'root_project',
      workspace,
      name: 'Owned Computer',
    });
    const same = manager.create({
      ownerAgentId: 'agent_owner',
      projectRootId: 'root_project',
      workspace,
    });
    assert.strictEqual(same.id, created.id, 'one Agent should own at most one Computer');
    assert.strictEqual(created.vncPassword, undefined, 'public state must not expose Viewer password');

    const running = await manager.start(created.id);
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(fake.running, true);
    assert.strictEqual(fake.labels['farming.dev/resource'], created.id);
    assert.strictEqual(fake.labels['farming.dev/owner-agent'], 'agent_owner');
    assert.strictEqual(manager.viewerConfig(created.id).viewOnly, true);
    assert(fake.calls.some(args =>
      args[0] === 'create'
      && args.includes('127.0.0.1::9223')
      && args.some(value => String(value).endsWith(':/opt/farming/chromium:ro'))
    ));

    const browserExecutable = path.join(
      storageLayout.managedChromiumRootDir(tempDir),
      '0.32.3',
      'linux-x64-computer',
      'chrome',
    );
    fs.mkdirSync(path.dirname(browserExecutable), { recursive: true });
    fs.writeFileSync(browserExecutable, '#!/bin/sh\n', { mode: 0o700 });
    for (let directory = path.dirname(browserExecutable);; directory = path.dirname(directory)) {
      fs.chmodSync(directory, 0o700);
      if (directory === storageLayout.managedChromiumRootDir(tempDir)) break;
    }
    assert.strictEqual(
      await manager.verifyBrowserExecutable(browserExecutable),
      'Chromium 140.0',
    );
    for (let directory = path.dirname(browserExecutable);; directory = path.dirname(directory)) {
      assert.strictEqual(
        fs.statSync(directory).mode & 0o011,
        0o011,
        `container Browser cache directory must be traversable: ${directory}`,
      );
      if (directory === storageLayout.managedChromiumRootDir(tempDir)) break;
    }
    assert(fake.calls.some(args =>
      args[0] === 'run'
      && args.includes('farming.dev/kind=computer-browser-probe')
      && args.includes('--user')
      && args.includes('cua')
      && args.includes('HOME=/home/cua')
    ));
    const browserLease = await manager.acquireBrowser({
      ownerAgentId: 'agent_owner',
      projectRootId: 'root_project',
      workspace,
      executablePath: browserExecutable,
    });
    assert.strictEqual(browserLease.leaseKey, created.id);
    assert.strictEqual(browserLease.cdpUrl, `http://127.0.0.1:${viewerPort}`);
    assert(
      viewerConnectionHeaders.length >= 2
      && viewerConnectionHeaders.every(value => value === 'close'),
      'Computer readiness probes must release their connection before admitting the next runtime',
    );
    assert.throws(
      () => manager.stop(created.id),
      error => error.code === 'COMPUTER_IN_USE_BY_BROWSER',
    );
    await manager.releaseBrowser(browserLease.leaseKey);

    const firstObservation = await manager.callTool(created.id, 'get_desktop_state', {});
    assert.strictEqual(firstObservation.structuredContent.tool, 'get_desktop_state');
    assert.throws(
      () => manager.callTool(created.id, 'not_a_real_cua_tool', {}),
      error => error.code === 'COMPUTER_TOOL_NOT_SUPPORTED' && error.status === 400,
    );
    assert(!fake.toolCalls.includes('not_a_real_cua_tool'));

    fake.blockTool = 'type_text';
    fake.releaseTool = null;
    const admittedBeforeControl = manager.callTool(created.id, 'type_text', { text: 'accepted-before-control' });
    while (!fake.releaseTool) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const takingControl = manager.takeControl(created.id, 'human');
    assert.throws(
      () => manager.callTool(created.id, 'get_desktop_state', {}),
      error => error.code === 'COMPUTER_CONTROL_CHANGING',
    );
    fake.releaseTool();
    await admittedBeforeControl;
    await takingControl;
    assert.strictEqual(manager.viewerConfig(created.id).viewOnly, false);
    assert.throws(
      () => manager.callTool(created.id, 'click', { x: 1, y: 1 }),
      error => error.code === 'COMPUTER_CONTROL_OWNER_MISMATCH',
    );
    await manager.takeControl(created.id, 'agent');
    await manager.callTool(created.id, 'health_report', {});
    assert.strictEqual(
      manager.get(created.id).needsObserve,
      true,
      'metadata-only reads must not clear the post-takeover observation fence',
    );
    assert.throws(
      () => manager.callTool(created.id, 'click', { x: 1, y: 1 }),
      error => error.code === 'COMPUTER_OBSERVE_REQUIRED',
    );
    await manager.callTool(created.id, 'get_desktop_state', {});
    await manager.callTool(created.id, 'click', { x: 1, y: 1 });

    fake.blockTool = 'type_text';
    fake.releaseTool = null;
    const admitted = manager.callTool(created.id, 'type_text', { text: 'accepted' });
    while (!fake.releaseTool) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const stopping = manager.stop(created.id);
    assert.throws(
      () => manager.callTool(created.id, 'type_text', { text: 'late' }),
      error => error.code === 'COMPUTER_STOPPING',
    );
    fake.releaseTool();
    await admitted;
    await stopping;
    assert.strictEqual(manager.get(created.id).status, 'stopped');

    await manager.start(created.id);
    fake.blockRemove = true;
    const resetting = manager.resetAllContainers();
    while (!fake.releaseRemove) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.throws(
      () => manager.start(created.id),
      error => error.code === 'COMPUTER_STOPPING',
    );
    fake.releaseRemove();
    await resetting;
    fake.blockRemove = false;
    const reset = manager.get(created.id);
    assert.strictEqual(reset.status, 'stopped');
    assert.strictEqual(reset.containerId, '');
    assert.strictEqual(fake.removed, true);

    const deleteCandidate = manager.create({
      ownerAgentId: 'agent_delete',
      projectRootId: 'root_project',
      workspace,
      name: 'Delete Candidate',
    });
    await manager.start(deleteCandidate.id);
    fake.blockRemove = true;
    fake.releaseRemove = null;
    const deleting = manager.delete(deleteCandidate.id);
    while (!fake.releaseRemove) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.throws(
      () => manager.start(deleteCandidate.id),
      error => error.code === 'COMPUTER_STOPPING',
    );
    fake.releaseRemove();
    await deleting;
    fake.blockRemove = false;
    assert.throws(
      () => manager.get(deleteCandidate.id),
      error => error.code === 'COMPUTER_NOT_FOUND',
    );

    const app = express();
    let ownerStatus = 'running';
    let ownerLifecycleOperation: { type: string } | undefined;
    app.use('/api/computers', createComputerRouter(
      manager,
      {
        resolve(rootId) {
          return rootId === 'root_project'
            ? { rootId, canonicalPath: workspace }
            : null;
        },
      },
      {
        getState() {
          return {
            agents: [{
              id: 'agent_owner',
              projectWorkspace: workspace,
              status: ownerStatus,
              lifecycleOperation: ownerLifecycleOperation,
            }, {
              id: 'agent_other',
              projectWorkspace: workspace,
            }],
          };
        },
      },
    ));
    const api = http.createServer(app);
    const apiPort = await listen(api);
    try {
      const forbidden = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        { 'X-Farming-Agent-Id': 'agent_other' },
      );
      assert.strictEqual(forbidden.status, 403);
      assert.strictEqual(forbidden.body.code, 'COMPUTER_OWNER_MISMATCH');
      ownerStatus = 'stopped';
      const inactive = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        { 'X-Farming-Agent-Id': 'agent_owner' },
      );
      assert.strictEqual(inactive.status, 409);
      assert.strictEqual(inactive.body.code, 'COMPUTER_OWNER_INACTIVE');
      ownerLifecycleOperation = { type: 'runtime-switch' };
      const retainedDuringSwitch = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        { 'X-Farming-Agent-Id': 'agent_owner' },
      );
      assert.strictEqual(retainedDuringSwitch.status, 200);
      assert.strictEqual(retainedDuringSwitch.body.status, 'running');
      const filtered = await requestJson(
        apiPort,
        'GET',
        '/api/computers',
        undefined,
        { 'X-Farming-Agent-Id': 'agent_other' },
      );
      assert.deepStrictEqual(filtered.body.resources, []);
    } finally {
      await close(api);
    }

    const privateFile = JSON.parse(fs.readFileSync(
      path.join(tempDir, 'computers', 'resources.json'),
      'utf8',
    ));
    assert.strictEqual(typeof privateFile.resources[0].vncPassword, 'string');
    console.log('Computer extension lifecycle/ownership regression test passed.');
  } finally {
    await close(viewer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
