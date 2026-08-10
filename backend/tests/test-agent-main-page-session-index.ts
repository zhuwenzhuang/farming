import assert from 'assert';
import type { AgentRecord } from '../agent-manager-record-types.js';
import { AgentMainPageSessionIndex } from '../agent-main-page-session-index.cjs';
import { mainPageAgentSessionKey } from '../main-page-session.cjs';

function main() {
  const codexKey = mainPageAgentSessionKey('codex', 'session-1', 'default');
  const claudeKey = mainPageAgentSessionKey('claude', 'session-2', 'default');
  let keys = [codexKey, claudeKey];
  const removed: string[][] = [];
  const persisted: AgentRecord[] = [];
  let ownerAssertions = 0;
  const config = {
    getMainPageSessionKeys: () => [...keys],
    rememberAgentSessionRecord(agent: AgentRecord) {
      keys = [agent.providerSessionKey || '', ...keys.filter(key => key !== agent.providerSessionKey)];
      return 'record-remembered';
    },
    removeMainPageSessionKeys(sessionKeys: string[]) {
      removed.push(sessionKeys);
      keys = keys.filter(key => !sessionKeys.includes(key));
    },
  };
  const index = new AgentMainPageSessionIndex({
    config,
    persistence: {
      assertRuntimeOwner() {
        ownerAssertions += 1;
      },
      persist(agent) {
        persisted.push(agent);
        return 'record-persisted';
      },
    },
  });

  assert.deepStrictEqual(index.list(), [codexKey, claudeKey]);
  const alreadyFirst: AgentRecord = {
    id: 'agent-codex',
    providerHomeId: 'default',
    providerSessionId: 'session-1',
    providerSessionKey: codexKey,
    providerSessionProvider: 'codex',
  };
  index.remember(alreadyFirst);
  assert.strictEqual(ownerAssertions, 1);
  assert.deepStrictEqual(persisted, [alreadyFirst]);

  const remembered: AgentRecord = {
    id: 'agent-claude',
    providerHomeId: 'default',
    providerSessionId: 'session-2',
    providerSessionKey: claudeKey,
    providerSessionProvider: 'claude',
  };
  index.remember(remembered);
  assert.strictEqual(remembered.agentRecordId, 'record-remembered');
  assert.strictEqual(index.list()[0], claudeKey);

  assert.deepStrictEqual(index.removeAgents([{ id: 'legacy', providerSessionKey: codexKey }]), [codexKey]);
  assert.deepStrictEqual(removed, [[codexKey]]);
  assert.deepStrictEqual(index.removeAgents([{ id: 'missing', providerSessionKey: codexKey }]), []);

  let fallbackKeys = [codexKey, claudeKey];
  const fallback = new AgentMainPageSessionIndex({
    config: {
      getSettings: () => ({ mainPageSessionKeys: [...fallbackKeys] }),
      updateSettings(patch) {
        fallbackKeys = patch.mainPageSessionKeys;
      },
    },
    persistence: {
      assertRuntimeOwner() {},
      persist: () => '',
    },
  });
  assert.deepStrictEqual(
    fallback.removeAgents([{ id: 'fallback', providerSessionKey: claudeKey }]),
    [claudeKey],
  );
  assert.deepStrictEqual(fallbackKeys, [codexKey]);

  console.log('Agent main-page session index tests passed');
}

main();
