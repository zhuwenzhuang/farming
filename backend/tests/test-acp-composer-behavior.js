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

function run() {
  const agent = { id: 'agent-1', runtimeBinding: { kind: 'acp' } };
  let state = createDefaultAgentComposerState();
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
    attachments: [readyImage()],
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

  state = createDefaultAgentComposerState();
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'send now',
    attachments: [readyImage()],
    composerMode: 'default',
    turnActive: false,
    supportsSteer: false,
    sendMessage,
    updateComposerState,
  }), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'send now');
  assert.strictEqual(sent[0].attachments[0].name, 'screen.png');

  state = createDefaultAgentComposerState();
  assert.strictEqual(submitAcpDraft({
    agent,
    composerKey: 'acp:session-1',
    draft: 'change direction now',
    attachments: [readyImage()],
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

  console.log('ACP composer behavior tests passed');
}

run();
