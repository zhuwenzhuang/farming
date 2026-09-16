import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentManager } from '../agent-manager.cjs';
import { FarmingSessionStore } from '../farming-session-store.cjs';
import { ConfigManager } from '../config-manager.cjs';
import { activeLifecycleOperation, beginLifecycleOperation, lifecycleJournal } from '../agent-lifecycle-journal.cjs';
import { encodeProviderSessionKey } from '../../shared/provider-session-identity.js';
import { createTestAgentManager, createTestAcpRuntime } from './helpers/test-acp-runtime';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-resume-recovery-'));
  const home = path.join(root, 'home');
  const sessionId = '019f0000-0000-7000-8000-000000000071';
  const key = encodeProviderSessionKey('codex', sessionId, 'work');
  const sessions = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-06-27T10-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/example/project' } }));
  try {
    for (const runtime of ['terminal', 'acp'] as const) {
      for (const detached of [false, true]) {
        const store = new FarmingSessionStore(path.join(root, `${runtime}-${detached}`));
        const config = new ConfigManager({ configDir: store.configDir });
        config.sessionStore = store;
        config.init();
        let failWrite = false;
        config.ensureAgentSessionRecord = (agent, patch) => {
          if (failWrite) throw new Error('disk unavailable');
          return store.ensureRecordForAgent(agent, patch);
        };
        const manager = createTestAgentManager(AgentManager, config, {
          acpRuntime: createTestAcpRuntime({ unregisterAgentAndWait: async () => true }),
          archiveCodexSession: async () => ({ error: 'Provider archive failed' }),
        });
        manager.engineBridge.getEngine = () => Object.assign(new EventEmitter(), {
          killSession: async () => {}, getSessionState: async () => null,
          createSession: async () => { throw new Error('unexpected runtime creation'); },
          getSessionPreview: async () => '', sendInput: async () => { throw new Error('unexpected input'); },
          dispose: () => {},
        });
        try {
          const agent = manager.recoveredAgentRecord('old-runtime', 'local', {
            provider: 'codex', providerHomeId: 'work', providerHomePath: home,
            providerSessionId: sessionId, providerSessionKey: key, command: 'codex',
            agentRuntimeMode: runtime === 'acp' ? 'acp' : 'terminal', cwd: '/example/project',
            customTitle: 'Keep this title', pinned: true,
          }, { status: 'running' });
          manager.agents.set(agent.id, agent);
          manager.sessionPersistence.persist(agent);
          const archived = await manager.archiveAgent(agent.id, { recordHistory: false });
          assert.equal(archived.providerArchived, false);
          const blocked = store.getRecordForProviderSessionKey(key)!;
          assert.equal(activeLifecycleOperation(blocked)?.state, 'blocked');
          assert.equal(blocked.runtimeAgentId, '');
          assert.equal(blocked.structuredRuntimeProcess, null);
          if (detached) manager.forgetStoppedAgentRecord(agent.id);

          const resume = (homeId = 'work') => manager.runProviderSessionResumeAdmission('codex', sessionId, homeId,
            async ensure => ensure({ providerHomeId: homeId, providerHomePath: home,
              providerHomes: { codex: [{ id: homeId, path: home }] } }));
          await resume('other');
          assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked', 'another Home cannot cancel this archive');

          for (const patch of [
            { archived: false },
            { runtimeAgentId: 'still-owned' },
            { structuredRuntimeProcess: { kind: 'acp-process-group', pid: 123, processGroupId: 123, startedAt: 'unverified' } },
          ]) {
            store.ensureRecordForAgent(agent, { ...blocked, ...patch });
            await assert.rejects(resume(), /has not safely stopped/);
            assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked');
            store.ensureRecordForAgent(agent, blocked);
          }

          const archivedDir = path.join(home, 'archived_sessions');
          fs.mkdirSync(archivedDir, { recursive: true });
          const archivedRollout = path.join(archivedDir, path.basename(rollout));
          fs.renameSync(rollout, archivedRollout);
          manager.unarchiveCodexSession = async () => ({ error: 'Unarchive unavailable' });
          assert.equal((await resume())?.error, 'Unarchive unavailable');
          assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked');
          manager.unarchiveCodexSession = async () => null;
          assert.match((await resume())?.error || '', /could not be verified after unarchiving/);
          assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked', 'a reported success without available history cannot cancel the archive');
          fs.renameSync(archivedRollout, rollout);

          failWrite = true;
          await assert.rejects(resume(), /disk unavailable/);
          assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked', 'failed persistence must preserve the recovery fence');
          failWrite = false;
          if (!detached) {
            manager.runtimeStopTracker.forget(agent.id);
            await assert.rejects(resume(), /runtime is still being stopped/);
            assert.equal(activeLifecycleOperation(store.getRecordForProviderSessionKey(key))?.state, 'blocked');
            manager.runtimeStopTracker.markVerifiedStopped(agent.id);
          }

          const available = await resume();
          assert.equal(available?.error, undefined);
          const restored = store.getRecordForProviderSessionKey(key)!;
          assert.equal(activeLifecycleOperation(restored), null);
          assert.equal(lifecycleJournal(restored).entries.at(-1)?.state, 'cancelled');
          assert.equal(manager.recoveredAgentRecord('restored', 'local', config.getAgentSessionRecordForProviderSessionKey(key)!, { status: 'exited' }).requiresProcessExitAcknowledgement, false);
          assert.equal(restored.customTitle, 'Keep this title');
          assert.equal(restored.pinned, true);
          assert.equal(manager.agents.has(agent.id), false);
          assert.equal(beginLifecycleOperation(structuredClone(restored), 'create', 'explicit-resume').conflict, undefined);
          assert.equal(fs.existsSync(rollout), true);
          await resume();
          assert.equal(lifecycleJournal(store.getRecordForProviderSessionKey(key)).sequence, lifecycleJournal(restored).sequence, 'repeated admission must not rewrite completed cancellation');
        } finally {
          manager.heartbeatScheduler.stop();
          manager.engineBridge.dispose();
          await manager.acpRuntime.dispose();
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Agent history resume recovery tests passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
