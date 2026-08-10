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

  console.log('Agent heartbeat scheduler tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
