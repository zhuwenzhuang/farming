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
} = require('../../extensions/browser/backend/agent-browser-runtime');

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
          snapshot: '- button "Run" [ref=e1]',
          origin: 'https://example.test/',
        },
      };
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
  assert.notStrictEqual(
    namespaceForResource(configDir, 'browser_test', 1),
    namespaceForResource(configDir, 'browser_other', 1),
  );
  const expectedSession = sessionForResource('browser_test', 7);
  assert.match(expectedSession, /^fb-[a-f0-9]{16}$/);
  const metadata = await runtime.start('https://example.test/');
  assert.deepStrictEqual(metadata, { url: 'https://example.test/', title: 'Example' });
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
  await runtime.click({ ref: 'e1' });
  await runtime.type({ ref: 'e1', text: 'hello' }, true);
  await runtime.resize({ width: 1024, height: 700, deviceScaleFactor: 1 });
  await runtime.pointer({ action: 'down', x: 10, y: 20, button: 'left' });
  await runtime.wheel({ x: 10, y: 20, deltaY: 120 });
  await runtime.insertText('text');
  await runtime.press({ type: 'key', key: 'Enter', code: 'Enter' });
  assert(stream.sent.some(message => message.type === 'input_mouse' && message.eventType === 'mousePressed'));
  assert(stream.sent.some(message => message.type === 'input_mouse' && message.eventType === 'mouseWheel'));
  assert(stream.sent.some(message => message.type === 'input_keyboard' && message.eventType === 'char'));
  assert(stream.sent.some(message => message.type === 'input_keyboard' && message.eventType === 'keyDown'));

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
        return { success: true, data: { tabId: 'tab-external' } };
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
  assert.deepStrictEqual(externalCalls[2], ['tab', 'tab-external']);
  await external.close();
  assert(externalCalls.some(command => command[0] === 'tab' && command[1] === 'close'));

  fs.rmSync(configDir, { recursive: true, force: true });
  console.log('agent-browser runtime tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
