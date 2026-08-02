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
cached.report({ dependencyId: 'codex', phase: 'ready', source: 'system', version: '0.146.0' });
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
  version: '0.3.207',
});
ttyRenderer.report({
  dependencyId: 'claude',
  phase: 'download',
  receivedBytes: 100,
  totalBytes: 200,
  version: '0.3.207',
});
ttyRenderer.report({ dependencyId: 'claude', phase: 'verify', version: '0.3.207' });
ttyRenderer.report({
  dependencyId: 'claude',
  phase: 'ready',
  source: 'managed',
  version: '0.3.207',
});
ttyRenderer.finish();
const ttyOutput = ttyStream.chunks.join('');
assert.match(ttyOutput, /\u001b\[36m/);
assert.match(ttyOutput, /50%/);
assert.match(ttyOutput, /Claude Code/);
assert.match(ttyOutput, /\r\u001b\[2K/);

console.log('✓ startup dependency progress stays compact in TTY and log output');
