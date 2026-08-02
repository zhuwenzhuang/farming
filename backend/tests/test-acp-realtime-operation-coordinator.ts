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
    const coordinator = new AcpRealtimeOperationCoordinator({ cancelledOperationLimit: 2 });
    let probeStarts = 0;
    let probeStops = 0;
    let freshStarts = 0;
    await coordinator.stop('agent-saturated', 'binding-1', 'voice-op-0');
    await coordinator.stop('agent-saturated', 'binding-1', 'voice-op-0');
    await coordinator.stop('agent-saturated', 'binding-1', 'voice-op-1');
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-saturated',
        'binding-1',
        'voice-op-capacity-probe',
        async () => {
          probeStarts += 1;
          return { started: true };
        },
        async () => {
          probeStops += 1;
        },
      ),
      { started: true, operationId: 'voice-op-capacity-probe' },
      'a duplicate stop must not consume unique tombstone capacity',
    );
    await coordinator.stop('agent-saturated', 'binding-1', 'voice-op-overflow');

    assert.deepStrictEqual(
      await coordinator.start(
        'agent-saturated',
        'binding-1',
        'voice-op-0',
        async () => {
          freshStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      { started: false, cancelled: true, operationId: 'voice-op-0' },
      'saturation must not evict the oldest late-start evidence',
    );
    await assert.rejects(
      coordinator.start(
        'agent-saturated',
        'binding-1',
        'voice-op-fresh',
        async () => {
          freshStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      error => error instanceof Error
        && /Restart Codex Chat/.test(error.message)
        && (error as Error & { realtimeStartOutcome?: string }).realtimeStartOutcome === 'rejected',
    );
    assert.strictEqual(probeStarts, 1);
    assert.strictEqual(probeStops, 1, 'a saturated replacement must still reconcile the different current operation');
    assert.strictEqual(freshStarts, 0, 'a saturated owner must reject before provider start mutation');

    coordinator.resetAgent('agent-saturated');
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-saturated',
        'binding-2',
        'voice-op-fresh',
        async () => {
          freshStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      { started: true, operationId: 'voice-op-fresh' },
    );
    assert.strictEqual(freshStarts, 1, 'authoritative reset must admit the new binding owner');
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator({ cancelledOperationLimit: 1 });
    const closed = deferred<void>();
    const stopCalled = deferred<void>();
    let starts = 0;
    let stops = 0;
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-current-overflow',
        'binding-1',
        'voice-op-live',
        async () => {
          starts += 1;
          return { started: true };
        },
        async () => {
          stops += 1;
          stopCalled.resolve();
          await closed.promise;
        },
      ),
      { started: true, operationId: 'voice-op-live' },
    );
    await coordinator.stop('agent-current-overflow', 'binding-1', 'voice-op-filler');
    const stopping = coordinator.stop('agent-current-overflow', 'binding-1', 'voice-op-live');
    const duplicateStop = coordinator.stop('agent-current-overflow', 'binding-1', 'voice-op-live');
    let duplicateSettled = false;
    const duplicateStart = coordinator.start(
      'agent-current-overflow',
      'binding-1',
      'voice-op-live',
      async () => {
        starts += 1;
        return { started: true };
      },
      async () => {},
    ).finally(() => {
      duplicateSettled = true;
    });
    await stopCalled.promise;
    await Promise.resolve();
    assert.strictEqual(
      duplicateSettled,
      false,
      'a cancelled duplicate start must remain pending until the exact provider stop closes',
    );
    assert.strictEqual(starts, 1, 'a cancelled duplicate must not invoke provider start again');
    assert.strictEqual(stops, 1, 'duplicate exact stops must share one reconciliation');
    closed.resolve();
    assert.deepStrictEqual(await duplicateStart, {
      started: false,
      cancelled: true,
      operationId: 'voice-op-live',
    });
    await Promise.all([stopping, duplicateStop]);
  }

  {
    const coordinator = new AcpRealtimeOperationCoordinator({ cancelledOperationLimit: 2 });
    const stopCalled = deferred<void>();
    const stopFailure = deferred<void>();
    let starts = 0;
    let stops = 0;
    await coordinator.start(
      'agent-current-stop-failed',
      'binding-1',
      'voice-op-live',
      async () => {
        starts += 1;
        return { started: true };
      },
      async () => {
        stops += 1;
        stopCalled.resolve();
        await stopFailure.promise;
      },
    );
    await coordinator.stop('agent-current-stop-failed', 'binding-1', 'voice-op-filler');
    const stopping = coordinator.stop('agent-current-stop-failed', 'binding-1', 'voice-op-live');
    const duplicateStart = coordinator.start(
      'agent-current-stop-failed',
      'binding-1',
      'voice-op-live',
      async () => {
        starts += 1;
        return { started: true };
      },
      async () => {},
    );
    const uncertainFence = (error: unknown) => error instanceof Error
      && /provider stop failed/.test(error.message)
      && (error as Error & { realtimeStartOutcome?: string }).realtimeStartOutcome === 'uncertain'
      && (error as Error & { realtimeFenceFailed?: boolean }).realtimeFenceFailed === true;
    const observedStop = assert.rejects(stopping, uncertainFence);
    const observedDuplicate = assert.rejects(duplicateStart, uncertainFence);
    await stopCalled.promise;
    stopFailure.reject(new Error('provider stop failed'));
    await Promise.all([observedStop, observedDuplicate]);
    assert.strictEqual(starts, 1, 'a failed exact reconciliation must not invoke provider start again');
    assert.strictEqual(stops, 1, 'a duplicate start must reuse the one failed provider stop');
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

  {
    const coordinator = new AcpRealtimeOperationCoordinator({ cancelledOperationLimit: 1 });
    let delayedOldStarts = 0;
    let liveOwnerStops = 0;
    await coordinator.stop('agent-old-tombstone', 'binding-a', 'voice-op-old');
    await coordinator.stop('agent-old-tombstone', 'binding-a', 'voice-op-overflow');
    await coordinator.start(
      'agent-old-tombstone',
      'binding-b',
      'voice-op-live',
      async () => ({ started: true }),
      async () => {
        liveOwnerStops += 1;
      },
    );
    assert.deepStrictEqual(
      await coordinator.start(
        'agent-old-tombstone',
        'binding-a',
        'voice-op-old',
        async () => {
          delayedOldStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      { started: false, cancelled: true, operationId: 'voice-op-old' },
      'an old-owner tombstone must not delete a different live owner',
    );
    assert.strictEqual(delayedOldStarts, 0);
    await assert.rejects(
      coordinator.start(
        'agent-old-tombstone',
        'binding-a',
        'voice-op-fresh',
        async () => {
          delayedOldStarts += 1;
          return { started: true };
        },
        async () => {},
      ),
      /Restart Codex Chat/,
      'a saturated old owner must reject without deleting a different live owner',
    );
    assert.strictEqual(delayedOldStarts, 0);
    await coordinator.stop('agent-old-tombstone', 'binding-b', 'voice-op-live');
    assert.strictEqual(liveOwnerStops, 1, 'the live owner must remain exactly stoppable after an old delayed start');
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
