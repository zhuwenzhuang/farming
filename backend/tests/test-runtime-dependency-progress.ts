const assert = require('assert');
const {
  createRuntimeDependencyProgressRenderer,
  formatBytes,
  progressLine,
} = require('../runtime-dependency-progress.cjs');

function captureStream(isTTY) {
  const chunks = [];
  return {
    chunks,
    isTTY,
    write(chunk) {
      chunks.push(String(chunk));
    },
  };
}

assert.strictEqual(formatBytes(0), '0 B');
assert.strictEqual(formatBytes(1536), '1.5 KB');
assert.match(progressLine('agent-browser', 50, 100), /50%/);

const cachedStream = captureStream(false);
const cached = createRuntimeDependencyProgressRenderer({ stream: cachedStream });
cached.report({ dependencyId: 'codex', phase: 'ready', source: 'system', version: '0.148.0' });
cached.finish();
assert.strictEqual(cachedStream.chunks.join(''), '');

const failingRenderer = createRuntimeDependencyProgressRenderer({
  stream: {
    isTTY: true,
    write() {
      throw new Error('closed terminal');
    },
  },
});
assert.doesNotThrow(() => {
  failingRenderer.report({
    dependencyId: 'agentBrowser',
    phase: 'download',
    receivedBytes: 1,
    totalBytes: 2,
    version: '0.32.3',
  });
  failingRenderer.finish();
});

const logStream = captureStream(false);
const logRenderer = createRuntimeDependencyProgressRenderer({ stream: logStream });
logRenderer.report({
  dependencyId: 'agentBrowser',
  phase: 'download',
  receivedBytes: 0,
  totalBytes: 100,
  version: '0.32.3',
});
logRenderer.report({
  dependencyId: 'agentBrowser',
  phase: 'download',
  receivedBytes: 10,
  totalBytes: 100,
  version: '0.32.3',
});
logRenderer.report({
  dependencyId: 'agentBrowser',
  phase: 'retry',
  version: '0.32.3',
});
logRenderer.report({
  dependencyId: 'agentBrowser',
  phase: 'download',
  receivedBytes: 0,
  totalBytes: 100,
  version: '0.32.3',
});
logRenderer.report({ dependencyId: 'agentBrowser', phase: 'verify', version: '0.32.3' });
logRenderer.report({
  dependencyId: 'agentBrowser',
  phase: 'ready',
  source: 'managed',
  version: '0.32.3',
});
logRenderer.finish();
const logOutput = logStream.chunks.join('');
assert.match(logOutput, /Preparing startup dependencies/);
assert.match(logOutput, /Downloading agent-browser 0\.32\.3 \(100 B\)/);
assert.match(logOutput, /Downloading agent-browser: 10%/);
assert.match(logOutput, /mirror unavailable, retrying npm registry/);
assert.match(logOutput, /downloaded, verifying/);
assert.match(logOutput, /agent-browser 0\.32\.3 ready/);
assert.match(logOutput, /Startup dependencies ready/);
assert(!logOutput.includes('\u001b['));

let timestamp = 0;
const ttyStream = captureStream(true);
const ttyRenderer = createRuntimeDependencyProgressRenderer({
  env: { TERM: 'xterm-256color' },
  now: () => {
    timestamp += 100;
    return timestamp;
  },
  stream: ttyStream,
});
ttyRenderer.report({
  dependencyId: 'claude',
  phase: 'download',
  receivedBytes: 0,
  totalBytes: 200,
  version: '0.3.220',
});
ttyRenderer.report({
  dependencyId: 'claude',
  phase: 'download',
  receivedBytes: 100,
  totalBytes: 200,
  version: '0.3.220',
});
ttyRenderer.report({ dependencyId: 'claude', phase: 'verify', version: '0.3.220' });
ttyRenderer.report({
  dependencyId: 'claude',
  phase: 'ready',
  source: 'managed',
  version: '0.3.220',
});
ttyRenderer.finish();
const ttyOutput = ttyStream.chunks.join('');
assert.match(ttyOutput, /\u001b\[36m/);
assert.match(ttyOutput, /50%/);
assert.match(ttyOutput, /Claude Code/);
assert.match(ttyOutput, /\r\u001b\[2K/);


async function testParallelTerminal() {
  const { Terminal } = require('@xterm/headless');
  for (const columns of [100, 32]) {
    for (const noColor of [false, true]) {
      const stream = { ...captureStream(true), columns };
      const terminal = new Terminal({ cols: columns, rows: 12, convertEol: true, allowProposedApi: true });
      let time = 100;
      const renderer = createRuntimeDependencyProgressRenderer({
        stream, now: () => time,
        env: { TERM: 'xterm', ...(noColor ? { NO_COLOR: '1' } : {}) },
      });
      let consumed = 0;
      const screen = async () => {
        const output = stream.chunks.slice(consumed).join('');
        consumed = stream.chunks.length;
        if (output) await new Promise<void>(resolve => terminal.write(output, resolve));
        const buffer = terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true));
      };
      const report = (dependencyId, receivedBytes, totalBytes = 100) => renderer.report({
        dependencyId, receivedBytes, totalBytes, phase: 'download', version: '1.0.0',
      });
      try {
        report('codex', 0);
        report('claude', 0);
        let lines = await screen();
        assert.match(lines[1], /↓ Codex/);
        assert.match(lines[2], /↓ Claude Code/);
        assert.equal(terminal.buffer.active.cursorY, 3, 'exactly one physical row per dependency');
        // Coalesced progress must retain the other row's newest value.
        report('codex', 40);
        report('claude', 70);
        time += 100;
        report('codex', 50);
        lines = await screen();
        if (columns === 100) {
          assert.match(lines[1], /50%/);
          assert.match(lines[2], /70%/);
        }
        renderer.report({ dependencyId: 'codex', phase: 'verify', version: '1.0.0' });
        renderer.report({ dependencyId: 'codex', phase: 'ready', version: '1.0.0' });
        renderer.report({ dependencyId: 'claude', phase: 'retry', version: '1.0.0' });
        lines = await screen();
        assert.match(lines[1], /✓ Codex 1.0.0 ready/);
        assert.match(lines[2], /! Claude Code: mirror/);
        report('claude', 0, 0);
        time += 100;
        report('claude', 30, 0);
        lines = await screen();
        assert.match(lines[1], /✓ Codex 1.0.0 ready/);
        assert.match(lines[2], /Claude Code {2}30 B/);
        assert(!lines[2].includes('%'), 'unknown length must not invent a percentage');
        renderer.report({ dependencyId: 'claude', phase: 'failed', version: '1.0.0' });
        renderer.abort();
        renderer.abort();
        renderer.finish();
        stream.write('next prompt\n');
        lines = await screen();
        assert.match(lines[1], /✓ Codex 1.0.0 ready/);
        assert.match(lines[2], /✗ Claude Code 1.0.0 failed/);
        assert.equal(lines[3], 'next prompt', 'abort leaves cursor below the progress block');
        assert(!lines.some(line => line.includes('Startup dependencies ready')));
        if (noColor) assert(!/\u001b\[\d+m/.test(stream.chunks.join('')));
      } finally {
        terminal.dispose();
      }
    }
  }
  for (const isTTY of [false, true]) {
    const stream = captureStream(isTTY);
    const renderer = createRuntimeDependencyProgressRenderer({ stream, env: { TERM: 'dumb' } });
    for (let receivedBytes = 0; receivedBytes <= 100; receivedBytes++) {
      for (const dependencyId of ['codex', 'claude']) {
        renderer.report({ dependencyId, phase: 'download', receivedBytes, totalBytes: 100, version: '1' });
      }
    }
    renderer.report({ dependencyId: 'codex', phase: 'failed', version: '1' });
    renderer.abort();
    const output = stream.chunks.join('');
    assert(!output.includes('\u001b['));
    assert.match(output, /Codex 1 failed/);
    assert.equal((output.match(/Downloading /g) || []).length, 20, 'log output is bounded independently for each download');
  }
  // Exercise the real process.stderr TTY detection and cursor sequences through
  // the same native PTY used by Farming, then inspect its rendered screen.
  const pty = require('../packaged-node-pty.cjs').nodePty;
  const modulePath = require('node:path').resolve(__dirname, '../runtime-dependency-progress.cjs');
  const child = pty.spawn(process.execPath, ['-e', `
    const { createRuntimeDependencyProgressRenderer } = require(${JSON.stringify(modulePath)});
    const renderer = createRuntimeDependencyProgressRenderer();
    const ids = ['codex', 'claude', 'agentBrowser'];
    for (const dependencyId of ids) renderer.report({ dependencyId, phase: 'download', receivedBytes: 0, totalBytes: 100, version: '1.0.0' });
    for (const dependencyId of ids.slice().reverse()) {
      renderer.report({ dependencyId, phase: 'verify', version: '1.0.0' });
      renderer.report({ dependencyId, phase: 'ready', version: '1.0.0' });
    }
    renderer.finish();
    process.stdout.write('next prompt\\n');
  `], { name: 'xterm-256color', cols: 80, rows: 12, env: { ...process.env, TERM: 'xterm-256color' } });
  let output = '';
  const subscription = child.onData(chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  try {
    const exit = await new Promise<{ exitCode: number }>(resolve => child.onExit(resolve));
    assert.equal(exit.exitCode, 0, output);
    await new Promise<void>(resolve => terminal.write(output, resolve));
    const lines = Array.from({ length: 6 }, (_, index) => terminal.buffer.active.getLine(index).translateToString(true));
    assert.deepEqual(lines, [
      'Preparing startup dependencies',
      '✓ Codex 1.0.0 ready',
      '✓ Claude Code 1.0.0 ready',
      '✓ agent-browser 1.0.0 ready',
      '✓ Startup dependencies ready',
      'next prompt',
    ]);
  } finally {
    clearTimeout(timeout);
    subscription.dispose();
    terminal.dispose();
  }
  console.log('✓ parallel progress preserves separate rows in a native PTY, retries, failures, narrow widths and bounded plain logs');
}

testParallelTerminal().catch(error => { console.error(error); process.exitCode = 1; });
