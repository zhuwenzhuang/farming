const assert = require('assert');
const {
  resolveAcpFollowUpBehavior,
  submitAcpDraft: submitAcpDraftBehavior,
  submitQueuedAcpFollowUp,
} = require('../../src/components/code/acp/acp-composer-behavior.ts');
const { createDefaultAgentComposerState } = require('../../src/components/code/composer-state.ts');

function readyImage() {
  return {
    id: 'image-1',
    kind: 'image',
    name: 'screen.png',
    type: 'image/png',
    size: 12,
    status: 'ready',
    path: '/tmp/screen.png',
    messageBlock: 'Attached image: screen.png\n\nImage path: /tmp/screen.png',
  };
}

async function run() {
  const agent = { id: 'agent-1', status: 'running', runtimeBinding: { kind: 'acp' } };
  const queuedAttachment = readyImage();
  let state = {
    ...createDefaultAgentComposerState(),
    draft: 'inspect this',
    attachments: [queuedAttachment],
  };
  const updateComposerState = (_key, updater) => {
    state = updater(state);
  };
  const prepareComposerStateForTransport = (_key, updater) => {
    const next = updater(state);
    if (next === state) return false;
    state = next;
    return true;
  };
  const submitAcpDraft = input => submitAcpDraftBehavior({
    ...input,
    prepareComposerStateForTransport,
  });
  const sent = [];
  const sendMessage = (_agent, text, attachments, requestId, delivery) => {
    sent.push({ text, attachments, requestId, delivery });
    return true;
  };

  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'inspect this',
    attachments: [queuedAttachment],
    composerMode: 'plan',
    turnActive: true,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 0, 'a running ACP turn should queue rather than prompt concurrently');
  assert.strictEqual(state.pendingFollowUp.messages.length, 1);
  assert(state.pendingFollowUp.messages[0].text.startsWith('Plan mode:'));
  assert.strictEqual(state.pendingFollowUp.messages[0].attachments[0].path, '/tmp/screen.png');
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.mode, 'default');

  const directAttachment = readyImage();
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'send now',
    attachments: [directAttachment],
  };
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'send now',
    attachments: [directAttachment],
    composerMode: 'default',
    turnActive: false,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'send now');
  assert.strictEqual(sent[0].attachments[0].name, 'screen.png');
  assert.match(sent[0].requestId, /^pending-/, 'the Composer checkpoint should own the ordinary Prompt request id');
  assert.strictEqual(sent[0].delivery, 'prompt');
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.submissions, undefined);

  const steerAttachment = readyImage();
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'change direction now',
    attachments: [steerAttachment],
  };
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'change direction now',
    attachments: [steerAttachment],
    composerMode: 'default',
    turnActive: true,
    followUpBehavior: 'steer',
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 2, 'Steer mode should submit directly into the running ACP turn');
  assert.strictEqual(sent[1].text, 'change direction now');
  assert.strictEqual(sent[1].attachments[0].path, '/tmp/screen.png');
  assert.strictEqual(sent[1].delivery, 'steer');
  assert.strictEqual(state.pendingFollowUp, undefined);
  assert.strictEqual(state.draft, '');

  assert.strictEqual(resolveAcpFollowUpBehavior('queue', false, true), 'queue');
  assert.strictEqual(resolveAcpFollowUpBehavior('queue', true, true), 'steer');
  assert.strictEqual(resolveAcpFollowUpBehavior('steer', false, true), 'steer');
  assert.strictEqual(resolveAcpFollowUpBehavior('steer', true, true), 'queue');
  assert.strictEqual(
    resolveAcpFollowUpBehavior('steer', false, false),
    'queue',
    'providers without Steer support must retain Queue behavior',
  );

  let acceptDelayedSubmission;
  const delayedSubmission = new Promise(resolve => {
    acceptDelayedSubmission = resolve;
  });
  const delayedAttachment = readyImage();
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'submitted draft',
    attachments: [delayedAttachment],
  };
  const delayedResult = submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: state.attachments,
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => delayedSubmission,
    updateComposerState,
  });
  assert.strictEqual(state.draft, 'submitted draft', 'an ordinary Prompt must remain in the Composer until admission succeeds');
  assert.strictEqual(state.attachments.length, 1);
  assert.strictEqual(state.submissions.length, 1, 'an ordinary Prompt must be staged before transport');
  assert.strictEqual(state.submissions[0].status, 'submitting');
  state = {
    ...state,
    draft: 'newer draft',
  };
  acceptDelayedSubmission(true);
  assert.strictEqual(await delayedResult, true);
  assert.strictEqual(state.draft, 'newer draft', 'a late ACK must not clear a newer draft');
  assert.strictEqual(state.attachments.length, 1);
  assert.strictEqual(state.submissions, undefined);
  assert.deepStrictEqual(state.history.entries, ['submitted draft']);

  let acceptModeSubmission;
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'preserve a newer mode',
  };
  const modeResult = submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => new Promise(resolve => { acceptModeSubmission = resolve; }),
    updateComposerState,
  });
  state = { ...state, mode: 'plan' };
  acceptModeSubmission(true);
  assert.strictEqual(await modeResult, true);
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.mode, 'plan', 'a late Prompt admission must not clear a newer Composer mode');

  let acceptOwnedSubmission;
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'clear only after acceptance',
  };
  const ownedResult = submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => new Promise(resolve => { acceptOwnedSubmission = resolve; }),
    updateComposerState,
  });
  assert.strictEqual(state.draft, 'clear only after acceptance');
  assert.strictEqual(state.submissions.length, 1);
  acceptOwnedSubmission(true);
  assert.strictEqual(await ownedResult, true);
  assert.strictEqual(state.draft, '');
  assert.deepStrictEqual(state.history.entries, ['clear only after acceptance']);

  state = {
    ...createDefaultAgentComposerState(),
    draft: '?',
  };
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: true,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(state.draft, '');
  state = { ...state, draft: 'inspect the separate issue' };
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: true,
    sendMessage,
    updateComposerState,
  }), true);
  assert.deepStrictEqual(
    state.pendingFollowUp.messages.map(message => message.text),
    ['?', 'inspect the separate issue'],
    'consecutive sends during a running Turn must retain two independent queue entries',
  );
  assert.notStrictEqual(
    state.pendingFollowUp.messages[0].id,
    state.pendingFollowUp.messages[1].id,
    'each queued send action must own a distinct request id',
  );
  assert.strictEqual(state.submissions, undefined);

  let rejectSubmission;
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'keep failed submission separate',
  };
  const rejectedResult = submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => new Promise(resolve => { rejectSubmission = resolve; }),
    updateComposerState,
  });
  rejectSubmission(false);
  assert.strictEqual(await rejectedResult, false);
  assert.strictEqual(state.draft, 'keep failed submission separate');
  assert.strictEqual(state.submissions.length, 1);
  assert.strictEqual(state.submissions[0].status, 'failed', 'a rejected ordinary Prompt must keep its stable retry id');

  state = {
    ...createDefaultAgentComposerState(),
    draft: 'synchronous transport failure',
  };
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => { throw new Error('socket closed'); },
    updateComposerState,
  }), false);
  assert.strictEqual(state.submissions.length, 1);
  assert.strictEqual(state.submissions[0].status, 'failed');
  assert.match(state.submissions[0].id, /^pending-/);

  state = {
    ...createDefaultAgentComposerState(),
    draft: 'asynchronous transport failure',
  };
  assert.strictEqual(await submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage: () => Promise.reject(new Error('socket closed')),
    updateComposerState,
  }), false);
  assert.strictEqual(state.submissions.length, 1);
  assert.strictEqual(state.submissions[0].status, 'failed');
  assert.match(state.submissions[0].id, /^pending-/);

  const sentBeforePersistenceFailure = sent.length;
  state = {
    ...createDefaultAgentComposerState(),
    draft: 'do not send without a durable browser intent',
  };
  assert.strictEqual(submitAcpDraftBehavior({
    agent,
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage,
    updateComposerState,
    prepareComposerStateForTransport: () => false,
  }), false);
  assert.strictEqual(sent.length, sentBeforePersistenceFailure);
  assert.strictEqual(state.draft, 'do not send without a durable browser intent');

  const queuedMessage = {
    id: 'pending-manual-send',
    text: 'do not send a queued message without persistence',
    editableText: 'do not send a queued message without persistence',
    createdAt: 1,
  };
  state = {
    ...createDefaultAgentComposerState(),
    pendingFollowUp: { createdAt: 1, messages: [queuedMessage] },
  };
  let queuedSendCount = 0;
  assert.strictEqual(submitQueuedAcpFollowUp({
    agent,
    composerKey: 'acp:session-1',
    message: queuedMessage,
    delivery: 'prompt',
    sendMessage: () => { queuedSendCount += 1; return true; },
    updateComposerState,
    prepareComposerStateForTransport: () => false,
  }), false);
  assert.strictEqual(queuedSendCount, 0, 'manual ACP pending send must stop before transport when storage fails');
  assert.deepStrictEqual(state.pendingFollowUp.messages, [queuedMessage]);
  assert.strictEqual(state.submissions, undefined);

  let queuedRequest;
  assert.strictEqual(submitQueuedAcpFollowUp({
    agent,
    composerKey: 'acp:session-1',
    message: queuedMessage,
    delivery: 'prompt',
    sendMessage: (_agent, text, attachments, requestId, delivery) => {
      queuedRequest = { text, attachments, requestId, delivery };
      return true;
    },
    updateComposerState,
    prepareComposerStateForTransport,
  }), true);
  assert.deepStrictEqual(queuedRequest, {
    text: queuedMessage.text,
    attachments: undefined,
    requestId: queuedMessage.id,
    delivery: 'prompt',
  });
  assert.strictEqual(state.pendingFollowUp, undefined);
  assert.strictEqual(state.submissions, undefined);

  state = {
    ...createDefaultAgentComposerState(),
    draft: 'keep this blocked draft',
  };
  const sentBeforeBlockedRecovery = sent.length;
  assert.strictEqual(submitAcpDraft({
    agent: {
      ...agent,
      status: 'stopped',
      requiresProcessExitAcknowledgement: true,
      runtimeBinding: {
        kind: 'acp',
        state: 'error',
        error: 'ACP recovery failed: Legacy ACP process exit cannot be proven after restart',
      },
    },
    composerKey: 'acp:session-1',
    draft: state.draft,
    attachments: [],
    composerMode: 'default',
    turnActive: false,
    sendMessage,
    updateComposerState,
  }), false);
  assert.strictEqual(sent.length, sentBeforeBlockedRecovery, 'blocked ACP recovery must not send');
  assert.strictEqual(state.draft, 'keep this blocked draft', 'blocked ACP recovery must preserve the draft');
  assert.strictEqual(state.pendingFollowUp, undefined, 'blocked ACP recovery must not create a false active turn');

  console.log('ACP composer behavior tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
