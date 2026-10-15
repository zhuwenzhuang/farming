import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { AcpRuntime } = require('../acp-runtime.cjs');
const { AgentManager } = require('../agent-manager.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-auth-onboarding-'));
  const cwd = path.join(root, 'acp-login-required');
  fs.mkdirSync(cwd);
  const runtime = new AcpRuntime({
    resolveLaunch() {
      return { command: process.execPath, args: ['--import', require.resolve('tsx'), path.join(__dirname, 'fixtures/fake-acp-agent.mts')], version: 'test' };
    },
  });
  try {
    for (const provider of ['codex', 'claude']) {
      const agentId = `auth-${provider}`;
      const prepared = await runtime.prepareAgent({ agentId, provider, cwd, approvalMode: 'full', env: process.env, providerHomePath: path.join(root, provider) });
      assert.equal(prepared.historyMode, 'authentication');
      assert.equal(prepared.sessionId, '');
      const session = runtime.getSession(agentId);
      assert.equal(session.state, 'error');
      assert.equal(session.errorKind, 'authentication');
      assert.equal(session.authMethods.length, 2);
      await assert.rejects(runtime.prompt(agentId, 'must not send before login'), /not ready/);
      const child = runtime.bindings.get(agentId).child;
      await runtime.authenticate(agentId, 'fake-login');
      assert.equal(runtime.bindings.get(agentId).child, child, 'authentication resumes the same connection');
      assert.equal(runtime.getSession(agentId).state, 'idle');
      assert.equal(runtime.getSession(agentId).sessionId, 'acp-new-session');
      await runtime.prompt(agentId, 'hello');
      await runtime.unregisterAgentAndWait(agentId);
    }
    const agentId = 'closed-before-login';
    await runtime.prepareAgent({ agentId, provider: 'codex', cwd, env: process.env, providerHomePath: path.join(root, 'closed') });
    let releaseAuthentication!: () => void;
    const gate = new Promise<void>(resolve => { releaseAuthentication = resolve; });
    runtime.bindings.get(agentId).connection.authenticate = () => gate;
    const authentication = runtime.authenticate(agentId, 'fake-login');
    const rejectedAuthentication = assert.rejects(authentication);
    await runtime.unregisterAgentAndWait(agentId);
    releaseAuthentication();
    await rejectedAuthentication;
    await assert.rejects(runtime.authenticate(agentId, 'fake-login'));
    assert.equal(runtime.bindings.has(agentId), false);
    await assert.rejects(runtime.prepareAgent({ agentId: 'identity-only', identityOnly: true, provider: 'codex', cwd, env: process.env, providerHomePath: path.join(root, 'identity') }), /Authentication required/);
    assert.equal(runtime.bindings.has('identity-only'), false);
    const additionalDirectory = path.join(root, 'shared');
    fs.mkdirSync(additionalDirectory);
    const manager = new AgentManager({
      getWorkspace: () => cwd, getHeartbeatInterval: () => 60_000,
      getTaskHistory: () => [], getDangerouslySkipAgentPermissionsByDefault: () => false,
      getAgentLaunchProfiles: () => ({}), getAgentLaunchProfileForHome: () => ({}),
      getAgentHome: () => ({ id: 'default', path: path.join(root, 'manager-home') }),
    }, { acpRuntime: runtime, skipExecutablePreflight: true });
    try {
      const id = await new Promise<string>((resolve, reject) => {
        manager.startAgent('claude', cwd, (id: string, error: string) => {
          if (error) reject(new Error(error)); else resolve(id);
        }, { agentRuntimeMode: 'chat', wantsMain: false, additionalDirectories: [additionalDirectory] });
      });
      const agent = manager.agents.get(id);
      const temporaryKey = agent.providerSessionKey;
      assert.equal(agent.providerSessionTemporary, true);
      await runtime.authenticate(id, 'fake-login');
      assert.equal(agent.providerSessionTemporary, false);
      assert.notEqual(agent.providerSessionKey, temporaryKey);
      assert.deepEqual(manager.acpSessionOptionsStore.get(agent.providerSessionKey).additionalDirectories, [additionalDirectory]);
      assert.equal(manager.acpSessionOptionsStore.has(temporaryKey), false);
    } finally { await manager.dispose(); }
    console.log('First-session authentication retains the Agent, blocks prompts, resumes one connection, and honors close/identity-only cleanup');
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
