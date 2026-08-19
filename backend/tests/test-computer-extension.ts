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
  }

  run = async (args, options: { timeoutMs?: number; maxBuffer?: number } = {}) => {
    this.calls.push([...args]);
    this.dockerTimeouts.push(options.timeoutMs);
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

async function run() {
  testComputerResourceRevisionOrdering();
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
