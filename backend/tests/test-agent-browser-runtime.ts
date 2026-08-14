const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  AGENT_BROWSER_VERSION,
  AgentBrowserRuntime,
  namespaceForResource,
  sessionForResource,
} = require('../../extensions/browser/backend/agent-browser-runtime.cjs');

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
  }
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-browser-runtime.'));
  const profileDir = path.join(configDir, 'browsers', 'browser_test', 'profile');
  const calls = [];
  const commandEnvironments = [];
  const stream = new FakeStream();
  let processActive = true;
  const identity = {
    pid: 44_001,
    processGroupId: 44_001,
    startedAt: 'agent-browser-test',
    format: 'test-v1',
  };
  let largeSnapshotOutput = false;
  let currentUrl = 'https://example.test/';
  let currentTitle = 'Example';
  const runCommand = async (_executable, args, options) => {
    calls.push(args);
    commandEnvironments.push(options.env);
    const command = args.slice(4, -1);
    if (command[0] === 'session' && command[1] === 'info') {
      return {
        success: true,
        data: { active: processActive, pid: identity.pid, version: AGENT_BROWSER_VERSION },
      };
    }
    if (command[0] === 'stream' && command[1] === 'status') {
      return { success: true, data: { enabled: true, port: 47_777 } };
    }
    if (command[0] === 'tab' && command[1] === 'list') {
      return {
        success: true,
        data: {
          tabs: [{
            active: true,
            tabId: 't1',
            title: currentTitle,
            type: 'page',
            url: currentUrl,
          }],
        },
      };
    }
    if (command[0] === 'open' && command[1] && command[1] !== 'https://example.test/') {
      currentUrl = command[1];
      currentTitle = 'Navigated';
      return { success: true, data: { url: currentUrl, title: currentTitle } };
    }
    if (command[0] === 'get' && command[1] === 'url') {
      return { success: true, data: { url: 'https://example.test/' } };
    }
    if (command[0] === 'get' && command[1] === 'title') {
      return { success: true, data: { title: 'Example' } };
    }
    if (command[0] === 'snapshot') {
      return {
        success: true,
        data: {
          refs: { e1: { role: 'button', name: 'Run' } },
          snapshot: largeSnapshotOutput
            ? 'x'.repeat(50_001)
            : '- button "Run" [ref=e1]',
          origin: 'https://example.test/',
        },
      };
    }
    if (
      command[0] === 'eval'
      && Buffer.from(String(command[2] || ''), 'base64').toString('utf8')
        === '({url:location.href,title:document.title})'
    ) {
      return {
        success: true,
        data: { result: { url: 'https://example.test/', title: 'Example' } },
      };
    }
    if (command[0] === 'eval') {
      return { success: true, data: { value: 'x'.repeat(100_100) } };
    }
    if (command[0] === 'close') processActive = false;
    return { success: true, data: {} };
  };
  const runtime = new AgentBrowserRuntime({
    id: 'browser_test',
    generation: 7,
    configDir,
    profileDir,
    agentBrowserPath: '/managed/agent-browser',
    executablePath: '/Applications/Chromium',
    runCommand,
    createWebSocket: url => {
      assert.strictEqual(url, 'ws://127.0.0.1:47777');
      return stream;
    },
    readProcessIdentity: async pid => (pid === identity.pid && processActive ? identity : null),
    wait: async () => {},
  });

  assert.match(namespaceForResource(configDir, 'browser_test', 1), /^farming-[a-f0-9]{16}$/);
  const configAlias = `${configDir}-alias`;
  fs.symlinkSync(configDir, configAlias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.strictEqual(
      namespaceForResource(configAlias, 'browser_test', 1),
      namespaceForResource(configDir, 'browser_test', 1),
      'Browser runtime namespaces must use the canonical Config identity',
    );
  } finally {
    fs.rmSync(configAlias, { force: true });
  }
  assert.notStrictEqual(
    namespaceForResource(configDir, 'browser_test', 1),
    namespaceForResource(configDir, 'browser_other', 1),
  );
  assert.notStrictEqual(
    namespaceForResource(path.join(configDir, 'other-config'), 'browser_test', 1),
    namespaceForResource(configDir, 'browser_test', 1),
    'different Config directories must not share a Browser runtime namespace',
  );
  const expectedSession = sessionForResource('browser_test', 7);
  assert.match(expectedSession, /^fb-[a-f0-9]{16}$/);
  const metadata = await runtime.start('https://example.test/');
  assert.deepStrictEqual(metadata, { url: 'https://example.test/', title: 'Example' });
  const metadataCommands = calls
    .map(args => args.slice(4, -1))
    .filter(command => command[0] === 'eval' || command[0] === 'get');
  assert.deepStrictEqual(
    metadataCommands,
    [[
      'eval',
      '--base64',
      Buffer.from('({url:location.href,title:document.title})').toString('base64'),
    ]],
    'metadata must read URL and title from one authoritative page state',
  );
  assert.deepStrictEqual(calls[0].slice(0, 4), [
    '--namespace', namespaceForResource(configDir, 'browser_test', 7),
    '--session', expectedSession,
  ]);
  assert.deepStrictEqual(calls[0].slice(4), ['open', 'https://example.test/', '--json']);
  assert.strictEqual(
    commandEnvironments[0].AGENT_BROWSER_EXECUTABLE_PATH,
    '/Applications/Chromium',
  );
  assert.strictEqual(commandEnvironments[0].AGENT_BROWSER_PROFILE, profileDir);
  assert.strictEqual(commandEnvironments[0].AGENT_BROWSER_NO_AUTO_DIALOG, 'true');
  assert.strictEqual(commandEnvironments[0].AGENT_BROWSER_STREAM_QUALITY, '90');

  const callsBeforeNavigation = calls.length;
  assert.deepStrictEqual(
    await runtime.navigate('https://navigation.example/'),
    { url: 'https://navigation.example/', title: 'Navigated' },
  );
  assert.deepStrictEqual(
    calls.slice(callsBeforeNavigation).map(args => args.slice(4, -1)),
    [['open', 'https://navigation.example/']],
    'navigation must return the authoritative metadata from the navigation command itself',
  );

  const frames = [];
  runtime.on('frame', frame => frames.push(frame));
  stream.emit('message', Buffer.from(JSON.stringify({
    type: 'frame',
    data: 'jpeg-data',
    metadata: { deviceWidth: 900, deviceHeight: 600, pageScaleFactor: 1 },
  })));
  assert.strictEqual(frames[0].format, 'jpeg');
  assert.deepStrictEqual(frames[0].viewport, { width: 900, height: 600 });

  assert.deepStrictEqual((await runtime.snapshot()).elements, [{
    ref: 'e1',
    role: 'button',
    name: 'Run',
    value: '',
    disabled: false,
  }]);
  assert.deepStrictEqual(
    calls.find(args => args[4] === 'snapshot').slice(4),
    ['snapshot', '--json'],
  );
  largeSnapshotOutput = true;
  const largeSnapshot = await runtime.snapshot();
  largeSnapshotOutput = false;
  assert.strictEqual(largeSnapshot.accessibilityTree.length, 50_000);
  assert.strictEqual(largeSnapshot.accessibilityTreeChars, 50_001);
  assert.strictEqual(largeSnapshot.truncated, true);
  await runtime.click({ ref: 'e1' });
  await runtime.elementAction('hover', { selector: '#menu' });
  await runtime.type({ ref: 'e1', text: 'hello' }, true);
  await runtime.keyboard({ mode: 'type', text: 'editor text' });
  await runtime.select({ ref: 'e2', values: ['one', 'two'] });
  await runtime.drag({
    sourceSelector: '#source',
    targetSelector: '#target',
  });
  await runtime.upload({
    selector: '#upload',
    files: ['/workspace/a.txt', '/workspace/b.txt'],
  });
  await runtime.download({
    ref: 'e3',
    outputPath: '/private/download.bin',
    timeoutMs: 45_000,
  });
  await runtime.waitFor({
    mode: 'selector',
    selector: '#ready',
    state: 'visible',
    timeoutMs: 20_000,
  });
  await runtime.waitFor({
    mode: 'function',
    value: 'window.appReady === true',
  });
  await runtime.get({ what: 'attr', selector: '#link', attribute: 'href' });
  await runtime.is({ state: 'enabled', ref: 'e4' });
  await runtime.find({
    locator: 'role',
    value: 'button',
    action: 'click',
    name: 'Continue',
    exact: true,
  });
  const largeEvaluation = await runtime.evaluate({ expression: '({ title: document.title })' });
  assert.strictEqual(largeEvaluation.truncated, true);
  assert.strictEqual(largeEvaluation.outputChars > 100_000, true);
  assert.strictEqual(largeEvaluation.preview.length, 100_000);
  await runtime.debugLog('console', { clear: true });
  await runtime.debugLog('errors', {});
  await runtime.network({
    operation: 'requests',
    filter: '/api/',
    resourceType: 'xhr,fetch',
    method: 'POST',
    status: '2xx',
  });
  await runtime.network({ operation: 'request', requestId: '123.4' });
  await runtime.cookies({
    operation: 'set',
    name: 'theme',
    value: 'dark',
    sameSite: 'Lax',
    secure: true,
  });
  await runtime.storage({
    storageType: 'local',
    operation: 'set',
    key: 'theme',
    value: 'dark',
  });
  await runtime.frame({ selector: '#embedded' });
  await runtime.frame({ main: true });
  await runtime.dialog({ operation: 'accept', text: 'approved' });
  await runtime.resize({ width: 1024, height: 700, deviceScaleFactor: 1 });
  await runtime.pointer({ action: 'down', x: 10, y: 20, button: 'left' });
  await runtime.wheel({ x: 10, y: 20, deltaY: 120 });
  const sentBeforeText = stream.sent.length;
  await runtime.insertText('text');
  const textMessages = stream.sent.slice(sentBeforeText);
  await runtime.insertText('性能');
  await runtime.press({ type: 'key', key: 'Enter', code: 'Enter' });
  assert(stream.sent.some(message => message.type === 'input_mouse' && message.eventType === 'mousePressed'));
  assert(stream.sent.some(message => message.type === 'input_mouse' && message.eventType === 'mouseWheel'));
  assert.deepStrictEqual(
    textMessages.map(message => [message.eventType, message.key, message.text]),
    [
      ['keyDown', 't', 't'],
      ['keyUp', 't', undefined],
      ['keyDown', 'e', 'e'],
      ['keyUp', 'e', undefined],
      ['keyDown', 'x', 'x'],
      ['keyUp', 'x', undefined],
      ['keyDown', 't', 't'],
      ['keyUp', 't', undefined],
    ],
  );
  assert(stream.sent.some(message => message.type === 'input_keyboard' && message.eventType === 'keyDown'));
  assert(calls.some(args => args.slice(-4).join(' ') === 'keyboard inserttext 性能 --json'));
  const commands = calls.map(args => args.slice(4, -1));
  assert(commands.some(command => command.join(' ') === 'hover #menu'));
  assert(commands.some(command => command.join(' ') === 'keyboard type editor text'));
  assert(commands.some(command => command.join(' ') === 'select @e2 one two'));
  assert(commands.some(command => command.join(' ') === 'drag #source #target'));
  assert(commands.some(command => (
    command.join(' ') === 'upload #upload /workspace/a.txt /workspace/b.txt'
  )));
  assert(commands.some(command => (
    command.join(' ') === 'download @e3 /private/download.bin --timeout 45000'
  )));
  assert(commands.some(command => (
    command.join(' ') === 'wait #ready --state visible --timeout 20000'
  )));
  assert(commands.some(command => (
    command.join(' ') === 'wait --fn window.appReady === true --timeout 30000'
  )));
  assert(commands.some(command => command.join(' ') === 'get attr #link href'));
  assert(commands.some(command => command.join(' ') === 'is enabled @e4'));
  assert(commands.some(command => (
    command.join(' ') === 'find role button click --name Continue --exact'
  )));
  const evalCommand = commands.find(command => (
    command[0] === 'eval'
    && Buffer.from(String(command[2] || ''), 'base64').toString('utf8')
      === '({ title: document.title })'
  ));
  assert(evalCommand);
  assert.strictEqual(evalCommand[1], '--base64');
  assert.strictEqual(
    Buffer.from(evalCommand[2], 'base64').toString('utf8'),
    '({ title: document.title })',
  );
  assert(commands.some(command => command.join(' ') === 'console --clear'));
  assert(commands.some(command => command.join(' ') === 'errors'));
  assert(commands.some(command => (
    command.join(' ') === 'network requests --filter /api/ --type xhr,fetch --method POST --status 2xx'
  )));
  assert(commands.some(command => command.join(' ') === 'network request 123.4'));
  assert(commands.some(command => command.join(' ') === 'cookies set theme dark --sameSite Lax --secure'));
  assert(commands.some(command => command.join(' ') === 'storage local set theme dark'));
  assert(commands.some(command => command.join(' ') === 'frame #embedded'));
  assert(commands.some(command => command.join(' ') === 'frame main'));
  assert(commands.some(command => command.join(' ') === 'dialog accept approved'));
  assert(commandEnvironments.every(env => (
    env.AGENT_BROWSER_DEFAULT_TIMEOUT === process.env.AGENT_BROWSER_DEFAULT_TIMEOUT
  )));

  await runtime.close();
  assert.strictEqual(processActive, false);
  assert(calls.some(args => args.includes('close')));

  const externalCalls = [];
  processActive = true;
  const externalStream = new FakeStream();
  const external = new AgentBrowserRuntime({
    id: 'browser_external',
    generation: 2,
    configDir,
    profileDir: path.join(configDir, 'external-profile'),
    agentBrowserPath: '/managed/agent-browser',
    externalCdpUrl: 'http://127.0.0.1:9222',
    runCommand: async (_executable, args) => {
      externalCalls.push(args.slice(4, -1));
      const command = args.slice(4, -1);
      if (command[0] === 'session' && command[1] === 'info') {
        return {
          success: true,
          data: { active: processActive, pid: identity.pid, version: AGENT_BROWSER_VERSION },
        };
      }
      if (command[0] === 'tab' && command[1] === 'new') {
        return { success: true, data: { tabId: 't1' } };
      }
      if (command[0] === 'tab' && command[1] === 'list') {
        return {
          success: true,
          data: {
            tabs: [{
              active: true,
              label: 'farming-browser_external-g2',
              tabId: 't1',
              title: '',
              type: 'page',
              url: 'about:blank',
            }],
          },
        };
      }
      if (command[0] === 'stream' && command[1] === 'status') {
        return { success: true, data: { port: 47_778 } };
      }
      if (command[0] === 'get' && command[1] === 'url') {
        return { success: true, data: { url: 'about:blank' } };
      }
      if (command[0] === 'get' && command[1] === 'title') {
        return { success: true, data: { title: '' } };
      }
      if (command[0] === 'close') processActive = false;
      return { success: true, data: { tabs: [] } };
    },
    createWebSocket: url => {
      assert.strictEqual(url, 'ws://127.0.0.1:47778');
      return externalStream;
    },
    readProcessIdentity: async pid => (pid === identity.pid && processActive ? identity : null),
    wait: async () => {},
  });
  await external.start('about:blank');
  assert.deepStrictEqual(externalCalls[0], ['connect', 'http://127.0.0.1:9222']);
  assert.deepStrictEqual(externalCalls[1], [
    'tab', 'new', '--label', 'farming-browser_external-g2', 'about:blank',
  ]);
  assert.deepStrictEqual(externalCalls[2], ['tab', 't1']);
  await external.close();
  assert(externalCalls.some(command => command[0] === 'tab' && command[1] === 'close'));

  const borrowedCalls = [];
  processActive = true;
  const borrowedStream = new FakeStream();
  const borrowed = new AgentBrowserRuntime({
    id: 'browser_borrowed',
    generation: 1,
    configDir,
    profileDir: path.join(configDir, 'borrowed-profile'),
    agentBrowserPath: '/managed/agent-browser',
    externalCdpUrl: 'http://127.0.0.1:9222',
    selectInitialExternalTab: tabs => tabs[0],
    runCommand: async (_executable, args) => {
      const command = args.slice(4, -1);
      borrowedCalls.push(command);
      if (command[0] === 'session' && command[1] === 'info') {
        return {
          success: true,
          data: { active: processActive, pid: identity.pid, version: AGENT_BROWSER_VERSION },
        };
      }
      if (command[0] === 'tab' && command[1] === 'list') {
        return {
          success: true,
          data: {
            tabs: [{
              active: true,
              label: null,
              tabId: 't1',
              title: 'Signed in',
              type: 'page',
              url: 'https://account.example/',
            }],
          },
        };
      }
      if (command[0] === 'stream' && command[1] === 'status') {
        return { success: true, data: { port: 47_779 } };
      }
      if (command[0] === 'eval') {
        return {
          success: true,
          data: { result: { url: 'https://account.example/', title: 'Signed in' } },
        };
      }
      if (command[0] === 'close') processActive = false;
      return { success: true, data: {} };
    },
    createWebSocket: url => {
      assert.strictEqual(url, 'ws://127.0.0.1:47779');
      return borrowedStream;
    },
    readProcessIdentity: async pid => (pid === identity.pid && processActive ? identity : null),
    wait: async () => {},
  });
  assert.deepStrictEqual(
    await borrowed.start('about:blank'),
    { url: 'https://account.example/', title: 'Signed in' },
  );
  assert(borrowedCalls.some(command => command.join(' ') === 'tab t1'));
  assert(!borrowedCalls.some(command => command[0] === 'tab' && command[1] === 'new'));
  assert.strictEqual(borrowed.ownedTabIds.has('t1'), false);
  await borrowed.close();
  assert(!borrowedCalls.some(command => command[0] === 'tab' && command[1] === 'close'));

  const screenshotPaths = [];
  let oversizedScreenshot = false;
  let screenshotCommandsInFlight = 0;
  let maxScreenshotCommandsInFlight = 0;
  const screenshotRuntime = new AgentBrowserRuntime({
    id: 'browser_screenshot',
    generation: 3,
    configDir,
    profileDir: path.join(configDir, 'screenshots', 'profile'),
    agentBrowserPath: '/managed/agent-browser',
    executablePath: '/Applications/Chromium',
    runCommand: async (_executable, args) => {
      const command = args.slice(4, -1);
      assert.strictEqual(command[0], 'screenshot');
      screenshotPaths.push(command[1]);
      screenshotCommandsInFlight += 1;
      maxScreenshotCommandsInFlight = Math.max(maxScreenshotCommandsInFlight, screenshotCommandsInFlight);
      // One event-loop turn gives a competing command a deterministic chance
      // to overlap without introducing a wall-clock race into the test.
      await new Promise(resolve => setImmediate(resolve));
      fs.mkdirSync(path.dirname(command[1]), { recursive: true });
      fs.writeFileSync(command[1], `image-${screenshotPaths.length}`);
      if (oversizedScreenshot) fs.truncateSync(command[1], (32 * 1024 * 1024) + 1);
      screenshotCommandsInFlight -= 1;
      return { success: true, data: { path: command[1] } };
    },
  });
  screenshotRuntime.started = true;
  await Promise.all([screenshotRuntime.screenshot(), screenshotRuntime.screenshot()]);
  assert.strictEqual(maxScreenshotCommandsInFlight, 1);
  assert.strictEqual(new Set(screenshotPaths).size, 2);
  oversizedScreenshot = true;
  await assert.rejects(
    screenshotRuntime.screenshot(),
    /screenshot exceeds 33554432 bytes/,
  );
  assert.strictEqual(fs.existsSync(screenshotPaths.at(-1)), false);

  const commandOrder = [];
  let commandsInFlight = 0;
  let maxCommandsInFlight = 0;
  const serializationRuntime = new AgentBrowserRuntime({
    id: 'browser_serialization',
    generation: 1,
    configDir,
    profileDir: path.join(configDir, 'serialization', 'profile'),
    agentBrowserPath: '/managed/agent-browser',
    executablePath: '/Applications/Chromium',
    runCommand: async (_executable, args) => {
      const name = args[4];
      commandsInFlight += 1;
      maxCommandsInFlight = Math.max(maxCommandsInFlight, commandsInFlight);
      commandOrder.push(`start:${name}`);
      await new Promise(resolve => setImmediate(resolve));
      commandOrder.push(`end:${name}`);
      commandsInFlight -= 1;
      return { success: true, data: {} };
    },
  });
  await Promise.all([
    serializationRuntime.command(['first']),
    serializationRuntime.command(['second']),
  ]);
  assert.strictEqual(maxCommandsInFlight, 1);
  assert.deepStrictEqual(commandOrder, [
    'start:first',
    'end:first',
    'start:second',
    'end:second',
  ]);

  let mismatchProcessActive = true;
  const mismatchRuntime = new AgentBrowserRuntime({
    id: 'browser_version_mismatch',
    generation: 1,
    configDir,
    profileDir: path.join(configDir, 'version-mismatch', 'profile'),
    agentBrowserPath: '/managed/agent-browser',
    executablePath: '/Applications/Chromium',
    runCommand: async (_executable, args) => {
      const command = args.slice(4, -1);
      if (command[0] === 'tab' && command[1] === 'list') {
        return {
          success: true,
          data: { tabs: [{ active: true, tabId: 't1', url: 'about:blank' }] },
        };
      }
      if (command[0] === 'session' && command[1] === 'info') {
        return {
          success: true,
          data: { active: mismatchProcessActive, pid: identity.pid, version: '0.0.0' },
        };
      }
      if (command[0] === 'close') mismatchProcessActive = false;
      return { success: true, data: {} };
    },
    readProcessIdentity: async () => null,
    wait: async () => {},
  });
  await assert.rejects(
    mismatchRuntime.start('about:blank'),
    new RegExp(`agent-browser ${AGENT_BROWSER_VERSION} is required`),
  );
  assert.strictEqual(mismatchProcessActive, false);

  fs.rmSync(configDir, { recursive: true, force: true });
  console.log('agent-browser runtime tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
