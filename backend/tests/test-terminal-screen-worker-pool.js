const assert = require('assert');
const TerminalScreenWorkerPool = require('../terminal-screen-worker-pool');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FakeScreenWorker {
  constructor(options = {}) {
    FakeScreenWorker.created += 1;
    this.id = FakeScreenWorker.created;
    this.cols = options.cols || 80;
    this.rows = options.rows || 30;
    this.disposed = false;
  }

  async getState() {
    await delay(5);
    return {
      cols: this.cols,
      rows: this.rows,
      previewText: '',
      title: '',
    };
  }

  async resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    return this.getState();
  }

  async setRuntimeEpoch(runtimeEpoch, cols, rows) {
    this.runtimeEpoch = runtimeEpoch;
    this.cols = cols;
    this.rows = rows;
    return this.getState();
  }

  async dispose() {
    this.disposed = true;
    FakeScreenWorker.disposed += 1;
  }
}

FakeScreenWorker.created = 0;
FakeScreenWorker.disposed = 0;

async function run() {
  const pool = new TerminalScreenWorkerPool({
    size: 3,
    WorkerClass: FakeScreenWorker,
    workerOptions: {
      cols: 80,
      rows: 30,
      previewSnapshot: false,
    },
  });

  await pool.ready();
  assert.deepStrictEqual(pool.getStats(), {
    size: 3,
    idle: 3,
    pendingStarts: 0,
    waiters: 0,
    consecutiveStartFailures: 0,
  });
  assert.strictEqual(FakeScreenWorker.created, 3, 'pool should prewarm three workers');

  const first = await pool.acquire({ cols: 100, rows: 24 });
  assert.strictEqual(first.cols, 100);
  assert.strictEqual(first.rows, 24);
  await pool.ready();
  assert.strictEqual(pool.getStats().idle, 3, 'pool should replenish after checkout');
  assert.strictEqual(FakeScreenWorker.created, 4, 'checkout should trigger one replacement worker');

  const next = await Promise.all([
    pool.acquire(),
    pool.acquire(),
    pool.acquire(),
  ]);
  assert.strictEqual(new Set(next.map(worker => worker.id)).size, 3, 'each acquire should receive a distinct worker');
  await pool.ready();
  assert.strictEqual(pool.getStats().idle, 3, 'pool should refill after a burst checkout');
  assert.strictEqual(FakeScreenWorker.created, 7, 'burst checkout should be replenished back to three idle workers');

  await Promise.all([first, ...next].map(worker => worker.dispose()));
  await pool.dispose();
  assert.strictEqual(FakeScreenWorker.disposed, 7, 'checked-out and idle workers should all be disposable');

  const disabledPool = new TerminalScreenWorkerPool({
    size: 0,
    WorkerClass: FakeScreenWorker,
  });
  await disabledPool.ready();
  await assert.rejects(
    () => disabledPool.acquire(),
    /no workers configured/,
    'a disabled screen worker pool must fail fast instead of leaving terminal startup pending'
  );
  await disabledPool.dispose();

  class FailingScreenWorker {
    constructor() {
      FailingScreenWorker.created += 1;
    }

    async getState() {
      throw new Error('simulated worker startup failure');
    }

    async dispose() {
      FailingScreenWorker.disposed += 1;
    }
  }
  FailingScreenWorker.created = 0;
  FailingScreenWorker.disposed = 0;

  const failingPool = new TerminalScreenWorkerPool({
    size: 2,
    WorkerClass: FailingScreenWorker,
    retryDelayMs: 10000,
  });
  await assert.rejects(
    () => failingPool.ready(),
    /simulated worker startup failure/,
    'prewarm failure must reject ready instead of hanging forever'
  );
  assert.strictEqual(FailingScreenWorker.created, 2, 'one failed prewarm wave must stay bounded');
  assert.strictEqual(FailingScreenWorker.disposed, 2);
  assert.strictEqual(failingPool.getStats().consecutiveStartFailures, 2);
  await failingPool.dispose();

  class FlakyPrepareWorker extends FakeScreenWorker {
    async setRuntimeEpoch(runtimeEpoch, cols, rows) {
      if (this.id === FlakyPrepareWorker.failId) {
        throw new Error('simulated prepare failure');
      }
      return super.setRuntimeEpoch(runtimeEpoch, cols, rows);
    }
  }
  FakeScreenWorker.created = 0;
  FakeScreenWorker.disposed = 0;
  FlakyPrepareWorker.failId = 1;
  const preparePool = new TerminalScreenWorkerPool({
    size: 1,
    WorkerClass: FlakyPrepareWorker,
    retryDelayMs: 1,
  });
  await preparePool.ready();
  await assert.rejects(
    () => preparePool.acquire({ runtimeEpoch: 'epoch-a' }),
    /simulated prepare failure/,
  );
  await preparePool.ready();
  const prepared = await preparePool.acquire({ runtimeEpoch: 'epoch-b' });
  assert.strictEqual(prepared.runtimeEpoch, 'epoch-b');
  assert.ok(FakeScreenWorker.disposed >= 1, 'a worker that cannot be prepared must be disposed');
  await prepared.dispose();
  await preparePool.dispose();

  const releaseSlowStarts = [];
  class SlowStartWorker extends FakeScreenWorker {
    async getState() {
      await new Promise(resolve => {
        releaseSlowStarts.push(resolve);
      });
      return super.getState();
    }
  }
  FakeScreenWorker.created = 0;
  FakeScreenWorker.disposed = 0;
  const slowPool = new TerminalScreenWorkerPool({
    size: 1,
    WorkerClass: SlowStartWorker,
  });
  const slowReady = slowPool.ready();
  const slowAcquire = slowPool.acquire();
  await slowPool.dispose();
  await assert.rejects(() => slowReady, /disposed/);
  await assert.rejects(() => slowAcquire, /disposed/);
  releaseSlowStarts.forEach(resolve => resolve());
  await delay(10);
  assert.strictEqual(FakeScreenWorker.disposed, 2, 'workers finishing after disposal must be disposed');

  console.log('✓ Terminal screen worker pool prewarms and replenishes workers');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
