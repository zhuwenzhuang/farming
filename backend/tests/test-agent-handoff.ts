import assert from 'node:assert/strict';
import { prepareAgentHandoff } from '../agent-handoff.cjs';
import { listProviderAdapters } from '../provider-adapters.cjs';
import { encodeProviderSessionKey } from '../../shared/provider-session-identity.js';
import { normalizeAgentHandoffContext } from '../../shared/agent-handoff-context.js';
import { AcpSessionState } from '../acp-session-state.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

for (const provider of listProviderAdapters()) {
  const source = {
    id: 'source-agent', cwd: '/workspace/project/subdir', projectWorkspace: '/workspace/project',
    providerSessionKey: encodeProviderSessionKey(provider.id, 'conversation', 'work'),
    providerHomePath: '/homes/source', providerSessionTemporary: false,
  };
  const before = structuredClone(source);
  for (const target of listProviderAdapters()) {
    const handoff = prepareAgentHandoff(source, target.executable);
    assert.equal(handoff.workspace, source.cwd);
    assert.equal(handoff.projectWorkspace, source.projectWorkspace);
    assert.equal(handoff.parentAgentId, source.id);
    assert.match(handoff.initialInput, /read-only/);
    assert.match(handoff.initialInput, /Do not reply or send a progress message before reading/);
    assert.match(handoff.initialInput, /wait for the user/);
    assert.match(handoff.initialInput, /language preference/);
    assert.doesNotMatch(handoff.initialInput, /quota|exhaust|token|中文|English/);
    const reference = JSON.parse(handoff.initialInput.split('\n\n')[1]);
    assert.deepEqual(reference, { provider: provider.id, home: source.providerHomePath, sessionId: 'conversation', workspace: source.cwd });
  }
  assert.deepEqual(source, before);
  const handoff = prepareAgentHandoff(source, provider.executable);
  const content = { type: 'text', text: handoff.initialInput };
  const state = new AcpSessionState({ provider: provider.id, sessionId: 'destination' });
  state.beginPrompt([content], handoff.context);
  state.apply({ sessionId: 'destination', update: {
    sessionUpdate: 'user_message_chunk', messageId: 'echo', content,
  } });
  assert.equal(state.entries.length, 1, 'presentation metadata must not duplicate provider echoes');
  assert.deepEqual(state.entries[0].content, [content], 'provider text remains unchanged');
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint());
  assert(restored);
  const restoredTurn = projectAcpTranscript({ sessionId: 'destination', entries: restored.sanitizedEntries() }).turns[0];
  assert.deepEqual(restoredTurn.handoffContext, handoff.context);
  assert.equal(restoredTurn.userMessage, handoff.initialInput);
  const replay = new AcpSessionState({ provider: provider.id, sessionId: 'forked-destination' });
  replay.pushEntry({ id: 'native-replay-user', type: 'message', role: 'user', content: [{ text: handoff.initialInput, type: 'text' }] });
  replay.restoreTrustedInputMetadata(state.exportCheckpoint());
  assert.deepEqual(projectAcpTranscript(replay.snapshot()).turns[0].handoffContext, handoff.context,
    'native replay and fork preserve verified handoff provenance despite regenerated IDs');
  const changed = new AcpSessionState({ provider: provider.id, sessionId: 'changed' });
  changed.beginPrompt('a different earlier question');
  changed.beginPrompt([content]);
  changed.restoreTrustedInputMetadata(state.exportCheckpoint());
  assert(changed.entries.every(entry => !entry._meta?.farmingHandoff),
    'matching text outside the verified prefix must remain ordinary history');
  const ordinary = new AcpSessionState({ provider: provider.id, sessionId: 'ordinary' });
  ordinary.beginPrompt([content]);
  assert.equal(projectAcpTranscript({ sessionId: 'ordinary', entries: ordinary.sanitizedEntries() }).turns[0].handoffContext, undefined,
    'identical text without provenance is still an ordinary message');
  assert.throws(() => prepareAgentHandoff(source, 'bash'), /coding Agent/);
  assert.throws(() => prepareAgentHandoff(source, 'codex resume other'), /coding Agent/);
  assert.throws(() => prepareAgentHandoff({ ...source, providerSessionTemporary: true }, 'codex'), /confirmed/);
  assert.throws(() => prepareAgentHandoff({ ...source, providerHomePath: '' }, 'codex'), /unavailable/);
  assert.throws(() => prepareAgentHandoff({ ...source, providerSessionKey: '' }, 'codex'), /confirmed/);
}
assert.throws(() => prepareAgentHandoff(undefined, 'codex'), /not found/);
for (const context of [null, {}, { version: 2, sourceSessionKey: 'agent-session:codex:test' }, { version: 1, sourceSessionKey: 'invalid' }]) {
  assert.equal(normalizeAgentHandoffContext(context), null);
}
console.log('✓ Handoff references exact native history across providers and requires read-first, language-preserving behavior');
