const assert = require('assert');
const {
  ComposerFollowUpAdmissions,
  failQueuedAcpFollowUp,
  settleComposerDelivery,
  settleComposerSubmissionState,
  stageComposerFollowUpForSteer,
} = require('../../src/components/code/useComposerFollowUpController.ts');
const {
  createDefaultAgentComposerState,
} = require('../../src/components/code/composer-state.ts');

function message(id, text = id) {
  return {
    id,
    text,
    createdAt: 1,
  };
}

async function run() {
  const admissions = new ComposerFollowUpAdmissions();
  assert.strictEqual(admissions.beginPending('acp:one', 'message-1'), true);
  assert.strictEqual(
    admissions.beginPending('acp:one', 'message-1'),
    false,
    'the same queued request must not execute concurrently',
  );
  assert.strictEqual(
    admissions.beginPending('acp:one', 'message-2'),
    false,
    'one Composer must preserve queue order while its head is in flight',
  );
  assert.strictEqual(
    admissions.beginPending('acp:two', 'message-2'),
    true,
    'independent Composer queues may deliver concurrently',
  );
  admissions.finishPending('acp:one', 'wrong-message');
  assert.strictEqual(admissions.pendingMessageId('acp:one'), 'message-1');
  admissions.finishPending('acp:one', 'message-1');
  assert.strictEqual(admissions.pendingMessageId('acp:one'), undefined);

  assert.strictEqual(admissions.beginSubmission('acp:key', 'message:one'), true);
  assert.strictEqual(
    admissions.beginSubmission('acp:key:message', 'one'),
    true,
    'exact tuple admission must not collide when Composer keys and message ids contain colons',
  );
  assert.strictEqual(admissions.beginSubmission('acp:one', 'message-1'), true);
  assert.strictEqual(admissions.beginSubmission('acp:one', 'message-1'), false);
  assert.strictEqual(admissions.beginSubmission('acp:one', 'message-2'), true);
  admissions.finishSubmission('acp:one', 'message-1');
  assert.strictEqual(admissions.isSubmissionActive('acp:one', 'message-1'), false);
  assert.strictEqual(admissions.isSubmissionActive('acp:one', 'message-2'), true);

  assert.strictEqual(admissions.beginPending('acp:blocked', 'never-settles'), true);
  assert.strictEqual(
    admissions.beginSubmission('acp:blocked', 'never-settles'),
    false,
    'one exact request cannot change from pending delivery to Steer/retry while in flight',
  );
  assert.strictEqual(
    admissions.isMutationActive('acp:blocked', 'never-settles'),
    true,
    'discard/edit guards must retain a never-settled request fence',
  );
  assert.strictEqual(admissions.canDiscardOrEdit('acp:blocked', 'never-settles'), false);
  admissions.finishPending('acp:blocked', 'different-request');
  assert.strictEqual(admissions.isMutationActive('acp:blocked', 'never-settles'), true);
  admissions.finishPending('acp:blocked', 'never-settles');
  assert.strictEqual(admissions.isMutationActive('acp:blocked', 'never-settles'), false);
  assert.strictEqual(admissions.canDiscardOrEdit('acp:blocked', 'never-settles'), true);
  assert.strictEqual(
    admissions.beginSubmission('acp:blocked', 'never-settles'),
    true,
    'an exact request may be explicitly retried only after its prior delivery settles',
  );

  let boundedOutcome = null;
  await new Promise<void>(resolve => {
    settleComposerDelivery(
      new Promise(() => {}),
      accepted => {
        boundedOutcome = accepted;
        resolve();
      },
      5,
    );
  });
  assert.strictEqual(
    boundedOutcome,
    false,
    'a broken send port must reach a bounded terminal outcome instead of holding admission forever',
  );

  let resolveLate;
  let lateResolveSettles = 0;
  const lateResolve = new Promise(resolve => { resolveLate = resolve; });
  await new Promise<void>(resolve => {
    settleComposerDelivery(lateResolve, accepted => {
      lateResolveSettles += 1;
      assert.strictEqual(accepted, false);
      resolve();
    }, 5);
  });
  resolveLate(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(lateResolveSettles, 1, 'a late transport acceptance must not settle twice after timeout');

  let rejectLate;
  let lateRejectSettles = 0;
  const lateReject = new Promise((_resolve, reject) => { rejectLate = reject; });
  await new Promise<void>(resolve => {
    settleComposerDelivery(lateReject, accepted => {
      lateRejectSettles += 1;
      assert.strictEqual(accepted, false);
      resolve();
    }, 5);
  });
  rejectLate(new Error('late transport rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(lateRejectSettles, 1, 'a late transport rejection must not settle twice after timeout');

  const queued = message('queued-steer', 'change direction');
  let state = {
    ...createDefaultAgentComposerState(),
    pendingFollowUp: { messages: [queued, message('queued-next')], createdAt: 1 },
  };
  state = stageComposerFollowUpForSteer(state, queued.id);
  assert.deepStrictEqual(state.pendingFollowUp.messages.map(candidate => candidate.id), ['queued-next']);
  assert.deepStrictEqual(state.submissions[0], {
    ...queued,
    status: 'submitting',
    historyRecorded: true,
    delivery: 'steer',
  });

  state = settleComposerSubmissionState(state, queued.id, false);
  assert.strictEqual(state.submissions[0].status, 'failed');
  state = settleComposerSubmissionState(state, queued.id, true);
  assert.strictEqual(state.submissions, undefined);
  assert.deepStrictEqual(
    state.history.entries,
    [],
    'a queued Steer already recorded its history and must not duplicate it on retry',
  );

  const failedPrompt = {
    ...message('queued-prompt', 'retry explicitly'),
    attachments: [{ kind: 'image', path: '/tmp/screen.png', name: 'screen.png', type: 'image/png', size: 1 }],
  };
  state = {
    ...createDefaultAgentComposerState(),
    pendingFollowUp: { messages: [failedPrompt], createdAt: 1 },
  };
  state = failQueuedAcpFollowUp(state, failedPrompt);
  assert.strictEqual(state.pendingFollowUp, undefined);
  assert.deepStrictEqual(state.submissions[0], {
    ...failedPrompt,
    status: 'failed',
    historyRecorded: true,
    delivery: 'prompt',
  });
  const unchanged = failQueuedAcpFollowUp(state, failedPrompt);
  assert.strictEqual(unchanged, state, 'a settled ACP failure must not be synthesized twice');

  const directFailure = {
    ...message('direct-prompt', 'record after retry'),
    status: 'failed',
    delivery: 'prompt',
  };
  state = {
    ...createDefaultAgentComposerState(),
    submissions: [directFailure],
  };
  state = settleComposerSubmissionState(state, directFailure.id, true, directFailure.text);
  assert.strictEqual(state.submissions, undefined);
  assert.deepStrictEqual(state.history.entries, ['record after retry']);

  console.log('test-composer-follow-up-controller passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
