const assert = require('assert');
const { submitAcpDraft, resolveAcpFollowUpBehavior } = require('../../src/components/code/acp/acp-composer-behavior.ts');
const { createDefaultAgentComposerState, MAX_COMPOSER_SUBMISSIONS, restorePendingFollowUpMessageForEdit } = require('../../src/components/code/composer-state.ts');
const { settleComposerSubmissionState } = require('../../src/components/code/useComposerFollowUpController.ts');
const { projectFilesWorkspaceId } = require('../../src/lib/project-workspaces.ts');

const agent = { id: 'agent-1', cwd: '/workspace', status: 'running', runtimeBinding: { kind: 'acp' } };
const image = { id: 'image', kind: 'image', name: 'screen.png', type: 'image/png', size: 12, status: 'ready', path: '/uploads/screen.png' };
const reference = { id: 'reference', kind: 'file', workspace: agent.cwd, rootId: projectFilesWorkspaceId(agent.cwd), path: 'src/index.ts', label: 'index.ts' };
let state;
function reset(draft = 'message', patch = {}) { state = { ...createDefaultAgentComposerState(), draft, ...patch }; }
function stage(patch = {}) {
  return submitAcpDraft({ agent, composerKey: 'acp:session-1', draft: state.draft, attachments: state.attachments,
    contextReferences: state.contextReferences, composerMode: state.mode, turnActive: false,
    updateComposerState: (key, update) => { assert.strictEqual(key, 'acp:session-1'); state = update(state); }, ...patch });
}

reset('inspect', { attachments: [image], contextReferences: [reference], mode: 'plan' });
assert.strictEqual(stage(), true);
assert.strictEqual(state.draft, '', 'staging releases the editor without waiting for transport or persistence');
assert.deepStrictEqual(state.attachments, []);
assert.deepStrictEqual(state.contextReferences, []);
assert.strictEqual(state.mode, 'default');
const first = state.submissions[0];
assert.match(first.id, /^[A-Za-z0-9._:-]{1,160}$/);
assert.strictEqual(first.status, 'queued');
assert.strictEqual(first.delivery, 'prompt');
assert.strictEqual(first.editableText, 'inspect');
assert.strictEqual(first.attachments[0].path, image.path);
assert.strictEqual(first.contextReferences[0].id, reference.id);
assert.deepStrictEqual(state.history.entries, [], 'local staging must not claim acceptance');
state = { ...state, draft: 'new draft', mode: 'goal', attachments: [{ ...image, id: 'new' }] };
state = settleComposerSubmissionState(state, first.id, true, first.editableText);
assert.strictEqual(state.draft, 'new draft');
assert.strictEqual(state.mode, 'goal');
assert.strictEqual(state.attachments[0].id, 'new');
assert.strictEqual(state.submissions, undefined);
assert.deepStrictEqual(state.history.entries, ['inspect']);
assert.strictEqual(settleComposerSubmissionState(state, first.id, false, undefined, 'unknown'), state,
  'late duplicate failure must not resurrect a settled request');

reset('recover', { attachments: [image], contextReferences: [reference], mode: 'plan' });
stage();
const rejected = state.submissions[0];
state = settleComposerSubmissionState(state, rejected.id, false, undefined, 'rejected');
assert.strictEqual(state.draft, 'recover');
assert.strictEqual(state.mode, 'plan');
assert.strictEqual(state.attachments[0].path, image.path);
assert.strictEqual(state.contextReferences[0].id, reference.id);
assert.strictEqual(state.submissions, undefined, 'definite failure returns the whole snapshot to an empty editor');

reset('uncertain'); stage();
const uncertain = state.submissions[0];
state = settleComposerSubmissionState(state, uncertain.id, false);
assert.strictEqual(state.draft, '');
assert.strictEqual(state.submissions[0].status, 'unknown', 'a timeout is never a zero-effect failure');
state = { ...state, draft: 'later text', contextReferences: [reference] };
state = settleComposerSubmissionState(state, uncertain.id, false, undefined, 'rejected');
assert.strictEqual(state.draft, 'later text');
assert.strictEqual(state.contextReferences[0].id, reference.id);
assert.strictEqual(state.submissions[0].status, 'failed', 'failure must not overwrite a newer draft');
state = settleComposerSubmissionState(state, uncertain.id, true, 'uncertain');
assert.strictEqual(state.draft, 'later text');
assert.strictEqual(state.submissions, undefined);

reset('same'); stage();
state = { ...state, draft: 'same' }; stage();
assert.notStrictEqual(state.submissions[0].id, state.submissions[1].id, 'identical intentional messages have independent identities');
state = settleComposerSubmissionState(state, state.submissions[0].id, false, undefined, 'rejected');
assert.strictEqual(state.submissions[0].status, 'failed', 'definite failure keeps the head when successors depend on it');
assert.strictEqual(state.draft, '', 'bouncing the head must not silently release later messages');
for (let i = 2; i < MAX_COMPOSER_SUBMISSIONS; i++) { state = { ...state, draft: `message ${i}` }; stage(); }
assert.strictEqual(state.submissions.length, MAX_COMPOSER_SUBMISSIONS);
state = { ...state, draft: 'overflow' }; stage();
assert.strictEqual(state.draft, 'overflow', 'queue saturation preserves the unsent draft');
assert.strictEqual(state.submissions.length, MAX_COMPOSER_SUBMISSIONS);

reset('queued', { attachments: [image], contextReferences: [reference] });
stage({ turnActive: true, followUpBehavior: 'queue' });
assert.strictEqual(state.submissions, undefined);
assert.strictEqual(state.pendingFollowUp.messages.length, 1);
state = restorePendingFollowUpMessageForEdit(state, state.pendingFollowUp.messages[0].id);
assert.strictEqual(state.draft, 'queued');
assert.strictEqual(state.attachments[0].path, image.path);
assert.strictEqual(state.contextReferences[0].id, reference.id);
stage({ turnActive: true, followUpBehavior: 'steer' });
assert.strictEqual(state.submissions[0].delivery, 'steer');
reset('first'); stage({ followUpBehavior: 'steer' });
assert.strictEqual(state.submissions[0].delivery, 'prompt', 'first input must not steer an absent turn');
reset('', { attachments: [image] }); stage();
assert.strictEqual(state.submissions[0].attachments[0].path, image.path);
reset('invalid', { attachments: [{ ...image, status: 'error' }] });
assert.strictEqual(stage(), false);
assert.strictEqual(state.draft, 'invalid');
reset('invalid', { contextReferences: [{ ...reference, workspace: '/other' }] });
assert.strictEqual(stage(), false);
assert.strictEqual(state.submissions, undefined);
reset('stopped');
assert.strictEqual(stage({ agent: { ...agent, status: 'stopped' } }), false);
assert.strictEqual(resolveAcpFollowUpBehavior('queue', false, true), 'queue');
assert.strictEqual(resolveAcpFollowUpBehavior('queue', true, true), 'steer');
assert.strictEqual(resolveAcpFollowUpBehavior('steer', true, true), 'queue');
assert.strictEqual(resolveAcpFollowUpBehavior('steer', false, false), 'queue');
console.log('PASS ACP local staging, exact settlement, recovery, bounds, and newer-draft fencing');
