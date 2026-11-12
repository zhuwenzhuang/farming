import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';
import { acpToolDetail, acpTranscriptEntries } from '../acp-transcript.cjs';
import { applyAcpNativeTerminal } from '../../shared/acp-native-terminal';

for (const provider of ['codex', 'claude', 'pi', 'opencode', 'qoder', 'qwen', 'agy']) {
  let state = new AcpSessionState({ provider, sessionId: 'session' });
  const update = (value: Record<string, unknown>) => state.apply({ sessionId: 'session', update: value });
  state.beginPrompt('Work');
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact', content: { type: 'text', text: 'First' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Interleaved output' } });
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact', content: { type: 'text', text: ' second' } });
  const entry = state.entries.find(item => item.type === 'compaction')!;
  assert.equal(entry.summary, 'First second');
  const position = state.entries.indexOf(entry);
  update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed', summary: [{ type: 'text', text: 'Replacement' }], _meta: { reason: 'auto' } });
  assert.equal(state.entries.indexOf(entry), position);
  assert.equal(entry.summary, 'Replacement');
  update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'failed', error: 'Context unavailable' });
  assert.equal(entry.summary, 'Replacement', 'omitted summary keeps the current snapshot');
  assert.equal(entry._meta?.reason, 'auto');
  update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: undefined, summary: undefined, error: undefined, _meta: undefined });
  assert.equal(entry.status, 'failed');
  assert.equal(entry.summary, 'Replacement');
  assert.equal(entry._meta?.reason, 'auto');
  assert.match(projectAcpTranscript(state.snapshot()).turns[0].processItems.find(item => item.type === 'compaction')!.detail!, /Context unavailable/);
  update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed', summary: null, error: null, _meta: null });
  assert.equal(entry.summary, '');
  assert.equal(entry.error, '');
  assert.equal(entry._meta, undefined);
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact', content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } });
  assert.equal(projectAcpTranscript(state.snapshot()).turns[0].processItems.find(item => item.type === 'compaction')!.images?.length, 1);
  // Compaction IDs are a separate protocol namespace from user/tool IDs.
  update({ sessionUpdate: 'tool_call', toolCallId: 'collision', title: 'Tool', status: 'completed' });
  update({ sessionUpdate: 'compaction_update', compactionId: 'collision', status: 'in_progress' });
  assert.equal(new Set(state.entries.map(item => item.id)).size, state.entries.length);
  state = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  update({ sessionUpdate: 'compaction_update', compactionId: 'collision', status: 'completed', summary: [] });
  assert.equal(state.entries.filter(item => item.compactionId === 'collision').length, 1);
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cancel', status: undefined, content: { type: 'text', text: 'Partial summary' } });
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cancel', status: null, content: { type: 'text', text: ' before cancellation' } });
  update({ sessionUpdate: 'compaction_update', compactionId: 'cancel', status: '' });
  state.completePrompt('cancelled');
  update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cancel', content: { type: 'text', text: 'late' } });
  assert.equal(state.entries.find(item => item.compactionId === 'cancel')?.status, 'cancelled');
  assert.equal(state.entries.find(item => item.compactionId === 'cancel')?.summary, 'Partial summary before cancellation');

  state.beginPrompt('Observe a native command');
  const terminalBlock = { type: 'terminal', terminalId: 'term' };
  update({ sessionUpdate: 'tool_call', toolCallId: 'native-terminal', title: 'Command', kind: 'execute', status: 'in_progress',
    content: [terminalBlock], _meta: { terminal_info: { terminal_id: 'term' }, providerEvidence: 'preserved' } });
  const terminalUpdate = (key: string, data: string) => update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-terminal', _meta: { [key]: { terminal_id: 'term', data } } });
  terminalUpdate('terminal_output', 'first\n');
  terminalUpdate('terminal_output', provider === 'claude' ? 'first\nsecond\n' : 'second\n');
  terminalUpdate('terminal_output_delta', 'third\n');
  const output = 'first\nsecond\nthird\n';
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-terminal', status: 'completed',
    content: [terminalBlock, { type: 'content', content: { type: 'text', text: output } }], rawOutput: { stdout: output },
    _meta: { terminal_exit: { terminal_id: null, exit_code: 0 } } });
  const nativeTool = state.entries.find(item => item.id === 'native-terminal')!;
  const expectedDetail = 'first\nsecond\nthird\nExit code: 0';
  assert.equal(nativeTool.status, 'completed');
  assert.deepEqual(nativeTool._meta, { providerEvidence: 'preserved' });
  assert.equal(acpToolDetail(nativeTool), expectedDetail);
  assert.equal(projectAcpTranscript(state.snapshot()).turns.at(-1)!.processItems[0].detail, expectedDetail);
  assert.equal(projectAcpTranscript(state.snapshot()).turns.at(-1)!.processItems[0].terminalIds, undefined);
  const projected = acpTranscriptEntries([nativeTool]);
  assert(!JSON.stringify(projected).includes('"terminalId"'), 'display-only native output must not poll client-owned terminals');
  assert.equal(projected[0].transcriptDetail, expectedDetail);
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  assert.deepEqual(restored.entries.find(item => item.id === 'native-terminal')?.nativeTerminal, nativeTool.nativeTerminal);
  assert.throws(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-terminal',
    _meta: { terminal_output_delta: { terminal_id: 'another-terminal', data: 'wrong owner' } } }), /identity changed/);
}

const bounded = applyAcpNativeTerminal(null, { terminal_output_delta: { terminal_id: 'large', data: 'x'.repeat(1024 * 1024 + 1) } }, false)!;
assert.equal(bounded.output.length, 1024 * 1024);
assert.equal(bounded.truncated, true);
const replacement = applyAcpNativeTerminal(bounded, { terminal_output: { terminal_id: 'large', data: 'fresh' } }, true)!;
assert.equal(replacement.output, 'fresh');
assert.equal(replacement.truncated, false);
const largeTerminal = new AcpSessionState({ provider: 'claude', sessionId: 'large-output' });
largeTerminal.beginPrompt('Run a command');
const fullOutput = 'discarded-prefix' + bounded.output;
const terminalBlock = { type: 'terminal', terminalId: 'large' };
const mirror = { type: 'text', text: fullOutput };
const artifact = { type: 'content', content: { type: 'text', text: 'Independent tool artifact' } };
const rawImage = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
const mirrorFields = {
  content: [terminalBlock, { type: 'content', content: mirror }, artifact],
  rawOutput: { stdout: fullOutput, result: { content: [mirror, rawImage] } },
};
largeTerminal.apply({ sessionId: 'large-output', update: {
  sessionUpdate: 'tool_call', toolCallId: 'command', kind: 'execute', status: 'in_progress', content: [terminalBlock],
  _meta: {
    terminal_output: { terminal_id: 'large', data: fullOutput },
    providerEvidence: 'preserved',
  },
} });
largeTerminal.apply({ sessionId: 'large-output', update: {
  sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed', ...mirrorFields,
  _meta: { terminal_exit: { exit_code: 0 } },
} });
const largeEntry = largeTerminal.entries.find(item => item.id === 'command')!;
assert.deepEqual(largeEntry.nativeTerminal, { id: 'large', output: bounded.output, truncated: true, exitCode: 0, signal: null });
assert.deepEqual(largeEntry._meta, { providerEvidence: 'preserved' });
assert.deepEqual(largeEntry.content, [terminalBlock, artifact]);
assert.deepEqual(largeEntry.rawOutput, { result: { content: [rawImage] } });
const checkpoint = largeTerminal.exportCheckpoint();
const serialized = JSON.stringify(checkpoint);
assert(!serialized.includes('discarded-prefix'));
assert(serialized.length < 1024 * 1024 + 4096, 'checkpoint retains only one bounded terminal snapshot');
const restoredLargeEntry = AcpSessionState.fromCheckpoint(JSON.parse(serialized))!.entries.find(item => item.id === 'command')!;
assert.deepEqual(restoredLargeEntry, largeEntry);

// Older checkpoints and direct projection callers may still contain mirrors.
const oldEntry = { ...largeEntry, ...mirrorFields };
const oldSnapshot = { ...largeTerminal.snapshot(), entries: [largeTerminal.entries[0], oldEntry] };
const backendPreview = acpTranscriptEntries([oldEntry])[0].transcriptDetail as string;
const frontendItem = projectAcpTranscript(oldSnapshot).turns[0].processItems[0];
const detail = acpToolDetail(oldEntry) as string;
for (const preview of [backendPreview, frontendItem.detail!, detail]) {
  assert(!preview.includes('discarded-prefix'));
  assert.match(preview, /Independent tool artifact/);
  assert.match(preview, /Earlier terminal output truncated/);
}
assert.equal(frontendItem.images?.length, 1);
assert.equal(detail.split(bounded.output).length, 2, 'the retained terminal output appears once');
assert.match(detail, /Exit code: 0$/);
assert.deepEqual(AcpSessionState.fromCheckpoint({ ...checkpoint, entries: [oldEntry] })!.entries[0], largeEntry);

largeTerminal.apply({ sessionId: 'large-output', update: {
  sessionUpdate: 'tool_call', toolCallId: 'ordinary', kind: 'execute', status: 'completed', ...mirrorFields,
} });
const ordinary = largeTerminal.entries.find(item => item.id === 'ordinary')!;
assert.deepEqual(ordinary.content, mirrorFields.content);
assert.deepEqual(ordinary.rawOutput, mirrorFields.rawOutput);

const state = new AcpSessionState({ provider: 'opencode', sessionId: 'session' });
state.beginPrompt('Work');
const meta = (value: Record<string, unknown>) => state.apply({ sessionId: 'session', update: { sessionUpdate: 'session_info_update', _meta: value } });
meta({ 'opencode/retry': { attempt: 1, nextRetryAt: '2026-11-13T00:00:00Z', error: { message: 'Rate limit exceeded', response: { body: 'must not render raw response' } } } });
meta({ 'opencode/retry': { attempt: 2, error: { message: 'Still limited' } } });
assert.equal(state.entries.filter(item => item.type === 'status').length, 1);
assert.match(projectAcpTranscript(state.snapshot()).turns[0].processItems[0].title, /attempt 2/);
assert(!JSON.stringify(state.transcriptSlice().entries).includes('must not render'));
meta({ 'opencode/retry': null });
assert.equal(state.entries.find(item => item.type === 'status')?.status, 'completed');
meta({ 'opencode/retry': { attempt: 3, error: { message: 'Waiting' } } });
state.completePrompt();
assert(state.entries.filter(item => item.type === 'status').every(item => item.status === 'completed'));
meta({ 'opencode/compaction': { status: 'started', messageId: 'native-compaction', reason: 'auto' } });
meta({ 'opencode/compaction': { status: 'failed', messageId: 'native-compaction', error: { message: 'Could not compact' } } });
assert.equal(state.entries.find(item => item.compactionId === 'native-compaction')?.status, 'failed');
assert.match(projectAcpTranscript(state.snapshot()).turns[0].processItems.find(item => item.type === 'compaction')!.detail!, /Could not compact/);
const other = new AcpSessionState({ provider: 'qwen', sessionId: 'session' });
other.apply({ sessionId: 'session', update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 1, error: { message: 'Wrong provider' } } } } });
assert.equal(other.entries.length, 0);
console.log('test-acp-provider-status passed');
