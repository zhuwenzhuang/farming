const assert = require('assert');
const crypto = require('crypto');
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
  IsolatedBrowserProvider,
} = require('../../extensions/computer/backend/isolated-browser-provider.cjs');
const {
  COMPUTER_AGENT_HTTP_TIMEOUT_MS,
  COMPUTER_IMAGE,
  COMPUTER_TOOL_REQUEST_TIMEOUT_MS,
} = require('../../extensions/computer/backend/computer-constants.cjs');
const { configInstanceFingerprint } = require('../config-instance.cjs');
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

function listen(server): Promise<number> {
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
  dockerTimeouts: Array<number | undefined>;
  toolCalls: string[];
  toolInputs: Array<{ tool: string; input: Record<string, unknown> }>;
  toolTimeouts: Array<{ tool: string; timeoutMs: number | undefined }>;
  sessionActive: boolean;
  nextSessionRefreshError: (Error & { killed?: boolean; code?: string }) | null;
  blockTool: string | null;
  releaseTool: (() => void) | null;
  blockRemove: boolean;
  releaseRemove: (() => void) | null;
  missingErrorContainerId: string;
  failOnceCommand: string | null;
  failOnceEffect: 'none' | 'stop-completes' | 'stop-completes-unreadable' | 'start-completes' | 'start-unreadable' | 'start-gone';
  failInspectTimes: number;
  containerName: string;
  noViewerPort: boolean;
  daemonDown: boolean;

  constructor(viewerPort) {
    this.viewerPort = viewerPort;
    this.running = false;
    this.removed = false;
    this.labels = {};
    this.calls = [];
    this.dockerTimeouts = [];
    this.toolCalls = [];
    this.toolInputs = [];
    this.toolTimeouts = [];
    this.sessionActive = false;
    this.nextSessionRefreshError = null;
    this.blockTool = null;
    this.releaseTool = null;
    this.blockRemove = false;
    this.releaseRemove = null;
    this.missingErrorContainerId = CONTAINER_ID;
    this.failOnceCommand = null;
    this.failOnceEffect = 'none';
    this.failInspectTimes = 0;
    this.containerName = '';
    this.noViewerPort = false;
    this.daemonDown = false;
  }

  run = async (args, options: { timeoutMs?: number; maxBuffer?: number } = {}) => {
    this.calls.push([...args]);
    this.dockerTimeouts.push(options.timeoutMs);
    if (this.failOnceCommand === args[0]) {
      this.failOnceCommand = null;
      if (this.failOnceEffect === 'stop-completes') this.running = false;
      if (this.failOnceEffect === 'stop-completes-unreadable') {
        this.failInspectTimes = 2;
      }
      if (this.failOnceEffect === 'start-completes') this.running = true;
      if (this.failOnceEffect === 'start-unreadable') {
        this.failInspectTimes = 1;
      }
      if (this.failOnceEffect === 'start-gone') this.removed = true;
      this.failOnceEffect = 'none';
      const timeoutError: Error & { killed?: boolean; signal?: string } = new Error(
        `docker ${args[0]} timed out`,
      );
      timeoutError.killed = true;
      timeoutError.signal = 'SIGKILL';
      throw timeoutError;
    }
    if (this.daemonDown) {
      const daemonError: Error & { code?: string } = new Error('Cannot connect to the Docker daemon');
      daemonError.code = 'ENOENT';
      throw daemonError;
    }
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
    if (args[0] === 'ps') {
      // Exact-name ownership lookup used by the pure reconciliation of rows
      // whose container identity was never recorded. Production docker
      // truncates `ps -q` IDs unless --no-trunc is requested, so the fake
      // reproduces that shape.
      const filterIndex = args.indexOf('--filter');
      const filter = filterIndex >= 0 ? args[filterIndex + 1] : '';
      const exactName = /^name=\^(.*)\$$/.exec(filter)?.[1] ?? '';
      if (exactName && this.containerName === exactName && !this.removed) {
        const listedId = args.includes('--no-trunc') ? CONTAINER_ID : CONTAINER_ID.slice(0, 12);
        return { stdout: `${listedId}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'create') {
      const nameIndex = args.indexOf('--name');
      this.containerName = nameIndex >= 0 ? args[nameIndex + 1] : '';
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--label') continue;
        const [key, ...rest] = args[index + 1].split('=');
        this.labels[key] = rest.join('=');
      }
      this.removed = false;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (this.failInspectTimes > 0) {
        this.failInspectTimes -= 1;
        const inspectError: Error & { killed?: boolean; signal?: string } = new Error('docker inspect timed out');
        inspectError.killed = true;
        inspectError.signal = 'SIGKILL';
        throw inspectError;
      }
      if (this.removed) {
        const error = new Error(`Command failed: docker inspect ${CONTAINER_ID}\nError: No such object: ${this.missingErrorContainerId}`) as Error & { stderr?: string };
        error.stderr = `Error: No such object: ${this.missingErrorContainerId}`;
        throw error;
      }
      return {
        stdout: JSON.stringify([{
          Id: CONTAINER_ID,
          Config: { Labels: this.labels },
          State: { Running: this.running },
          NetworkSettings: {
            Ports: this.noViewerPort
              ? {
                  '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.viewerPort) }],
                }
              : {
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
        const input = JSON.parse(args[callIndex + 2]);
        this.toolCalls.push(tool);
        this.toolInputs.push({ tool, input });
        this.toolTimeouts.push({ tool, timeoutMs: options.timeoutMs });
        if (tool === 'start_session') {
          if (this.nextSessionRefreshError) {
            const error = this.nextSessionRefreshError;
            this.nextSessionRefreshError = null;
            throw error;
          }
          this.sessionActive = true;
        } else if (tool === 'end_session') {
          this.sessionActive = false;
        } else if (input.session && !this.sessionActive) {
          throw new Error(`session '${input.session}' has ended`);
        }
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
      if (args.includes('stat') && args.includes('%s')) {
        return { stdout: '8\n', stderr: '' };
      }
      if (args.includes('base64')) {
        return { stdout: Buffer.from('png-data').toString('base64'), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected docker call: ${args.join(' ')}`);
  };
}

async function testComputerUncertainTransitionReconciliation() {
  const viewer = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end('viewer');
  });
  const viewerPort = await listen(viewer);
  // A Viewer whose readiness can be toggled deterministically, so the bounded
  // readiness completion can be exercised without real timing.
  let readinessReady = false;
  const readinessViewer = http.createServer((_request, response) => {
    response.statusCode = readinessReady ? 200 : 503;
    response.end('viewer');
  });
  const readinessPort = await listen(readinessViewer);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-computer-uncertain-'));
  const settings = { computerCompatibilityMode: false, computerImage: COMPUTER_IMAGE };
  const createManager = (
    scenario: string,
    options: { port?: number; manager?: { uncertainReconcileBudgetMs?: number } } = {},
  ) => {
    const scenarioDir = path.join(tempDir, scenario);
    fs.mkdirSync(scenarioDir, { recursive: true });
    const workspace = path.join(scenarioDir, 'project');
    fs.mkdirSync(workspace);
    const fake = new FakeDocker(options.port ?? viewerPort);
    const manager = new ComputerResourceManager({
      configDir: scenarioDir,
      isEnabled: () => true,
      getSettings: () => settings,
      dockerRunner: fake.run,
      ...(options.manager || {}),
    });
    manager.store.init();
    return { fake, manager, workspace };
  };
  const dockerCalls = (fake, command: string) => fake.calls.filter(args => args[0] === command).length;
  const assertUncertainRow = (manager, id: string, expectation: string) => {
    const row = manager.get(id);
    assert.strictEqual(row.status, 'failed', expectation);
    assert.strictEqual(row.needsObserve, true, `${expectation}: needsObserve must mark the uncertain row`);
    assert.match(row.error, /^Uncertain /, `${expectation}: the row error must state the uncertain outcome`);
    assert.strictEqual(row.containerId, CONTAINER_ID, `${expectation}: the exact container identity must be retained`);
    return row;
  };
  const assertUncertainReject = async (request, code: string, expectation: string) => {
    await assert.rejects(
      request,
      error => error.code === code && error.uncertain === true,
      expectation,
    );
  };
  try {
    // REQUIRED delayed-original-completes case for stop: repeated pure
    // reconciliations keep observing the old (running) state, docker stop must
    // never be re-issued, and only after the original daemon stop completes on
    // its own does the next pure reconciliation converge to stopped.
    {
      const { fake, manager, workspace } = createManager('stop-delayed-completes');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.failOnceCommand = 'stop';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'a stop whose container is still running after the timeout must stay uncertain');
      assertUncertainRow(manager, created.id, 'stop-delayed-completes');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'the timed-out docker stop must not be replayed');
      // A retry that still observes the old state must remain a pure read.
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'a retry observing the old state must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'an old-state retry must not re-issue docker stop');
      // The original daemon stop completes later on its own.
      fake.running = false;
      const stopped = await manager.stop(created.id);
      assert.strictEqual(stopped.status, 'stopped');
      assert.strictEqual(stopped.needsObserve, false);
      assert.strictEqual(manager.get(created.id).error, '');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1,
        'the converging reconciliation must not re-issue docker stop');
    }

    // REQUIRED delayed-original-completes case for start: repeated pure
    // reconciliations keep observing the old (not running) state, docker start
    // must never be re-issued, and only after the original daemon start
    // completes on its own does the next pure reconciliation converge.
    {
      const { fake, manager, workspace } = createManager('start-delayed-completes');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a start whose container is not running after the timeout must stay uncertain');
      assertUncertainRow(manager, created.id, 'start-delayed-completes');
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'the timed-out docker start must not be replayed');
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a retry observing the old state must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'an old-state retry must not re-issue docker start');
      // The original daemon start completes later on its own.
      fake.running = true;
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(running.needsObserve, false);
      assert.strictEqual(dockerCalls(fake, 'start'), 1,
        'the converging reconciliation must not re-issue docker start');
    }

    // Observing the target terminal state during reconciliation completes the
    // stop: the daemon stopped the container before the read.
    {
      const { fake, manager, workspace } = createManager('stop-target-observed');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.failOnceCommand = 'stop';
      fake.failOnceEffect = 'stop-completes';
      const stopped = await manager.stop(created.id);
      assert.strictEqual(stopped.status, 'stopped');
      assert.strictEqual(stopped.error, '');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'a reconciled uncertain stop must not replay docker stop');
    }

    // Observing the target terminal state during reconciliation completes the
    // start: the daemon started the container before the read, and the bounded
    // readiness completion finishes the transition.
    {
      const { fake, manager, workspace } = createManager('start-target-observed');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'start-completes';
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(running.needsObserve, false);
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'a reconciled uncertain start must not replay docker start');
    }

    // A stop that was issued after observing running but timed out, and whose
    // reconciliation reads are also unreadable, stays uncertain. Later retries
    // that still observe the old state remain pure reads; only after the
    // original daemon stop completes does a reconciliation converge.
    {
      const { fake, manager, workspace } = createManager('stop-unreadable');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.failOnceCommand = 'stop';
      fake.failOnceEffect = 'stop-completes-unreadable';
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'an unreadable reconciliation must stay uncertain');
      assertUncertainRow(manager, created.id, 'stop-unreadable');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'the timed-out docker stop must not be replayed');
      // The reads recover, but the container still shows the old state.
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'a readable retry observing the old state must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'an old-state retry must not re-issue docker stop');
      fake.running = false;
      const stopped = await manager.stop(created.id);
      assert.strictEqual(stopped.status, 'stopped');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1,
        'the converging reconciliation must not re-issue docker stop');
    }

    // A start whose reconciliation reads are unreadable stays uncertain; a
    // readable retry observing the old state remains a pure read; only after
    // the original daemon start completes does a reconciliation converge.
    {
      const { fake, manager, workspace } = createManager('start-unreadable');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'start-unreadable';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'an unreadable reconciliation must stay uncertain');
      assertUncertainRow(manager, created.id, 'start-unreadable');
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'the timed-out docker start must not be replayed');
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a readable retry observing the old state must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'an old-state retry must not re-issue docker start');
      fake.running = true;
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(dockerCalls(fake, 'start'), 1,
        'the converging reconciliation must not re-issue docker start');
    }

    // A recorded container that is authoritatively gone is the one proven
    // deterministic start failure (needsObserve stays false). A later start on
    // the deterministic row recreates only after the exact absence was proven.
    {
      const { fake, manager, workspace } = createManager('start-recorded-gone');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'start-gone';
      await assert.rejects(
        manager.start(created.id),
        error => error.code === 'COMPUTER_START_FAILED' && error.retryable === true && error.uncertain !== true,
        'a recorded container proven gone is a deterministic start failure',
      );
      const failed = manager.get(created.id);
      assert.strictEqual(failed.status, 'failed');
      assert.strictEqual(failed.needsObserve, false);
      assert.match(failed.error, /no longer present/);
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(dockerCalls(fake, 'create'), 2, 'the deterministic row recreates after proven absence');
    }

    // An uncertain create outcome records no container identity. Pure
    // reconciliations must never re-create; start, stop, and delete all stay
    // bounded and mutation-free until an exact owned container becomes
    // observable. Once the delayed create completes, delete proves the stop
    // target through the exact-name observation and removes only the verified
    // container without any create/start/stop replay.
    {
      const { fake, manager, workspace } = createManager('create-timeout-no-identity');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'create';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a create timeout with no recorded identity must stay uncertain');
      const row = manager.get(created.id);
      assert.strictEqual(row.status, 'failed');
      assert.strictEqual(row.needsObserve, true);
      assert.strictEqual(row.containerId, '', 'no container identity may be invented after an uncertain create');
      assert.strictEqual(dockerCalls(fake, 'create'), 1, 'the timed-out docker create must not be replayed');
      // No owned container is observable yet: every request stays uncertain.
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a retry without an observable owned container must stay uncertain');
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'a stop without an observable owned container must stay uncertain');
      await assertUncertainReject(manager.delete(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'a delete without an observable owned container must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'create'), 1, 'uncertain retries must never re-create');
      assert.strictEqual(dockerCalls(fake, 'start'), 0, 'uncertain retries must never issue docker start');
      assert.strictEqual(dockerCalls(fake, 'stop'), 0, 'uncertain retries must never issue docker stop');
      assert.strictEqual(dockerCalls(fake, 'rm'), 0, 'an unresolved delete must not remove anything');
      assert.strictEqual(manager.get(created.id).needsObserve, true, 'an unresolved delete must retain the row');
      // The original daemon create completes later on its own.
      const createCall = fake.calls.find(args => args[0] === 'create');
      assert(createCall);
      fake.containerName = createCall[createCall.indexOf('--name') + 1];
      for (let index = 0; index < createCall.length; index += 1) {
        if (createCall[index] !== '--label') continue;
        const [key, ...rest] = createCall[index + 1].split('=');
        fake.labels[key] = rest.join('=');
      }
      // Production docker truncates `ps -q` IDs; the recovery must depend on
      // --no-trunc, otherwise the exact inspect identity check would fail.
      const filterValue = `name=^${fake.containerName}$`;
      const truncated = await fake.run(['ps', '-a', '-q', '--filter', filterValue]);
      assert.strictEqual(truncated.stdout.trim(), CONTAINER_ID.slice(0, 12),
        'the fake docker must reproduce production ID truncation');
      const untruncated = await fake.run(['ps', '-a', '-q', '--no-trunc', '--filter', filterValue]);
      assert.strictEqual(untruncated.stdout.trim(), CONTAINER_ID,
        'the fake docker must return full IDs with --no-trunc');
      // A direct delete observes the exact owned container (created, not
      // running), proves the stop target, and removes only that container.
      const deletion = await manager.delete(created.id);
      assert.strictEqual(deletion.id, created.id);
      assert.strictEqual(manager.store.get(created.id), null);
      const rmCall = fake.calls.find(args => args[0] === 'rm');
      assert(rmCall, 'the proven stop target must remove the exact container');
      assert.strictEqual(rmCall[1], CONTAINER_ID, 'delete must remove only the verified exact container');
      assert.strictEqual(dockerCalls(fake, 'create'), 1, 'delete must never re-create');
      assert.strictEqual(dockerCalls(fake, 'start'), 0, 'delete must never issue docker start');
      assert.strictEqual(dockerCalls(fake, 'stop'), 0, 'delete must never issue docker stop');
      assert.strictEqual(dockerCalls(fake, 'rm'), 1);
    }

    // A pure start reconciliation of an uncertain create outcome records the
    // observed exact owned identity, fails closed while the container is not
    // running, and converges once the target state is observed — without ever
    // issuing docker start.
    {
      const { fake, manager, workspace } = createManager('create-timeout-observe-then-converge');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'create';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a create timeout with no recorded identity must stay uncertain');
      const createCall = fake.calls.find(args => args[0] === 'create');
      assert(createCall);
      fake.containerName = createCall[createCall.indexOf('--name') + 1];
      for (let index = 0; index < createCall.length; index += 1) {
        if (createCall[index] !== '--label') continue;
        const [key, ...rest] = createCall[index + 1].split('=');
        fake.labels[key] = rest.join('=');
      }
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'an observed created-but-not-running container must stay uncertain');
      assert.strictEqual(manager.get(created.id).containerId, CONTAINER_ID,
        'the exact owned container identity must be recorded by observation');
      assert.strictEqual(dockerCalls(fake, 'start'), 0, 'observing the old state must not issue docker start');
      fake.running = true;
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(running.needsObserve, false);
      assert.strictEqual(dockerCalls(fake, 'start'), 0,
        'the converging reconciliation must never issue docker start');
    }

    // The container is authoritatively running but desktop readiness cannot be
    // verified within the bounded budget: retries stay uncertain and pure until
    // the Viewer becomes ready; docker start is never re-issued.
    {
      const { fake, manager, workspace } = createManager('readiness-unverified', {
        port: readinessPort,
        manager: { uncertainReconcileBudgetMs: 500 },
      });
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'start-completes';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'an unverified readiness must stay uncertain');
      const row = assertUncertainRow(manager, created.id, 'readiness-unverified');
      assert.match(row.error, /readiness was not verified/);
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'the timed-out docker start must not be replayed');
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'a retry with an unready Viewer must stay uncertain');
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'an unready retry must not re-issue docker start');
      readinessReady = true;
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(dockerCalls(fake, 'start'), 1,
        'the converging reconciliation must not re-issue docker start');
    }

    // A deterministic fact observed after an uncertain outcome must clear
    // needsObserve so the row is not trapped behind the pure-reconciliation
    // gate: the recorded container is authoritatively gone, then a normal
    // start recreates after the proven absence.
    {
      const { fake, manager, workspace } = createManager('deterministic-gone-after-uncertain');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'the start must stay uncertain while the container is not running');
      assertUncertainRow(manager, created.id, 'deterministic-gone-after-uncertain');
      assert.strictEqual(dockerCalls(fake, 'start'), 1);
      fake.removed = true;
      await assert.rejects(
        manager.start(created.id),
        error => error.code === 'COMPUTER_START_FAILED' && error.uncertain !== true,
        'the proven absence of the recorded identity is deterministic',
      );
      assert.strictEqual(manager.get(created.id).needsObserve, false,
        'a deterministic outcome must clear needsObserve');
      const running = await manager.start(created.id);
      assert.strictEqual(running.status, 'running');
      assert.strictEqual(dockerCalls(fake, 'create'), 2,
        'the released row recreates only after the exact absence was proven');
    }

    // A static configuration fact observed after an uncertain outcome must
    // also clear needsObserve: the running container publishes no loopback
    // Viewer port. The released row then fails through the normal start path,
    // proving it is no longer trapped behind the pure-reconciliation gate.
    {
      const { fake, manager, workspace } = createManager('static-port-missing-after-uncertain', {
        port: readinessPort,
        manager: { uncertainReconcileBudgetMs: 500 },
      });
      readinessReady = false;
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      fake.failOnceCommand = 'start';
      fake.failOnceEffect = 'start-completes';
      await assertUncertainReject(manager.start(created.id), 'COMPUTER_START_UNCERTAIN',
        'an unverified readiness must stay uncertain');
      assert.strictEqual(manager.get(created.id).needsObserve, true);
      fake.noViewerPort = true;
      await assert.rejects(
        manager.start(created.id),
        error => error.code === 'COMPUTER_START_FAILED' && error.uncertain !== true,
        'a static missing Viewer port is deterministic',
      );
      assert.strictEqual(manager.get(created.id).needsObserve, false,
        'a deterministic outcome must clear needsObserve');
      await assert.rejects(
        manager.start(created.id),
        error => error.code === undefined,
        'the released row must run the normal start path, not the pure gate',
      );
      assert.strictEqual(dockerCalls(fake, 'start'), 1, 'no docker start replay in any branch');
    }

        // Delete must not smuggle a replayed stop through the internal flag: on an
    // unresolved uncertain stop it returns a bounded uncertain failure and
    // retains the exact identity; it only proceeds once the target stop state
    // is actually proven.
    {
      const { fake, manager, workspace } = createManager('delete-no-replay');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.failOnceCommand = 'stop';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'the stop must stay uncertain while the container is still running');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1);
      await assertUncertainReject(manager.delete(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'delete must not replay docker stop while the outcome is uncertain');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1, 'delete must not cause a second docker stop');
      assert.strictEqual(dockerCalls(fake, 'rm'), 0, 'an unresolved delete must not remove the container');
      assertUncertainRow(manager, created.id, 'delete-no-replay');
      fake.running = false;
      const deletion = await manager.delete(created.id);
      assert.strictEqual(deletion.id, created.id);
      assert.strictEqual(dockerCalls(fake, 'stop'), 1,
        'delete after proven stop must not re-issue docker stop');
      assert.strictEqual(dockerCalls(fake, 'rm'), 1);
      assert.strictEqual(manager.store.get(created.id), null);
    }
    // A stop that converges through container disappearance must not leave the
    // stale identity behind: direct delete removes the Resource row with no
    // second docker stop and nothing to rm.
    {
      const { fake, manager, workspace } = createManager('delete-after-gone-stop');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.failOnceCommand = 'stop';
      fake.failOnceEffect = 'none';
      await assertUncertainReject(manager.stop(created.id), 'COMPUTER_STOP_UNCERTAIN',
        'the stop must stay uncertain while the container is still running');
      assert.strictEqual(dockerCalls(fake, 'stop'), 1);
      fake.removed = true;
      const deletion = await manager.delete(created.id);
      assert.strictEqual(deletion.id, created.id);
      assert.strictEqual(manager.store.get(created.id), null);
      assert.strictEqual(dockerCalls(fake, 'stop'), 1,
        'delete after proven disappearance must not issue a second docker stop');
      assert.strictEqual(dockerCalls(fake, 'rm'), 0,
        'a proven-gone container leaves nothing to remove');
    }

    // The normal stop path has the same proven-gone shape: a container removed
    // externally converges to stopped with the stale identity cleared, and
    // delete removes the row without docker stop or rm.
    {
      const { fake, manager, workspace } = createManager('delete-after-normal-gone-stop');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.removed = true;
      const stopped = await manager.stop(created.id);
      assert.strictEqual(stopped.status, 'stopped');
      assert.strictEqual(manager.get(created.id).containerId, '',
        'a proven-gone stop must clear the stale container identity');
      assert.strictEqual(dockerCalls(fake, 'stop'), 0, 'a proven-gone stop must not issue docker stop');
      const deletion = await manager.delete(created.id);
      assert.strictEqual(deletion.id, created.id);
      assert.strictEqual(manager.store.get(created.id), null);
      assert.strictEqual(dockerCalls(fake, 'rm'), 0);
    }

    // resetContainer shares the verify-then-remove boundary and must tolerate
    // the exact missing identity instead of bricking the reset.
    {
      const { fake, manager, workspace } = createManager('reset-after-gone-stop');
      const created = manager.create({ ownerAgentId: 'agent_owner', projectRootId: 'root_project', workspace });
      await manager.start(created.id);
      fake.removed = true;
      await manager.resetContainer(created.id);
      const row = manager.get(created.id);
      assert.strictEqual(row.status, 'stopped');
      assert.strictEqual(row.containerId, '');
      assert.strictEqual(dockerCalls(fake, 'rm'), 0);
    }
    } finally {
    await close(readinessViewer);
    await close(viewer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testComputerCapabilityFreshAndCachedReads() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-computer-capability-'));
  const settings = { computerCompatibilityMode: false, computerImage: COMPUTER_IMAGE };
  let clock = 0;
  const fake = new FakeDocker(59999);
  const manager = new ComputerResourceManager({
    configDir: tempDir,
    isEnabled: () => true,
    getSettings: () => settings,
    dockerRunner: fake.run,
    capabilityNavCacheMs: 1000,
    capabilityCacheNow: () => clock,
  });
  manager.store.init();
  const probeCount = () => fake.calls.filter(args => args[0] === 'version').length;
  try {
    // Ordinary reads are current-state reads: each runs a fresh bounded probe.
    const alive = await manager.capability();
    assert.strictEqual(alive.available, true);
    assert.strictEqual(probeCount(), 1);
    // False-positive fix: the daemon dies, and the ordinary read reflects the
    // authoritative failure immediately with an explicit in-band error.
    fake.daemonDown = true;
    const dead = await manager.capability();
    assert.strictEqual(dead.dockerAvailable, false);
    assert.strictEqual(dead.available, false);
    assert(dead.error, 'an unavailable probe must report an explicit error');
    assert.strictEqual(probeCount(), 2, 'an ordinary capability read must re-probe');
    // False-negative fix: the daemon recovers, and the ordinary read reflects
    // availability immediately.
    fake.daemonDown = false;
    const recovered = await manager.capability();
    assert.strictEqual(recovered.available, true);
    assert.strictEqual(probeCount(), 3);
    // Concurrent fresh reads coalesce into one bounded probe.
    const [concurrentA, concurrentB] = await Promise.all([
      manager.capability(),
      manager.capability(),
    ]);
    assert.strictEqual(concurrentA.available, true);
    assert.strictEqual(concurrentB.available, true);
    assert.strictEqual(probeCount(), 4, 'concurrent fresh reads must coalesce into one probe');
    // The bounded-age background opt-in serves cached evidence inside the
    // window and re-probes once it lapses.
    const cached = await manager.cachedCapability();
    assert.strictEqual(cached.available, true);
    assert.strictEqual(probeCount(), 4, 'bounded-age reuse must not probe');
    clock += 1001;
    const aged = await manager.cachedCapability();
    assert.strictEqual(aged.available, true);
    assert.strictEqual(probeCount(), 5, 'expired bounded-age reuse must probe again');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testComputerCapabilityEndpointCurrentStateReads() {
  const viewer = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end('viewer');
  });
  const viewerPort = await listen(viewer);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-computer-capability-api-'));
  const settings = { computerCompatibilityMode: false, computerImage: COMPUTER_IMAGE };
  const fake = new FakeDocker(viewerPort);
  const manager = new ComputerResourceManager({
    configDir: tempDir,
    isEnabled: () => true,
    getSettings: () => settings,
    dockerRunner: fake.run,
  });
  manager.store.init();
  const app = express();
  app.use('/api/computers', createComputerRouter(manager, { resolve: () => null }, undefined));
  const api = http.createServer(app);
  const apiPort = await listen(api);
  try {
    // The canonical endpoint (ordinary GET, no freshness query) reflects the
    // authoritative Docker state immediately in both directions.
    let response = await requestJson(apiPort, 'GET', '/api/computers/capability', undefined);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.available, true);
    fake.daemonDown = true;
    response = await requestJson(apiPort, 'GET', '/api/computers/capability', undefined);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.dockerAvailable, false);
    assert.strictEqual(response.body.available, false);
    assert(response.body.error, 'the endpoint must report the explicit probe failure');
    fake.daemonDown = false;
    response = await requestJson(apiPort, 'GET', '/api/computers/capability', undefined);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.available, true);
  } finally {
    await close(api);
    await close(viewer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testIsolatedBrowserCapabilityFollowsComputerState() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-isolated-capability-'));
  const settings = { computerCompatibilityMode: false, computerImage: COMPUTER_IMAGE };
  const fake = new FakeDocker(59998);
  const manager = new ComputerResourceManager({
    configDir: tempDir,
    isEnabled: () => true,
    getSettings: () => settings,
    dockerRunner: fake.run,
  });
  manager.store.init();
  const provider = new IsolatedBrowserProvider({
    configDir: tempDir,
    computerResourceManager: manager,
    chromiumInstaller: {
      browserOption: () => null,
      install: async () => null,
      status: () => ({ state: 'ready' }),
    },
    dockerRunner: fake.run,
  });
  try {
    // The isolated Browser source presents Computer availability as current
    // evidence: ordinary reads follow Docker state changes immediately.
    let capability = await provider.capability();
    assert.strictEqual(capability.dockerAvailable, true);
    assert.strictEqual(capability.available, true);
    fake.daemonDown = true;
    capability = await provider.capability();
    assert.strictEqual(capability.dockerAvailable, false);
    assert.strictEqual(capability.available, false);
    assert(capability.error, 'the isolated source must surface the explicit failure');
    fake.daemonDown = false;
    capability = await provider.capability();
    assert.strictEqual(capability.dockerAvailable, true);
    assert.strictEqual(capability.available, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  testComputerResourceRevisionOrdering();
  await testComputerUncertainTransitionReconciliation();
  await testComputerCapabilityFreshAndCachedReads();
  await testComputerCapabilityEndpointCurrentStateReads();
  await testIsolatedBrowserCapabilityFollowsComputerState();
  assert(
    COMPUTER_TOOL_REQUEST_TIMEOUT_MS + 1_000 < COMPUTER_AGENT_HTTP_TIMEOUT_MS,
    'the server deadline and cleanup grace must finish before the Agent HTTP transport timeout',
  );
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
  const cleanupDeadline = Date.now() - 500;
  const cleanupTimeout = (manager as unknown as {
    screenshotCleanupTimeout(deadline: number): number;
  }).screenshotCleanupTimeout(cleanupDeadline);
  assert(
    cleanupTimeout >= 400 && cleanupTimeout <= 500,
    'screenshot cleanup must retain the unused part of its one-second post-deadline grace',
  );

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
    assert.strictEqual(
      fake.labels['farming.dev/config'],
      configInstanceFingerprint(tempDir),
      'Computer ownership labels must use the canonical Config identity',
    );
    assert.strictEqual(fake.labels['farming.dev/resource'], created.id);
    assert.strictEqual(fake.labels['farming.dev/owner-agent'], 'agent_owner');
    fake.labels['farming.dev/owner-agent'] = 'agent_wrong_owner';
    await assert.rejects(
      manager.inspectOwnedContainer(manager.privateResource(created.id)),
      error => error.code === 'COMPUTER_CONTAINER_OWNER_MISMATCH',
      'an existing container with mismatched ownership labels must remain fail-closed',
    );
    fake.labels['farming.dev/owner-agent'] = 'agent_owner';
    const currentConfigLabel = fake.labels['farming.dev/config'];
    fake.labels['farming.dev/config'] = crypto.createHash('sha256')
      .update(tempDir)
      .digest('hex')
      .slice(0, 12);
    await manager.inspectOwnedContainer(manager.privateResource(created.id));
    fake.labels['farming.dev/config'] = currentConfigLabel;
    assert.strictEqual(manager.viewerConfig(created.id).viewOnly, true);
    const createCall = fake.calls.find(args => args[0] === 'create');
    assert(createCall);
    assert(
      createCall[createCall.indexOf('--name') + 1]
        .startsWith(`farming-computer-${configInstanceFingerprint(tempDir)}-`),
      'Computer container names must include the canonical Config identity',
    );
    assert(
      createCall.includes('127.0.0.1::9223')
      && createCall.some(value => String(value).endsWith(':/opt/farming/chromium:ro'))
    );

    const browserExecutable = path.join(
      storageLayout.managedChromiumRootDir(manager.configDir),
      '..foo',
      'linux-x64-computer',
      'chrome',
    );
    fs.mkdirSync(path.dirname(browserExecutable), { recursive: true });
    fs.writeFileSync(browserExecutable, '#!/bin/sh\n', { mode: 0o700 });
    for (let directory = path.dirname(browserExecutable);; directory = path.dirname(directory)) {
      fs.chmodSync(directory, 0o700);
      if (directory === storageLayout.managedChromiumRootDir(manager.configDir)) break;
    }
    assert.strictEqual(
      await manager.verifyBrowserExecutable(browserExecutable),
      'Chromium 140.0',
    );
    const outsideBrowserExecutable = path.join(path.dirname(storageLayout.managedChromiumRootDir(manager.configDir)), 'outside-chrome');
    fs.writeFileSync(outsideBrowserExecutable, '#!/bin/sh\n', { mode: 0o700 });
    await assert.rejects(
      manager.verifyBrowserExecutable(outsideBrowserExecutable),
      error => error.code === 'COMPUTER_BROWSER_EXECUTABLE_INVALID',
      'a real managed-runtime escape must remain rejected',
    );
    for (let directory = path.dirname(browserExecutable);; directory = path.dirname(directory)) {
      assert.strictEqual(
        fs.statSync(directory).mode & 0o011,
        0o011,
        `container Browser cache directory must be traversable: ${directory}`,
      );
      if (directory === storageLayout.managedChromiumRootDir(manager.configDir)) break;
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

    const callsBeforeFirstObservation = fake.calls.length;
    const firstObservation = await manager.callTool(created.id, 'get_desktop_state', {});
    assert.strictEqual(firstObservation.structuredContent.tool, 'get_desktop_state');
    const observationDockerCalls = fake.calls.slice(callsBeforeFirstObservation);
    const observationTimeouts = fake.dockerTimeouts.slice(callsBeforeFirstObservation);
    assert.deepStrictEqual(
      observationDockerCalls.map(args => {
        const callIndex = args.indexOf('call');
        if (callIndex >= 0) return args[callIndex + 1];
        if (args.includes('stat')) return 'stat';
        if (args.includes('base64')) return 'base64';
        if (args.includes('rm')) return 'rm';
        return 'other';
      }),
      ['start_session', 'get_desktop_state', 'stat', 'base64', 'rm'],
      'an observation request must keep refresh, Driver call, screenshot extraction, and cleanup ordered',
    );
    assert(
      observationTimeouts.every(timeout => Number(timeout) > 0 && Number(timeout) <= 45_000),
      'every blocking observation step must be capped by the shared server request deadline',
    );
    assert(Number(observationTimeouts.at(-1)) <= 1_000, 'screenshot cleanup must use bounded deadline grace');
    const startCallsBefore = fake.toolCalls.filter(tool => tool === 'start_session').length;
    const refreshedSession = await manager.callTool(created.id, 'start_session', {
      session: 'caller-must-not-replace-owned-session',
      capture_scope: 'auto',
    });
    assert.strictEqual(refreshedSession.structuredContent.tool, 'start_session');
    assert.strictEqual(
      fake.toolCalls.filter(tool => tool === 'start_session').length,
      startCallsBefore + 1,
      'an idempotent start_session call must reach the driver so an idle-TTL session can recover',
    );
    assert.strictEqual(
      fake.toolInputs.filter(call => call.tool === 'start_session').at(-1)?.input.session,
      manager.get(created.id).sessionId,
      'session recovery must keep the Resource-owned identity',
    );
    assert.strictEqual(
      fake.toolInputs.filter(call => call.tool === 'start_session').at(-1)?.input.capture_scope,
      'desktop',
      'session recovery must preserve the Resource-owned desktop capture scope',
    );
    assert.strictEqual(
      fake.toolTimeouts.filter(call => call.tool === 'start_session').at(-1)?.timeoutMs,
      5_000,
      'session refresh must remain inside the 60-second Agent transport budget',
    );

    fake.nextSessionRefreshError = Object.assign(
      new Error('injected explicit session refresh timed out'),
      { killed: true, code: 'ETIMEDOUT' },
    );
    await assert.rejects(
      manager.callTool(created.id, 'start_session', {}),
      error => (
        error.code === 'COMPUTER_SESSION_REFRESH_FAILED'
        && error.retryable === true
        && error.uncertain === true
        && error.actionStarted === undefined
        && /start_session did not complete/.test(error.message)
      ),
      'an explicit idempotent refresh must not claim it was never sent',
    );

    fake.sessionActive = false;
    fake.nextSessionRefreshError = Object.assign(
      new Error('injected session refresh timed out'),
      { killed: true, code: 'ETIMEDOUT' },
    );
    const clicksBeforeFailedRefresh = fake.toolCalls.filter(tool => tool === 'click').length;
    await assert.rejects(
      manager.callTool(created.id, 'click', { scope: 'desktop', x: 1, y: 1 }),
      error => (
        error.code === 'COMPUTER_SESSION_REFRESH_FAILED'
        && error.actionStarted === false
        && error.retryable === true
        && error.uncertain === undefined
      ),
    );
    assert.strictEqual(
      fake.toolCalls.filter(tool => tool === 'click').length,
      clicksBeforeFailedRefresh,
      'a session refresh failure must leave the original action unsent',
    );

    fake.nextSessionRefreshError = new Error('injected permanent session permission failure');
    await assert.rejects(
      manager.callTool(created.id, 'click', { scope: 'desktop', x: 1, y: 1 }),
      error => (
        error.code === 'COMPUTER_SESSION_REFRESH_FAILED'
        && error.actionStarted === false
        && error.retryable === false
        && /permission failure/.test(error.message)
      ),
      'a deterministic refresh failure must preserve its cause without inviting blind retries',
    );

    const callsBeforeExpiredSessionRecovery = fake.toolCalls.length;
    const recoveredAction = await manager.callTool(created.id, 'click', { scope: 'desktop', x: 2, y: 2 });
    assert.strictEqual(recoveredAction.structuredContent.tool, 'click');
    assert.deepStrictEqual(
      fake.toolCalls.slice(callsBeforeExpiredSessionRecovery),
      ['start_session', 'click'],
      'an expired session must be refreshed before executing the original action exactly once',
    );
    const recoveryTimeouts = fake.toolTimeouts
      .slice(callsBeforeExpiredSessionRecovery)
      .map(call => Number(call.timeoutMs));
    assert(
      recoveryTimeouts[0] > 0 && recoveryTimeouts[0] <= 5_000
      && recoveryTimeouts[1] > 0 && recoveryTimeouts[1] <= 45_000,
      'refresh and the original action must both consume the shared server request deadline',
    );

    fake.sessionActive = false;
    const callsBeforeSessionIndependentTool = fake.toolCalls.length;
    await manager.callTool(created.id, 'health_report', { session: 'caller-supplied-noise' });
    assert.deepStrictEqual(
      fake.toolCalls.slice(callsBeforeSessionIndependentTool),
      ['health_report'],
      'caller input must not make a session-independent tool depend on session liveness',
    );
    assert.strictEqual(
      fake.toolInputs.at(-1)?.input.session,
      undefined,
      'session-independent tools must not forward a caller-supplied session identity',
    );

    const callsBeforeWindowAccessibility = fake.toolCalls.length;
    await manager.callTool(created.id, 'get_accessibility_tree', {
      session: 'caller-must-not-bind-desktop-policy',
    });
    await manager.callTool(created.id, 'get_window_state', {
      include_screenshot: false,
      pid: 417,
      session: 'caller-must-not-bind-desktop-policy',
      window_id: 31_457_283,
    });
    await manager.callTool(created.id, 'click', {
      element_index: 1,
      pid: 417,
      session: 'caller-must-not-bind-desktop-policy',
      window_id: 31_457_283,
    });
    assert.deepStrictEqual(
      fake.toolCalls.slice(callsBeforeWindowAccessibility),
      ['get_accessibility_tree', 'get_window_state', 'click'],
      'window accessibility must remain cursor-less instead of refreshing the desktop session policy',
    );
    assert(
      fake.toolInputs.slice(-3).every(call => call.input.session === undefined),
      'window discovery and accessibility-targeted actions must not forward a caller session',
    );

    fake.blockTool = 'type_text';
    fake.releaseTool = null;
    const callsBeforeConcurrentActions = fake.toolCalls.length;
    const firstConcurrentAction = manager.callTool(created.id, 'type_text', {
      scope: 'desktop',
      text: 'first',
    });
    while (!fake.releaseTool) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const secondConcurrentAction = manager.callTool(created.id, 'click', {
      scope: 'desktop',
      x: 3,
      y: 3,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(
      fake.toolCalls.slice(callsBeforeConcurrentActions),
      ['start_session', 'type_text'],
      'another action must not enter between a queued session refresh and its original action',
    );
    fake.releaseTool();
    await Promise.all([firstConcurrentAction, secondConcurrentAction]);
    fake.blockTool = null;
    assert.deepStrictEqual(
      fake.toolCalls.slice(callsBeforeConcurrentActions),
      ['start_session', 'type_text', 'start_session', 'click'],
      'each concurrent action must retain one ordered refresh-action pair',
    );

    const realDateNow = Date.now;
    let controlledNow = realDateNow();
    Date.now = () => controlledNow;
    try {
      fake.blockTool = 'type_text';
      fake.releaseTool = null;
      const blocker = manager.callTool(created.id, 'type_text', {
        scope: 'desktop',
        text: 'deadline blocker',
      });
      while (!fake.releaseTool) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const startCallsBeforeExpiredQueue = fake.toolCalls.filter(tool => tool === 'start_session').length;
      const expiredInQueue = manager.callTool(created.id, 'start_session', {});
      controlledNow += COMPUTER_TOOL_REQUEST_TIMEOUT_MS + 1;
      fake.releaseTool();
      await blocker;
      await assert.rejects(
        expiredInQueue,
        error => (
          error.code === 'COMPUTER_SESSION_REFRESH_FAILED'
          && error.actionStarted === false
          && error.retryable === true
          && error.uncertain === undefined
          && /was not sent/.test(error.message)
        ),
        'a start_session whose queue deadline expired must remain a proven zero-send outcome',
      );
      assert.strictEqual(
        fake.toolCalls.filter(tool => tool === 'start_session').length,
        startCallsBeforeExpiredQueue,
        'an expired queued start_session must not reach the Driver',
      );
    } finally {
      Date.now = realDateNow;
      fake.blockTool = null;
      fake.releaseTool = null;
    }
    assert.throws(
      () => manager.callTool(created.id, 'not_a_real_cua_tool', {}),
      error => error.code === 'COMPUTER_TOOL_NOT_SUPPORTED' && error.status === 400,
    );
    assert(!fake.toolCalls.includes('not_a_real_cua_tool'));

    fake.blockTool = 'type_text';
    fake.releaseTool = null;
    const admittedBeforeControl = manager.callTool(created.id, 'type_text', {
      scope: 'desktop',
      text: 'accepted-before-control',
    });
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
      () => manager.callTool(created.id, 'click', { scope: 'desktop', x: 1, y: 1 }),
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
      () => manager.callTool(created.id, 'click', { scope: 'desktop', x: 1, y: 1 }),
      error => error.code === 'COMPUTER_OBSERVE_REQUIRED',
    );
    await manager.callTool(created.id, 'get_desktop_state', {});
    await manager.callTool(created.id, 'click', { scope: 'desktop', x: 1, y: 1 });

    fake.blockTool = 'type_text';
    fake.releaseTool = null;
    const admitted = manager.callTool(created.id, 'type_text', { scope: 'desktop', text: 'accepted' });
    while (!fake.releaseTool) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const stopping = manager.stop(created.id);
    assert.throws(
      () => manager.callTool(created.id, 'type_text', { scope: 'desktop', text: 'late' }),
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

    const externallyRemovedCandidate = manager.create({
      ownerAgentId: 'agent_externally_removed',
      projectRootId: 'root_project',
      workspace,
      name: 'Externally Removed Candidate',
    });
    await manager.start(externallyRemovedCandidate.id);
    await manager.stop(externallyRemovedCandidate.id);
    fake.removed = true;
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
      { id: 'agent_externally_removed', status: 'stopped' },
    ]);
    assert.throws(
      () => manager.get(externallyRemovedCandidate.id),
      error => error.code === 'COMPUTER_NOT_FOUND',
      'a missing owned container must converge to an absent Resource instead of blocking lifecycle reconciliation',
    );

    const restartConfigDir = path.join(tempDir, 'restart-config');
    const restartFake = new FakeDocker(viewerPort);
    const beforeRestart = new ComputerResourceManager({
      configDir: restartConfigDir,
      isEnabled: () => true,
      getSettings: () => settings,
      dockerRunner: restartFake.run,
    });
    beforeRestart.store.init();
    const persistedRunning = beforeRestart.create({
      ownerAgentId: 'agent_restart',
      projectRootId: 'root_project',
      workspace,
      name: 'Restart Recovery Candidate',
    });
    await beforeRestart.start(persistedRunning.id);
    restartFake.removed = true;
    const afterRestart = new ComputerResourceManager({
      configDir: restartConfigDir,
      isEnabled: () => true,
      getSettings: () => settings,
      dockerRunner: restartFake.run,
    });
    await afterRestart.init();
    const recoveredMissing = afterRestart.privateResource(persistedRunning.id);
    assert.strictEqual(recoveredMissing.status, 'stopped');
    assert.strictEqual(recoveredMissing.containerId, '');
    assert.strictEqual(recoveredMissing.containerName, '');
    assert.strictEqual(recoveredMissing.vncPassword, '');
    assert.strictEqual(recoveredMissing.viewerPort, 0);
    assert.strictEqual(recoveredMissing.sessionId, '');
    assert.strictEqual(recoveredMissing.error, '');
    const restartedMissing = await afterRestart.start(persistedRunning.id);
    assert.strictEqual(restartedMissing.status, 'running');
    assert.strictEqual(
      restartFake.calls.filter(args => args[0] === 'create').length,
      2,
      'restart recovery must create and revalidate a fresh owned container',
    );
    await afterRestart.delete(persistedRunning.id);

    const mismatchedMissingConfigDir = path.join(tempDir, 'mismatched-missing-config');
    const mismatchedMissingFake = new FakeDocker(viewerPort);
    const beforeMismatchedMissing = new ComputerResourceManager({
      configDir: mismatchedMissingConfigDir,
      isEnabled: () => true,
      getSettings: () => settings,
      dockerRunner: mismatchedMissingFake.run,
    });
    beforeMismatchedMissing.store.init();
    const mismatchedMissing = beforeMismatchedMissing.create({
      ownerAgentId: 'agent_mismatched_missing',
      projectRootId: 'root_project',
      workspace,
      name: 'Mismatched Missing Candidate',
    });
    await beforeMismatchedMissing.start(mismatchedMissing.id);
    mismatchedMissingFake.removed = true;
    mismatchedMissingFake.missingErrorContainerId = 'f'.repeat(64);
    const afterMismatchedMissing = new ComputerResourceManager({
      configDir: mismatchedMissingConfigDir,
      isEnabled: () => true,
      getSettings: () => settings,
      dockerRunner: mismatchedMissingFake.run,
    });
    await afterMismatchedMissing.init();
    const rejectedMissing = afterMismatchedMissing.privateResource(mismatchedMissing.id);
    assert.strictEqual(rejectedMissing.status, 'failed');
    assert.strictEqual(rejectedMissing.containerId, CONTAINER_ID);
    assert.match(rejectedMissing.error, /No such object/);

    const lifecycleCandidate = manager.create({
      ownerAgentId: 'agent_other',
      projectRootId: 'root_project',
      workspace,
      name: 'Lifecycle Candidate',
    });
    await manager.start(lifecycleCandidate.id);
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
      {
        id: 'agent_other',
        status: 'stopped',
        lifecycleOperation: { type: 'runtime-switch' },
      },
    ]);
    assert.strictEqual(
      manager.get(lifecycleCandidate.id).status,
      'running',
      'a runtime switch must preserve the exact Agent-owned Computer',
    );
    const retainedContainerId = manager.get(lifecycleCandidate.id).containerId;
    manager.beginAgentOwnerReplacement('agent_other');
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
    ]);
    assert.strictEqual(
      manager.get(lifecycleCandidate.id).containerId,
      retainedContainerId,
      'a replacement hold must retain the Computer while the old Agent is absent',
    );
    manager.completeAgentOwnerReplacement('agent_other', 'agent_replacement');
    assert.strictEqual(manager.get(lifecycleCandidate.id).ownerAgentId, 'agent_replacement');
    assert.strictEqual(manager.get(lifecycleCandidate.id).containerId, retainedContainerId);
    await manager.inspectOwnedContainer(manager.privateResource(lifecycleCandidate.id));
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
      { id: 'agent_replacement', status: 'stopped' },
    ]);
    assert.throws(
      () => manager.get(lifecycleCandidate.id),
      error => error.code === 'COMPUTER_NOT_FOUND',
      'an inactive owner must delete its Computer row and container instead of leaving an orphan',
    );

    const recoveredReplacement = manager.create({
      ownerAgentId: 'agent_recovery_old',
      projectRootId: 'root_project',
      workspace,
      name: 'Recovery Candidate',
    });
    await manager.start(recoveredReplacement.id);
    const recoveredContainerId = manager.get(recoveredReplacement.id).containerId;
    await assert.rejects(
      manager.reconcileAgentLifecycle([
        { id: 'agent_owner', status: 'running' },
        {
          id: 'agent_recovery_first',
          projectWorkspace: workspace,
          restartedFromAgentId: 'agent_recovery_old',
          status: 'running',
        },
        {
          id: 'agent_recovery_second',
          projectWorkspace: workspace,
          restartedFromAgentIds: ['agent_recovery_old'],
          status: 'running',
        },
      ]),
      error => error.code === 'COMPUTER_OWNER_REPLACEMENT_AMBIGUOUS',
    );
    assert.strictEqual(manager.get(recoveredReplacement.id).ownerAgentId, 'agent_recovery_old');
    assert.strictEqual(manager.get(recoveredReplacement.id).containerId, recoveredContainerId);
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
      {
        id: 'agent_recovery_new',
        projectWorkspace: workspace,
        restartedFromAgentIds: ['agent_recovery_old'],
        status: 'running',
      },
    ]);
    assert.strictEqual(manager.get(recoveredReplacement.id).ownerAgentId, 'agent_recovery_new');
    assert.strictEqual(manager.get(recoveredReplacement.id).containerId, recoveredContainerId);
    await manager.inspectOwnedContainer(manager.privateResource(recoveredReplacement.id));
    await manager.reconcileAgentLifecycle([
      { id: 'agent_owner', status: 'running' },
      {
        id: 'agent_recovery_new',
        projectWorkspace: workspace,
        status: 'stopped',
      },
    ]);
    assert.throws(
      () => manager.get(recoveredReplacement.id),
      error => error.code === 'COMPUTER_NOT_FOUND',
      'restart recovery must transfer before ordinary replacement cleanup resumes',
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
        resolveAgentResourceBinding(agentId) {
          if (!['agent_owner', 'agent_other'].includes(agentId)) return null;
          return { agentId, workspace };
        },
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
      const expired = await requestJson(
        apiPort,
        'GET',
        '/api/computers',
        undefined,
        {
          'X-Farming-Agent-Id': 'agent_missing',
        },
      );
      assert.strictEqual(expired.status, 404);
      assert.strictEqual(expired.body.code, 'COMPUTER_AGENT_NOT_FOUND');
      const forbidden = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        {
          'X-Farming-Agent-Id': 'agent_other',
        },
      );
      assert.strictEqual(forbidden.status, 403);
      assert.strictEqual(forbidden.body.code, 'COMPUTER_OWNER_MISMATCH');
      ownerStatus = 'stopped';
      const inactive = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        {
          'X-Farming-Agent-Id': 'agent_owner',
        },
      );
      assert.strictEqual(inactive.status, 409);
      assert.strictEqual(inactive.body.code, 'COMPUTER_OWNER_INACTIVE');
      ownerLifecycleOperation = { type: 'runtime-switch' };
      const retainedDuringSwitch = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/start`,
        undefined,
        {
          'X-Farming-Agent-Id': 'agent_owner',
        },
      );
      assert.strictEqual(retainedDuringSwitch.status, 200);
      assert.strictEqual(retainedDuringSwitch.body.status, 'running');
      fake.sessionActive = false;
      fake.nextSessionRefreshError = Object.assign(
        new Error('injected API session refresh timed out'),
        { killed: true, code: 'ETIMEDOUT' },
      );
      const refreshFailure = await requestJson(
        apiPort,
        'POST',
        `/api/computers/${encodeURIComponent(created.id)}/tool/click`,
        { scope: 'desktop', x: 4, y: 4 },
        { 'X-Farming-Agent-Id': 'agent_owner' },
      );
      assert.strictEqual(refreshFailure.status, 503);
      assert.strictEqual(refreshFailure.body.code, 'COMPUTER_SESSION_REFRESH_FAILED');
      assert.strictEqual(refreshFailure.body.retryable, true);
      assert.strictEqual(refreshFailure.body.actionStarted, false);
      assert.strictEqual(refreshFailure.body.uncertain, undefined);
      const filtered = await requestJson(
        apiPort,
        'GET',
        '/api/computers',
        undefined,
        {
          'X-Farming-Agent-Id': 'agent_other',
        },
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
