const assert = require('assert');

const InlineTerminalScreenWorker = require('../inline-terminal-screen-worker');
const TerminalScreenWorker = require('../terminal-screen-worker');
const TerminalScreenWorkerPool = require('../terminal-screen-worker-pool');

async function runTests() {
  const previousMode = process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE;
  const previousPackagedRuntime = process.env.FARMING_PACKAGED_RUNTIME;

  try {
    process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE = 'inline';
    delete process.env.FARMING_PACKAGED_RUNTIME;
    assert.strictEqual(TerminalScreenWorkerPool.defaultWorkerClass(), InlineTerminalScreenWorker);

    process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE = 'thread';
    process.env.FARMING_PACKAGED_RUNTIME = '1';
    assert.strictEqual(TerminalScreenWorkerPool.defaultWorkerClass(), TerminalScreenWorker);

    delete process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE;
    process.env.FARMING_PACKAGED_RUNTIME = '1';
    const expectedDefault = process.platform === 'linux'
      ? InlineTerminalScreenWorker
      : TerminalScreenWorker;
    assert.strictEqual(TerminalScreenWorkerPool.defaultWorkerClass(), expectedDefault);

    const worker = new InlineTerminalScreenWorker({ cols: 20, rows: 4 });
    worker.append('inline worker ok\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    const state = await worker.getState();
    assert(state.previewText.includes('inline worker ok'));
    await worker.dispose();
  } finally {
    if (previousMode === undefined) delete process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE;
    else process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE = previousMode;
    if (previousPackagedRuntime === undefined) delete process.env.FARMING_PACKAGED_RUNTIME;
    else process.env.FARMING_PACKAGED_RUNTIME = previousPackagedRuntime;
  }

  console.log('✓ Terminal screen worker mode defaults are stable');
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = runTests;
