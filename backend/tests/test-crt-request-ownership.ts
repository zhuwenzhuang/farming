const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/skins/crt/app.js'),
  'utf8',
);

function createDeferred<T = unknown>() {
  let resolve: (_value: T) => void = () => {};
  let reject: (_reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

interface CrtSandbox {
  CSS: { escape: StringConstructor };
  URLSearchParams: typeof URLSearchParams;
  clearInterval: typeof clearInterval;
  clearTimeout: typeof clearTimeout;
  console: typeof console;
  fetch(_url: string, _options?: object): Promise<unknown>;
  module: { exports: Record<string, unknown> };
  exports?: Record<string, unknown>;
  requestAnimationFrame(_callback: () => void): number;
  setInterval: typeof setInterval;
  setTimeout: typeof setTimeout;
  document?: object;
  navigator?: object;
  window?: object;
  pastes?: Array<{ agentId: string; text: string }>;
}

function createHarness(
  { clipboardRead }: { clipboardRead?: () => Promise<string> } = {},
) {
  const requests = [];
  const renders = [];
  const terminalOutput = {
    clientHeight: 100,
    scrollHeight: 100,
    scrollTop: 0,
    querySelector() {
      return null;
    },
  };
  const sandbox: CrtSandbox = {
    CSS: { escape: String },
    URLSearchParams: global.URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch(url, options = {}) {
      const deferred = createDeferred();
      requests.push({ url, options, deferred });
      return deferred.promise;
    },
    module: { exports: {} },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setInterval,
    setTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = {
    AbortController: globalThis.AbortController,
    FarmingRuntimePaths: {
      apiPath: (p) => `/api${p.startsWith('/') ? p : `/${p}`}`,
      path: (p) => p,
      webSocketUrl: (p) => `ws://localhost${p}`,
    },
    FarmingCrtMarkdownRenderer: {
      render(_container, turns) {
        renders.push(turns);
      },
    },
    requestAnimationFrame: sandbox.requestAnimationFrame,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox, { filename: 'frontend/skins/crt/app.js' });
  sandbox.document = {
    title: '',
    getElementById(id) {
      return id === 'terminal-output' ? terminalOutput : null;
    },
  };
  sandbox.navigator = {
    clipboard: clipboardRead ? { readText: clipboardRead } : undefined,
  };
  return {
    evaluate(source) {
      return vm.runInContext(source, sandbox);
    },
    renders,
    requests,
    sandbox,
  };
}

function setTwoAcpAgents(harness, focusedId, generation) {
  harness.evaluate(`
    state = {
      agents: [
        { id: 'agent-a', status: 'running', runtimeBinding: { kind: 'acp', state: 'idle' } },
        { id: 'agent-b', status: 'running', runtimeBinding: { kind: 'acp', state: 'idle' } }
      ]
    };
    focusedAgentId = '${focusedId}';
    structuredSessionGeneration = ${generation};
    structuredSessionLoading = false;
    structuredSessionControlsLoading = false;
  `);
}

async function testLateTranscriptCannotPaintNewAgent() {
  const harness = createHarness();
  setTwoAcpAgents(harness, 'agent-a', 1);
  const first = harness.evaluate("refreshStructuredSession('agent-a', true, 1)");
  assert.match(harness.requests[0].url, /\/agents\/agent-a\/acp-transcript/);

  setTwoAcpAgents(harness, 'agent-b', 2);
  const second = harness.evaluate("refreshStructuredSession('agent-b', true, 2)");
  assert.match(harness.requests[1].url, /\/agents\/agent-b\/acp-transcript/);
  harness.requests[1].deferred.resolve(response({
    transcript: {
      updatedAt: 'b',
      entries: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'B result' }] }],
    },
  }));
  await second;
  harness.requests[0].deferred.resolve(response({
    transcript: {
      updatedAt: 'a',
      entries: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'A result' }] }],
    },
  }));
  await first;

  assert.strictEqual(harness.renders.length, 1);
  assert.strictEqual(harness.renders[0][0].finalMessage, 'B result');

  const reopened = createHarness();
  setTwoAcpAgents(reopened, 'agent-a', 10);
  const oldSession = reopened.evaluate("refreshStructuredSession('agent-a', true, 10)");
  setTwoAcpAgents(reopened, 'agent-a', 11);
  const newSession = reopened.evaluate("refreshStructuredSession('agent-a', true, 11)");
  reopened.requests[1].deferred.resolve(response({
    transcript: {
      updatedAt: 'new-a',
      entries: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'New A session' }] }],
    },
  }));
  await newSession;
  reopened.requests[0].deferred.resolve(response({
    transcript: {
      updatedAt: 'old-a',
      entries: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Old A session' }] }],
    },
  }));
  await oldSession;
  assert.strictEqual(reopened.renders.length, 1);
  assert.strictEqual(reopened.renders[0][0].finalMessage, 'New A session');
}

async function testLateControlsCannotReplaceNewAgentOrRetargetPatch() {
  const harness = createHarness();
  setTwoAcpAgents(harness, 'agent-a', 1);
  const first = harness.evaluate("refreshStructuredSessionControls('agent-a', true, 1)");

  setTwoAcpAgents(harness, 'agent-b', 2);
  const second = harness.evaluate("refreshStructuredSessionControls('agent-b', true, 2)");
  harness.requests[1].deferred.resolve(response({ session: { owner: 'agent-b', updatedAt: 'b' } }));
  await second;
  harness.requests[0].deferred.resolve(response({ session: { owner: 'agent-a', updatedAt: 'a' } }));
  await first;
  assert.strictEqual(harness.evaluate('structuredSessionSnapshot.owner'), 'agent-b');

  setTwoAcpAgents(harness, 'agent-a', 3);
  const patch = harness.evaluate("patchStructuredAcpSession('agent-a', 3, { modeId: 'plan' })");
  assert.match(harness.requests[2].url, /\/agents\/agent-a\/acp-session$/);
  setTwoAcpAgents(harness, 'agent-b', 4);
  harness.requests[2].deferred.resolve(response({ success: true }));
  await patch;
  assert.strictEqual(harness.requests.length, 3, 'an obsolete patch must not refresh the newly focused Agent');

  await harness.evaluate("patchStructuredAcpSession('agent-a', 3, { modeId: 'ask' })");
  assert.strictEqual(harness.requests.length, 3, 'a stale control must not send a request to either Agent');

  setTwoAcpAgents(harness, 'agent-a', 5);
  const permission = harness.evaluate(
    "respondToStructuredPermission('agent-a', 5, 'request-1', 'allow', false)",
  );
  assert.match(harness.requests[3].url, /\/agents\/agent-a\/acp-permission$/);
  setTwoAcpAgents(harness, 'agent-b', 6);
  harness.requests[3].deferred.resolve(response({ success: true }));
  await permission;
  await harness.evaluate(
    "respondToStructuredPermission('agent-a', 5, 'request-2', 'allow', false)",
  );
  assert.strictEqual(harness.requests.length, 4, 'a stale permission control must not target the new Agent');
}

async function testClipboardReadCannotPasteIntoNewAgent() {
  const clipboard = createDeferred<string>();
  const harness = createHarness({ clipboardRead: () => clipboard.promise });
  harness.sandbox.pastes = [];
  harness.evaluate(`
    focusedAgentId = 'agent-a';
    terminal = { paste: (text) => pastes.push({ agentId: focusedAgentId, text }) };
  `);
  const paste = harness.evaluate('pasteFromClipboard()');
  harness.evaluate("focusedAgentId = 'agent-b'");
  clipboard.resolve('from A clipboard');
  assert.strictEqual(await paste, false);
  assert.deepStrictEqual(harness.sandbox.pastes, []);
}

async function testSettingsWritesOnlyCarryAndCommitTheirPatch() {
  const harness = createHarness();
  assert.strictEqual(
    harness.evaluate('CRT_SETTINGS_REQUEST_TIMEOUT_MS'),
    15_000,
    'CRT settings requests should have a bounded wait',
  );
  harness.evaluate(`
    globalSettings = {
      workspace: '/stale/workspace',
      workspaceHistory: ['/stale/workspace'],
      crtContentFontSize: 14,
      crtTerminalFontSize: 15,
      crtSkinEffectsEnabled: true
    };
  `);
  const first = harness.evaluate(`
    globalSettings.crtContentFontSize = 15;
    saveGlobalSettings({ crtContentFontSize: 15 });
  `);
  const second = harness.evaluate(`
    globalSettings.crtContentFontSize = 16;
    saveGlobalSettings({ crtContentFontSize: 16 });
  `);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(JSON.parse(harness.requests[0].options.body), { crtContentFontSize: 15 });
  assert.strictEqual(harness.requests.length, 1, 'settings writes should admit only one request at a time');

  harness.requests[0].deferred.resolve(response({
    success: true,
    settings: { crtContentFontSize: 15, workspace: '/other-writer' },
  }));
  await first;
  assert.strictEqual(harness.requests.length, 2, 'the latest settings value should run after the first request settles');
  assert.deepStrictEqual(JSON.parse(harness.requests[1].options.body), { crtContentFontSize: 16 });
  harness.requests[1].deferred.resolve(response({
    success: true,
    settings: { crtContentFontSize: 16, workspace: '/latest-response' },
  }));
  await second;
  assert.deepStrictEqual(JSON.parse(harness.evaluate(`JSON.stringify({
    fontSize: globalSettings.crtContentFontSize,
    workspace: globalSettings.workspace
  })`)), { fontSize: 16, workspace: '/stale/workspace' });
}

async function run() {
  await testLateTranscriptCannotPaintNewAgent();
  await testLateControlsCannotReplaceNewAgentOrRetargetPatch();
  await testClipboardReadCannotPasteIntoNewAgent();
  await testSettingsWritesOnlyCarryAndCommitTheirPatch();
  console.log('CRT request ownership tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
