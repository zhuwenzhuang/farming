import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cjs';

const state = new AcpSessionState({ sessionId: 'protocol-compatibility' });
const apply = (update: Record<string, unknown>) => state.apply({ sessionId: state.sessionId, update });
state.beginPrompt('Inspect the service');
apply({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', status: 'in_progress', priority: 'medium' }] });
const baseline = state.snapshot().entries.find(entry => entry.type === 'plan');
assert(baseline);
const revision = state.revision;
// Farming does not advertise the experimental multi-plan contract. An
// unsupported peer event must not overwrite or remove its supported plan.
apply({ sessionUpdate: 'plan_update', plan: { type: 'markdown', id: 'a', content: 'Plan A' } });
apply({ sessionUpdate: 'plan_update', plan: { type: 'markdown', id: 'b', content: 'Plan B' } });
apply({ sessionUpdate: 'plan_removed', id: 'a' });
assert.equal(state.revision, revision);
assert.deepEqual(state.snapshot().entries.find(entry => entry.type === 'plan'), baseline);
apply({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', status: 'completed', priority: 'medium' }] });
assert.equal(state.snapshot().entries.filter(entry => entry.type === 'plan').length, 1);
assert.equal(state.snapshot().entries.find(entry => entry.type === 'plan')?.id, baseline.id);

apply({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'functions.exec', title: 'Inspect service', status: 'in_progress' });
const namedRevision = state.revision;
apply({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Inspection finished', status: 'completed' });
const tool = state.snapshot().entries.find(entry => entry.id === 'tool-1');
assert.equal(tool?.name, 'functions.exec', 'title and status patches must preserve tool identity');
assert.equal(state.transcriptSlice({ sinceRevision: namedRevision }).entries.find(entry => entry.id === 'tool-1')?.name, 'functions.exec');
const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint());
assert(restored);
assert.equal(restored.snapshot().entries.find(entry => entry.id === 'tool-1')?.name, 'functions.exec');
restored.apply({ sessionId: restored.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: null } });
assert.equal(restored.snapshot().entries.find(entry => entry.id === 'tool-1')?.name, null);
state.completePrompt();
assert.equal(state.plan, null);
state.beginPrompt('Follow up');
apply({ sessionUpdate: 'plan', entries: [{ content: 'Verify', status: 'in_progress', priority: 'medium' }] });
assert.equal(state.snapshot().entries.filter(entry => entry.type === 'plan').length, 2, 'new turns keep prior plan evidence');
console.log('ACP protocol compatibility tests passed');
