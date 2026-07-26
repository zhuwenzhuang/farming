const assert = require('assert');
const { submitAcpDraft } = require('../../src/components/code/acp/acp-composer-behavior.ts');
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
  const sent = [];
  const sendMessage = (_agent, text, attachments) => {
    sent.push({ text, attachments });
    return true;
  };

  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'inspect this',
    attachments: [queuedAttachment],
    composerMode: 'plan',
    turnActive: true,
    supportsSteer: false,
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
    supportsSteer: false,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'send now');
  assert.strictEqual(sent[0].attachments[0].name, 'screen.png');

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
    supportsSteer: true,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 2, 'a steer-capable running ACP turn should submit immediately');
  assert.strictEqual(sent[1].text, 'change direction now');
  assert.strictEqual(sent[1].attachments[0].path, '/tmp/screen.png');
  assert.strictEqual(state.pendingFollowUp, undefined);

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
    supportsSteer: false,
    sendMessage: () => delayedSubmission,
    updateComposerState,
  });
  state = {
    ...state,
    draft: 'newer draft',
  };
  acceptDelayedSubmission(true);
  assert.strictEqual(await delayedResult, true);
  assert.strictEqual(state.draft, 'newer draft', 'a late ACK must not clear a newer draft');
  assert.strictEqual(state.attachments.length, 1, 'a late ACK must not revoke attachments owned by a newer draft');

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
    supportsSteer: false,
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
