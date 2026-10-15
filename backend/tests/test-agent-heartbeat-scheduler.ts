import assert from 'assert';
import { AgentHeartbeatScheduler } from '../agent-heartbeat-scheduler.cjs';

async function main() {
  const sweeps: boolean[] = [];
  const scheduler = new AgentHeartbeatScheduler({
    intervalMs: 60_000,
    onTick: tick => {
      sweeps.push(tick.sweepZombies);
    },
    zombieSweepIntervalMs: 100,
  });

  await scheduler.runOnce(100);
  await scheduler.runOnce(150);
  await scheduler.runOnce(200);
  assert.deepStrictEqual(sweeps, [true, false, true]);
  assert.strictEqual(scheduler.isRunning(), false);
  scheduler.start();
  scheduler.start();
  assert.strictEqual(scheduler.isRunning(), true);
  scheduler.stop();
  scheduler.stop();
  assert.strictEqual(scheduler.isRunning(), false);

  let release!: () => void;
  let calls = 0;
  const blocked = new AgentHeartbeatScheduler({
    intervalMs: 1,
    zombieSweepIntervalMs: 100,
    onTick: async () => { calls += 1; await new Promise<void>(resolve => { release = resolve; }); },
  });
  const first = blocked.runOnce(100);
  await Promise.resolve();
  const overlapping = blocked.runOnce(200);
  await Promise.resolve();
  assert.strictEqual(calls, 1, 'slow ticks must not overlap');
  release();
  await Promise.all([first, overlapping]);
  const next = blocked.runOnce(300);
  await Promise.resolve();
  assert.strictEqual(calls, 2, 'settled ticks release admission');
  release();
  await next;
  console.log('Agent heartbeat scheduler tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
