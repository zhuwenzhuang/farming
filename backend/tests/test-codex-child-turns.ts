import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { integrateCodexSubagentTurns } from '../../scripts/vendor/codex-subagent-integration';

async function run() {
  const source = integrateCodexSubagentTurns(fs.readFileSync(require.resolve('@agentclientprotocol/codex-acp'), 'utf8'));
  const start = source.indexOf('// src/subagents/PendingNotificationBuffer.ts');
  const end = source.indexOf('\n// src/', source.indexOf('function fallbackName(', start));
  assert(start >= 0 && end > start);
  const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
  let onStateUpdate: ((update: Record<string, unknown>, sessionId: string) => Promise<void> | void) | null = null;
  const Router = vm.runInNewContext(source.slice(start, end) + '\nCodexSubagentEventRouter', {
    Buffer,
    logger: { log() {}, error() {} },
    createSubagentModelConfigOption(_availableModels: unknown[], _parentBaseModelId: string | null, model: string) {
      return { id: 'model', currentValue: model };
    },
  });
  const router = new Router('parent', true, {
    async update(update: Record<string, unknown>, sessionId = 'parent') {
      if (onStateUpdate && update.sessionUpdate === 'subagent_state_update') {
        await onStateUpdate(update, sessionId);
      }
      updates.push({ sessionId, update });
    },
  }, () => {}, () => ({ availableModels: [], currentModel: 'gpt-5.4' }));
  const event = (method: string, turnId: string) => ({ method, params: {
    threadId: 'child', turn: { id: turnId, status: 'completed' }, turnId,
  } });
  await router.handle({ method: 'item/started', params: { threadId: 'parent', item: {
    type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/probe',
  } } });
  await router.handle(event('turn/started', 'first'));
  await router.handle(event('turn/completed', 'first'));
  assert(router.shouldIgnore(event('item/agentMessage/delta', 'first')));
  await router.handle(event('turn/started', 'second'));
  assert(!router.shouldIgnore(event('item/agentMessage/delta', 'second')), 'second-turn public progress must reach ACP');
  assert.equal(router.notificationSessionId(event('item/agentMessage/delta', 'second')), 'child');
  assert.equal(updates.filter(item => item.update.sessionUpdate === 'subagent_spawned').length, 1, 'one child conversation, not one row per turn');
  assert.equal(updates.at(-1)?.update.state, 'running');
  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1)?.update.capabilities)), { history: {} });
  const beforeDuplicate = updates.length;
  await router.handle(event('turn/started', 'second'));
  assert.equal(updates.length, beforeDuplicate);
  await router.handle(event('turn/completed', 'first'));
  assert(!router.shouldIgnore(event('item/agentMessage/delta', 'second')), 'late first completion cannot close the second turn');
  assert(router.shouldIgnore(event('item/agentMessage/delta', 'first')), 'late output cannot enter the new turn');
  await router.handle(event('turn/completed', 'second'));
  await router.handle(event('turn/started', 'second'));
  assert.equal(updates.at(-1)?.update.state, 'completed', 'duplicate start cannot revive a completed turn');

  const updatesBeforeStoppedModel = updates.length;
  await router.handle({
    method: 'thread/settings/updated',
    params: { threadId: 'child', threadSettings: { model: 'gpt-6-astra' } },
  });
  assert.equal(updates.length, updatesBeforeStoppedModel, 'stopped child model change waits until reopen');
  await router.handle(event('turn/started', 'third'));
  assert.equal(updates.at(-2)?.update.state, 'running');
  assert.equal(updates.at(-1)?.sessionId, 'child');
  assert.equal(updates.at(-1)?.update.sessionUpdate, 'config_option_update');
  assert.deepEqual(
    JSON.parse(JSON.stringify(updates.at(-1)?.update.configOptions)),
    [{ id: 'model', currentValue: 'gpt-6-astra' }],
  );

  await router.handle(event('turn/completed', 'third'));
  onStateUpdate = update => {
    if (update.state === 'running') {
      throw new Error('simulated reopen failure');
    }
  };
  await assert.rejects(
    () => router.handle(event('turn/started', 'fourth')),
    /simulated reopen failure/,
  );
  onStateUpdate = null;
  assert.equal(router.children.get('child')?.terminalState, 'completed');
  assert.equal(router.nativeChildTurns.get('child'), 'third', 'failed reopen rolls back nativeChildTurns so same-turn retry reopens');
  assert.equal(updates.at(-1)?.update.state, 'completed', 'failed reopen must not emit config_option_update');
  await router.handle(event('turn/started', 'fourth'));
  assert.equal(router.children.get('child')?.terminalState, undefined, 'retrying the same turn/started reopens the child');
  assert.equal(updates.at(-2)?.update.state, 'running');
  assert.equal(updates.at(-1)?.update.sessionUpdate, 'config_option_update');
  await router.handle(event('turn/completed', 'fourth'));

  onStateUpdate = update => {
    if (update.state === 'running') {
      router.children.get('child').terminalState = 'cancelled';
    }
  };
  await router.handle(event('turn/started', 'fifth'));
  onStateUpdate = null;
  assert.equal(updates.at(-1)?.update.sessionUpdate, 'subagent_state_update', 'stopped child mid-reopen must suppress model report');

  assert.equal(await router.handle({ method: 'turn/started', params: { threadId: 'unannounced', turn: { id: 'unknown' } } }), false);
  assert(!source.includes('const childSessionId = generation === 1 ?'), 'history retains the provider conversation identity');
  console.log('Codex child turn continuation tests passed');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
