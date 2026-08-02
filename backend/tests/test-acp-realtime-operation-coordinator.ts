const assert = require('assert');
import { AcpRealtimeOperationCoordinator } from '../acp-realtime-operation-coordinator.cjs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function run() {
  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let starts = 0;
    let stops = 0;
    await coordinator.stop('agent-a', 'binding-1', 'voice-op-1');
    const result = await coordinator.start(
      'agent-a',
      'binding-1',
      'voice-op-1',
      async () => {
        starts += 1;
        return { started: true };
      },
      async () => {
        stops += 1;
      },
    );
    assert.deepStrictEqual(result, { started: false, cancelled: true, operationId: 'voice-op-1' });
    assert.strictEqual(starts, 0, 'a stop tombstone must reject a late start before mutation');
    assert.strictEqual(stops, 0, 'a start rejected by its tombstone has nothing to stop');
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let starts = 0;
    for (let index = 0; index < 64; index += 1) {
      await coordinator.stop('agent-many-stops', 'binding-1', `voice-op-${index}`);
    }
    const earliest = await coordinator.start(
      'agent-many-stops',
      'binding-1',
      'voice-op-0',
      async () => {
        starts += 1;
        return { started: true };
      },
      async () => {},
    );
    assert.deepStrictEqual(earliest, {
      started: false,
      cancelled: true,
      operationId: 'voice-op-0',
    });
    assert.strictEqual(starts, 0, 'live-owner tombstones must not be evicted by later stops');
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    const firstStart = deferred<Record<string, unknown>>();
    const firstStopCalled = deferred<void>();
    const firstClosedBoundary = deferred<void>();
    const secondStartCalled = deferred<void>();
    let secondStartCount = 0;
    let firstStops = 0;
    let secondStops = 0;
    const firstResult = coordinator.start(
      'agent-a',
      'binding-1',
      'voice-op-1',
      () => firstStart.promise,
      async () => {
        firstStops += 1;
        firstStopCalled.resolve();
        await firstClosedBoundary.promise;
      },
    );
    const firstCancellation = coordinator.stop('agent-a', 'binding-1', 'voice-op-1');
    const secondResult = coordinator.start(
      'agent-a',
      'binding-1',
      'voice-op-2',
      async () => {
        secondStartCount += 1;
        secondStartCalled.resolve();
        return { started: true };
      },
      async () => {
        secondStops += 1;
      },
    );

    firstStart.resolve({ started: true });
    await firstStopCalled.promise;
    assert.strictEqual(
      secondStartCount,
      0,
      'replacement start must remain fenced after stop RPC until the closed boundary resolves',
    );
    firstClosedBoundary.resolve();
    await firstCancellation;
    assert.deepStrictEqual(await firstResult, {
      started: false,
      cancelled: true,
      operationId: 'voice-op-1',
    });
    await secondStartCalled.promise;
    assert.deepStrictEqual(await secondResult, { started: true, operationId: 'voice-op-2' });
    assert.strictEqual(firstStops, 1, 'replacement must reconcile the first accepted start exactly once');

    const lateFirstStop = await coordinator.stop('agent-a', 'binding-1', 'voice-op-1');
    assert.deepStrictEqual(lateFirstStop, {
      stopped: false,
      reconciled: true,
      operationId: 'voice-op-1',
    });
    assert.strictEqual(secondStops, 0, 'a late old stop must not stop the replacement operation');
    await coordinator.stop('agent-a', 'binding-1', 'voice-op-2');
    assert.strictEqual(secondStops, 1);
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let replacementStarts = 0;
    await coordinator.start(
      'agent-fence-failed',
      'binding-1',
      'voice-op-a',
      async () => ({ started: true }),
      async () => {
        throw new Error('closed boundary unavailable');
      },
    );
    const stopping = coordinator.stop('agent-fence-failed', 'binding-1', 'voice-op-a');
    const replacement = coordinator.start(
      'agent-fence-failed',
      'binding-1',
      'voice-op-b',
      async () => {
        replacementStarts += 1;
        return { started: true };
      },
      async () => {},
    );
    await assert.rejects(stopping, /closed boundary unavailable/);
    await assert.rejects(replacement, /closed boundary unavailable/);
    assert.strictEqual(
      replacementStarts,
      0,
      'a failed closed fence must block replacement until authoritative session recovery',
    );
    coordinator.resetAgent('agent-fence-failed');
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-fence-failed',
        'binding-2',
        'voice-op-b',
        async () => {
          replacementStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      { started: true, operationId: 'voice-op-b' },
    );
    assert.strictEqual(replacementStarts, 1);
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let rejectedStops = 0;
    await assert.rejects(
      coordinator.start(
        'agent-rejected',
        'binding-1',
        'voice-op-rejected',
        async () => {
          throw Object.assign(new Error('explicitly rejected'), { realtimeStartOutcome: 'rejected' });
        },
        async () => {
          rejectedStops += 1;
        },
      ),
      /explicitly rejected/,
    );
    assert.strictEqual(rejectedStops, 0, 'an explicit rejection proves this operation owns nothing to stop');

    let uncertainStops = 0;
    await assert.rejects(
      coordinator.start(
        'agent-uncertain',
        'binding-1',
        'voice-op-uncertain',
        async () => {
          throw new Error('transport outcome unknown');
        },
        async () => {
          uncertainStops += 1;
        },
      ),
      /transport outcome unknown/,
    );
    assert.strictEqual(uncertainStops, 1, 'an uncertain start must reconcile its possible ownership');
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let oldBindingStops = 0;
    let newBindingStops = 0;
    await coordinator.start(
      'agent-reconnected',
      'binding-a',
      'voice-op-a',
      async () => ({ started: true }),
      async () => {
        oldBindingStops += 1;
      },
    );
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-reconnected',
        'binding-b',
        'voice-op-b',
        async () => ({ started: true }),
        async () => {
          newBindingStops += 1;
        },
      ),
      { started: true, operationId: 'voice-op-b' },
    );
    assert.strictEqual(oldBindingStops, 0, 'binding replacement must not run an old stop against the new session');
    await coordinator.stop('agent-reconnected', 'binding-b', 'voice-op-a');
    assert.strictEqual(newBindingStops, 0, 'a delayed old operation stop must not stop the new binding owner');
    await coordinator.stop('agent-reconnected', 'binding-b', 'voice-op-b');
    assert.strictEqual(newBindingStops, 1);
  }

  for (const recoveryBoundary of [
    'crash followed by verified reconnect stop',
    'successful explicit session close',
    'verified unregister/kill',
  ]) {
    const coordinator = new AcpRealtimeOperationCoordinator();
    let oldStops = 0;
    await coordinator.start(
      'agent-recovered',
      'binding-old',
      `voice-op-old:${recoveryBoundary}`,
      async () => ({ started: true }),
      async () => {
        oldStops += 1;
      },
    );
    coordinator.resetAgent('agent-recovered');
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-recovered',
        'binding-new',
        `voice-op-new:${recoveryBoundary}`,
        async () => ({ started: true }),
        async () => {},
      ),
      { started: true, operationId: `voice-op-new:${recoveryBoundary}` },
      recoveryBoundary,
    );
    assert.strictEqual(oldStops, 0, `${recoveryBoundary} must not send an old stop to the new binding`);
  }

  console.log('✓ ACP Realtime operations serialize start and stop by exact operation ID');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
