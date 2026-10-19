import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentComposerAdmissionCoordinator,
  composerCommandHash,
  normalizedComposerCommands,
  normalizedComposerPrompt,
  type AgentComposerAdmissionPorts,
} from '../agent-composer-admission.cts';
import type {
  AgentRecord,
  ComposerCommandRecord,
} from '../agent-manager-record-types.js';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function terminalCommands(count: number): ComposerCommandRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    requestId: `terminal-${index}`,
    contentHash: `hash-${index}`,
    state: index % 2 === 0 ? 'accepted' : 'failed',
    result: null,
    error: '',
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
}

class ComposerAdmissionHarness {
  readonly agent = {
    id: 'agent-composer',
    composerCommands: [],
    runtimeBinding: { kind: 'acp' },
  } as unknown as AgentRecord;
  readonly persisted = new Map<string, ComposerCommandRecord>();
  deliverCount = 0;
  failPersistState = '';
  ownerCurrent = true;
  ownerFailure: unknown = null;
  persistCount = 0;
  delivery: AgentComposerAdmissionPorts['deliver'] = async request => {
    this.deliverCount += 1;
    request.onSubmitted({ kind: 'acp' });
    return { kind: 'acp' };
  };
  lastDelivery: Parameters<AgentComposerAdmissionPorts['deliver']>[0] | null = null;

  readonly ports: AgentComposerAdmissionPorts = {
    captureDeliveryOwner: () => ({
      assertCurrent: () => {
        if (this.ownerFailure) throw this.ownerFailure;
        if (!this.ownerCurrent) {
          throw Object.assign(new Error('runtime owner changed'), { uncertain: true });
        }
      },
    }),
    deliver: request => {
      this.lastDelivery = request;
      return this.delivery(request);
    },
    schedulePersistence: staged => {
      this.persistCount += 1;
      const command = staged.composerCommands?.at(-1);
      if (command?.state === this.failPersistState) {
        throw new Error(`persist ${command.state} failed`);
      }
      staged.agentRecordId = 'record-composer';
      staged.persistentSessionId = 'record-composer';
      this.persisted.clear();
      for (const candidate of staged.composerCommands || []) {
        this.persisted.set(candidate.requestId, structuredClone(candidate));
      }
      return 'record-composer';
    },
    runtimeKind: () => 'acp',
  };

  coordinator() {
    return new AgentComposerAdmissionCoordinator(this.ports);
  }

  request(
    coordinator: AgentComposerAdmissionCoordinator,
    message: unknown,
    requestId = 'request-1',
  ) {
    return coordinator.request({
      agent: this.agent,
      message,
      requestId,
    });
  }
}

test('explicit provider rejection includes its reason in the first terminal phase', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.delivery = async () => { throw new Error('No active ACP turn to steer'); };
  const statuses: Array<{ phase: string; message?: string }> = [];
  await assert.rejects(harness.coordinator().request({ agent: harness.agent, message: 'follow up',
    requestId: 'rejected-steer', onPhase: status => statuses.push(status),
  }), /No active ACP turn to steer/);
  assert.deepEqual(statuses.filter(status => status.phase === 'failed').map(status => status.message),
    ['No active ACP turn to steer']);
});

test('same Composer admission joins one delivery and conflicting content is rejected', async () => {
  const harness = new ComposerAdmissionHarness();
  const delivery = deferred<unknown>();
  harness.delivery = request => {
    harness.deliverCount += 1;
    return delivery.promise.then(result => {
      request.onSubmitted(result);
      return result;
    });
  };
  const coordinator = harness.coordinator();

  const first = harness.request(coordinator, 'same content');
  const joined = harness.request(coordinator, 'same content');
  assert.strictEqual(joined, first);
  await assert.rejects(
    harness.request(coordinator, 'different content'),
    /already used for different content/,
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deliverCount, 1);

  delivery.resolve({ kind: 'acp' });
  assert.deepEqual(await first, { accepted: true, kind: 'acp' });
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-1')?.state, 'accepted');
});

test('provider submission callback wins exactly once over a later delivery rejection', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.delivery = async request => {
    harness.deliverCount += 1;
    request.onSubmitted({ kind: 'acp', sessionId: 'session-1' });
    throw new Error('late provider turn failure');
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.deepEqual(
      await harness.request(harness.coordinator(), 'accepted before completion'),
      { accepted: true, kind: 'acp', sessionId: 'session-1' },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-1')?.state, 'accepted');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('snapshot failure cannot change an accepted result or cause replay', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.failPersistState = 'accepted';
  const coordinator = harness.coordinator();
  assert.equal((await harness.request(coordinator, 'accepted request') as { accepted: boolean }).accepted, true);
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'accepted');
  assert.equal((await harness.request(coordinator, 'accepted request') as { deduplicated: boolean }).deduplicated, true);
  assert.equal(harness.deliverCount, 1);
});

test('definitive failure may retry while uncertain failure may not', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.delivery = async () => {
    harness.deliverCount += 1;
    throw new Error('definitive rejection');
  };
  const coordinator = harness.coordinator();

  await assert.rejects(harness.request(coordinator, 'retryable request'), /definitive rejection/);
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-1')?.state, 'failed');

  harness.delivery = async request => {
    harness.deliverCount += 1;
    assert.equal(request.retryDefinitiveFailure, true);
    request.onSubmitted({ kind: 'acp' });
    return { kind: 'acp' };
  };
  assert.equal((await harness.request(coordinator, 'retryable request') as { accepted?: boolean }).accepted, true);
  assert.equal(harness.deliverCount, 2);

  const uncertain = new Error('transport ownership unknown') as Error & { uncertain?: boolean };
  uncertain.uncertain = true;
  harness.delivery = async () => {
    harness.deliverCount += 1;
    throw uncertain;
  };
  await assert.rejects(
    harness.request(coordinator, 'uncertain request', 'request-unknown'),
    error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
  );
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-unknown')?.state, 'unknown');
  await assert.rejects(
    harness.request(coordinator, 'uncertain request', 'request-unknown'),
    /will not be replayed automatically|transport ownership unknown/,
  );
  assert.equal(harness.deliverCount, 3);
});

test('a zero-effect runtime replacement on the exact record fails definitively', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  const replacedRuntime = Object.assign(
    new Error('Agent runtime changed before Terminal message delivery'),
    { composerRecordExact: true, composerZeroEffect: true },
  );
  harness.delivery = async () => {
    harness.deliverCount += 1;
    harness.ownerFailure = replacedRuntime;
    throw replacedRuntime;
  };

  await assert.rejects(
    harness.request(coordinator, 'queued behind a replaced runtime', 'request-epoch'),
    error => (
      error instanceof Error
      && (error as Error & { uncertain?: boolean }).uncertain !== true
      && /before Terminal message delivery/.test(error.message)
    ),
  );
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-epoch')?.state, 'failed');

  harness.ownerFailure = null;
  harness.delivery = async request => {
    harness.deliverCount += 1;
    assert.equal(request.retryDefinitiveFailure, true);
    request.onSubmitted({ kind: 'acp' });
    return { kind: 'acp' };
  };
  assert.equal(
    (await harness.request(coordinator, 'queued behind a replaced runtime', 'request-epoch') as {
      accepted?: boolean;
    }).accepted,
    true,
  );
  assert.equal(harness.deliverCount, 2);
});

test('a replaced Agent record is never written and stays uncertain', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.delivery = async () => {
    harness.deliverCount += 1;
    harness.ownerFailure = Object.assign(
      new Error('Agent record was replaced before Composer message delivery'),
      { composerRecordExact: false, uncertain: true },
    );
    throw Object.assign(
      new Error('Agent runtime changed before Terminal message delivery'),
      { composerZeroEffect: true },
    );
  };

  await assert.rejects(
    harness.request(harness.coordinator(), 'replaced record', 'request-replaced'),
    error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
  );
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-replaced')?.state, 'intent');
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'intent');
});

test('an unproven delivery error stays uncertain even when ownership proves zero effect', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  harness.delivery = async () => {
    harness.deliverCount += 1;
    harness.ownerFailure = Object.assign(
      new Error('Agent runtime changed before Terminal message delivery'),
      { composerRecordExact: true, composerZeroEffect: true },
    );
    throw new Error('Terminal runtime is unavailable');
  };

  await assert.rejects(
    harness.request(coordinator, 'unproven terminal failure', 'request-unproven'),
    error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
  );
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-unproven')?.state, 'unknown');

  harness.ownerFailure = null;
  await assert.rejects(
    harness.request(coordinator, 'unproven terminal failure', 'request-unproven'),
    /will not be replayed automatically|Terminal runtime is unavailable/,
  );
  assert.equal(harness.deliverCount, 1, 'an unknown outcome must never replay delivery');
});

test('recovered intent becomes unknown before any delivery', async () => {
  const harness = new ComposerAdmissionHarness();
  const prompt = normalizedComposerPrompt('recovered intent');
  harness.agent.composerCommands = [{
    requestId: 'request-recovered',
    contentHash: composerCommandHash({ prompt, delivery: 'auto' }),
    state: 'intent',
    result: null,
    error: '',
    createdAt: 1,
    updatedAt: 1,
  }];

  await assert.rejects(
    harness.request(harness.coordinator(), 'recovered intent', 'request-recovered'),
    error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
  );
  assert.equal(harness.deliverCount, 0);
  assert.equal(harness.agent.composerCommands?.find(command => command.requestId === 'request-recovered')?.state, 'unknown');
});

test('snapshot scheduling failure does not prevent delivery', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.failPersistState = 'intent';
  await harness.request(harness.coordinator(), 'send immediately');
  assert.equal(harness.deliverCount, 1);
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'accepted');
});

test('unknown and intent records survive more than 64 terminal outcomes without replay', async () => {
  for (const state of ['unknown', 'intent'] as const) {
    const harness = new ComposerAdmissionHarness();
    const requestId = `request-${state}`;
    const message = `${state} must survive retention`;
    const prompt = normalizedComposerPrompt(message);
    harness.agent.composerCommands = [{
      requestId,
      contentHash: composerCommandHash({ prompt, delivery: 'auto' }),
      state,
      result: null,
      error: '',
      createdAt: 1,
      updatedAt: 1,
    }, ...terminalCommands(70)];

    await assert.rejects(
      harness.request(harness.coordinator(), message, requestId),
      error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
    );
    assert.equal(harness.deliverCount, 0, `${state} must never be replayed`);
    assert.equal(
      harness.agent.composerCommands?.find(command => command.requestId === requestId)?.state,
      'unknown',
    );
    assert.equal(
      normalizedComposerCommands(harness.agent.composerCommands).filter(command => (
        command.state === 'accepted' || command.state === 'failed'
      )).length,
      64,
    );
  }
});

test('unresolved admission cap and requestId validation reject before persistence or delivery', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.agent.composerCommands = Array.from({ length: 64 }, (_, index) => ({
    requestId: `unknown-${index}`,
    contentHash: `unknown-hash-${index}`,
    state: 'unknown' as const,
    result: null,
    error: 'reconcile me',
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const coordinator = harness.coordinator();

  await assert.rejects(
    harness.request(coordinator, 'new request', 'request-over-cap'),
    /Too many unresolved Composer requests/,
  );
  await assert.rejects(
    coordinator.request({ agent: harness.agent, message: 'invalid id', requestId: 'invalid request id' }),
    /requestId is invalid/,
  );
  assert.equal(harness.persistCount, 0);
  assert.equal(harness.deliverCount, 0);
});

test('hash and delivery share one immutable prompt snapshot', async () => {
  const harness = new ComposerAdmissionHarness();
  const completion = deferred<unknown>();
  let deliveredPrompt: unknown = null;
  harness.delivery = request => {
    harness.deliverCount += 1;
    deliveredPrompt = request.prompt;
    return completion.promise.then(result => {
      request.onSubmitted(result);
      return result;
    });
  };
  const coordinator = harness.coordinator();
  const input = [{ type: 'text', text: 'original prompt' }];
  const admission = harness.request(coordinator, input, 'request-snapshot');
  input[0].text = 'mutated prompt';
  input.push({ type: 'text', text: 'appended' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deliveredPrompt, [{ type: 'text', text: 'original prompt' }]);
  assert(Object.isFrozen(deliveredPrompt));
  assert(Object.isFrozen((deliveredPrompt as Array<Record<string, unknown>>)[0]));
  assert.strictEqual(
    harness.request(coordinator, [{ type: 'text', text: 'original prompt' }], 'request-snapshot'),
    admission,
  );
  await assert.rejects(
    harness.request(coordinator, input, 'request-snapshot'),
    /already used for different content/,
  );
  completion.resolve({ kind: 'acp' });
  assert.equal((await admission as { accepted?: boolean }).accepted, true);
});

test('sync delivery throw settles once and permits a definitive retry', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  harness.delivery = () => {
    harness.deliverCount += 1;
    throw new Error('sync delivery failed');
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      harness.request(coordinator, 'sync failure', 'request-sync'),
      /sync delivery failed/,
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'failed');

    harness.delivery = async request => {
      harness.deliverCount += 1;
      assert.equal(request.retryDefinitiveFailure, true);
      request.onSubmitted({ kind: 'acp' });
      return { kind: 'acp' };
    };
    assert.equal(
      (await harness.request(coordinator, 'sync failure', 'request-sync') as { accepted?: boolean }).accepted,
      true,
    );
    assert.equal(harness.deliverCount, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('late callback from a rejected attempt cannot overwrite its retry', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  const callbacks: Array<(result?: unknown) => void> = [];
  const retryCompletion = deferred<unknown>();
  harness.delivery = request => {
    harness.deliverCount += 1;
    callbacks.push(request.onSubmitted);
    return harness.deliverCount === 1
      ? Promise.reject(new Error('first attempt rejected'))
      : retryCompletion.promise;
  };

  await assert.rejects(
    harness.request(coordinator, 'retry with late callback', 'request-late'),
    /first attempt rejected/,
  );
  await new Promise(resolve => setImmediate(resolve));
  const retry = harness.request(coordinator, 'retry with late callback', 'request-late');
  await new Promise(resolve => setImmediate(resolve));
  callbacks[0]({ kind: 'acp', stale: true });
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'intent');
  callbacks[1]({ kind: 'acp', stale: false });
  retryCompletion.resolve({ kind: 'acp' });
  const result = await retry as { accepted?: boolean; stale?: boolean };
  assert.equal(result.accepted, true);
  assert.equal(result.stale, false);
});

test('in-flight identity is an exact agentId and requestId tuple', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  const deliveries: Array<{
    complete: ReturnType<typeof deferred<unknown>>;
    onSubmitted(result?: unknown): void;
  }> = [];
  harness.delivery = request => {
    harness.deliverCount += 1;
    const complete = deferred<unknown>();
    deliveries.push({ complete, onSubmitted: request.onSubmitted });
    return complete.promise;
  };
  const firstAgent = { ...harness.agent, id: 'agent:a', composerCommands: [] } as AgentRecord;
  const secondAgent = { ...harness.agent, id: 'agent', composerCommands: [] } as AgentRecord;
  const first = coordinator.request({ agent: firstAgent, message: 'first', requestId: 'b' });
  const second = coordinator.request({ agent: secondAgent, message: 'second', requestId: 'a:b' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deliverCount, 2);
  deliveries.forEach(delivery => {
    delivery.onSubmitted({ kind: 'acp' });
    delivery.complete.resolve({ kind: 'acp' });
  });
  assert.equal((await first as { accepted?: boolean }).accepted, true);
  assert.equal((await second as { accepted?: boolean }).accepted, true);
});

test('stale runtime ownership cannot persist a late accepted callback', async () => {
  const harness = new ComposerAdmissionHarness();
  const delivery = deferred<unknown>();
  let onSubmitted: ((result?: unknown) => void) | null = null;
  harness.delivery = request => {
    harness.deliverCount += 1;
    onSubmitted = request.onSubmitted;
    return delivery.promise;
  };
  const admission = harness.request(harness.coordinator(), 'exact owner', 'request-owner');
  await new Promise(resolve => setImmediate(resolve));
  harness.ownerCurrent = false;
  onSubmitted?.({ kind: 'acp' });

  await assert.rejects(
    admission,
    error => error instanceof Error && (error as Error & { uncertain?: boolean }).uncertain === true,
  );
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'intent');
  delivery.resolve({ kind: 'acp' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.agent.composerCommands?.at(-1)?.state, 'intent');
});


test('expired queued submissions cannot become ghost messages when the queue later releases', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const harness = new ComposerAdmissionHarness();
  const gate = deferred<void>();
  harness.delivery = async request => {
    await gate.promise;
    request.assertCurrentOwner();
    harness.deliverCount += 1;
    request.onSubmitted({ kind: 'acp' });
  };
  const coordinator = harness.coordinator();
  const submission = harness.request(coordinator, 'must not send fifty minutes later');
  const rejected = assert.rejects(submission, error => Boolean((error as { uncertain?: boolean }).uncertain));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.status(harness.agent, 'request-1').phase, 'queued');
  t.mock.timers.tick(31_000);
  await rejected;
  assert.equal(coordinator.status(harness.agent, 'request-1').phase, 'unknown');
  gate.resolve();
  await coordinator.whenIdle(harness.agent.id);
  assert.equal(harness.deliverCount, 0);
  assert.equal(coordinator.status(harness.agent, 'request-1').phase, 'failed');
});

test('unavailable persistence does not delay delivery or same-request reconciliation', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.ports.schedulePersistence = () => {};
  const coordinator = harness.coordinator();
  await harness.request(coordinator, 'immediate send');
  for (let index = 0; index < 20; index += 1) assert.equal(coordinator.status(harness.agent, 'request-1').phase, 'submitted');
  assert.equal(harness.deliverCount, 1);
  await assert.rejects(harness.request(coordinator, 'conflicting'), /different content/);
  await harness.request(coordinator, 'immediate send');
  assert.equal(harness.deliverCount, 1);
});

test('peer admission binds immutable source to request identity and queues as a prompt', async () => {
  const harness = new ComposerAdmissionHarness();
  const coordinator = harness.coordinator();
  const source = { version: 1 as const, direction: 'incoming' as const, senderAddress: 'peer:builder', senderName: 'Builder' };
  const request = { agent: harness.agent, message: 'Check the build', requestId: 'peer-request', peerMessage: source };
  const pending = coordinator.request(request);
  source.senderName = 'Changed after submission';
  await pending;
  assert.equal(harness.lastDelivery?.peerMessage?.senderName, 'Builder');
  assert.equal(harness.lastDelivery?.delivery, 'prompt');
  await assert.rejects(coordinator.request(request), /different content/);
  // Also enforce the source binding after rebuilding the in-memory coordinator.
  await assert.rejects(harness.coordinator().request({ ...request, peerMessage: { ...source, senderAddress: 'peer:other' } }), /different content/);
  await coordinator.request({ ...request, peerMessage: { ...source, senderName: 'Builder' } });
  assert.equal(harness.deliverCount, 1);
});

test('peer admission rejects raw Terminal delivery before persistence', async () => {
  const harness = new ComposerAdmissionHarness();
  harness.ports.runtimeKind = () => 'terminal';
  await assert.rejects(harness.coordinator().request({
    agent: harness.agent, message: 'hello', requestId: 'peer-terminal',
    peerMessage: { version: 1, direction: 'incoming', senderAddress: 'peer:builder' },
  }), /structured Chat/);
  assert.equal(harness.persistCount, 0);
  assert.equal(harness.deliverCount, 0);
});

test('peer result observer waits for execution and receives post-admission failures', async () => {
  const harness = new ComposerAdmissionHarness();
  const pending = deferred<unknown>();
  const observations: unknown[] = [];
  harness.delivery = async request => {
    harness.deliverCount++;
    request.onSubmitted({ kind: 'acp' });
    return pending.promise;
  };
  const coordinator = harness.coordinator();
  await coordinator.request({ agent: harness.agent, message: 'hello', requestId: 'peer-result',
    onExecutionSettled: result => observations.push(result) });
  assert.deepEqual(observations, [], 'input acknowledgement is not execution completion');
  pending.reject(new Error('provider failed after admission'));
  await coordinator.whenIdle(harness.agent.id);
  assert.equal(observations.length, 1);
  assert.match(String((observations[0] as { error: Error }).error), /provider failed/);
});
