import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AcpRuntime } from '../acp-runtime.cjs';
import { getSupportedAgents, resolveLaunchCommand } from '../cli-agents.cjs';
import { listProviderAdapters } from '../provider-adapters.cjs';

const expectedModes: Record<string, string> = {
  codex: 'agent-full-access', claude: 'bypassPermissions', qoder: 'bypassPermissions',
  qwen: 'yolo', agy: 'bypassPermissions', opencode: '', pi: '',
};
const fixture = path.join(__dirname, 'fixtures/permission-acp-agent.mts');

for (const adapter of listProviderAdapters()) {
  test(`${adapter.id}: bypass reaches the provider, first tool, peer Session and recovery`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-permissions-'));
    const runtime = new AcpRuntime({ resolveLaunch: () => ({ command: process.execPath,
      args: ['--import', require.resolve('tsx'), fixture, adapter.id], version: 'test' }) });
    const launch = resolveLaunchCommand(adapter.id, { dangerouslySkipPermissions: true });
    const prepare = (agentId: string, extra = {}) => runtime.prepareAgent({ agentId, provider: adapter.id,
      cwd: root, providerHomePath: root, env: process.env, approvalMode: launch.permissionMode || 'approve', ...extra });
    try {
      const first = await prepare('first');
      const snapshot = runtime.getSession('first');
      assert.equal(snapshot.currentModeId, expectedModes[adapter.id]);
      if (expectedModes[adapter.id]) {
        assert.equal(runtime.bindings.get('first')!.configOptions.find(option => option.category === 'mode')?.currentValue, expectedModes[adapter.id]);
      }
      await runtime.prompt('first', [{ type: 'text', text: 'Write permission proof' }]);
      assert.equal(fs.readFileSync(path.join(root, `${first.sessionId}.proof`), 'utf8'), adapter.id);

      const peer = await prepare('peer', { approvalMode: 'approve' });
      assert.notEqual(peer.sessionId, first.sessionId);
      if (expectedModes[adapter.id]) {
        assert.notEqual(runtime.getSession('peer').currentModeId, expectedModes[adapter.id]);
        assert.equal(runtime.getSession('first').currentModeId, expectedModes[adapter.id]);
        const restricted = String(runtime.getSession('peer').currentModeId);
        await runtime.setSessionMode('first', restricted);
        assert.equal(bindingMode('first'), restricted);
        const controller = new AbortController();
        const binding = runtime.bindings.get('first')!;
        const response = runtime.requestPermission(binding, { sessionId: first.sessionId,
          options: [{ optionId: 'allow', kind: 'allow_once' }] }, controller.signal);
        assert.equal(binding.pendingPermissions.size, 1, 'a later restricted mode must stop automatic approval');
        controller.abort();
        await response;
        await runtime.setSessionConfigOption('first', 'permission', expectedModes[adapter.id]);
      }
      await runtime.unregisterAgentAndWait('peer');
      await runtime.unregisterAgentAndWait('first');
      await prepare('recovered', { sessionId: first.sessionId, historyMode: 'load', configOverrides: first.configOverrides });
      assert.equal(runtime.getSession('recovered').currentModeId, expectedModes[adapter.id]);
      await runtime.prompt('recovered', [{ type: 'text', text: 'Write after restart' }]);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
    function bindingMode(agentId: string) {
      return runtime.bindings.get(agentId)!.configOptions.find(option => option.category === 'mode')?.currentValue;
    }
  });
}

for (const scenario of ['legacy', 'selected', 'missing', 'reject', 'unconfirmed']) {
  test(`Qoder permission negotiation: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-permission-failure-'));
    const runtime = new AcpRuntime({ resolveLaunch: () => ({ command: process.execPath,
      args: ['--import', require.resolve('tsx'), fixture, 'qoder', `--${scenario}`], version: 'test' }) });
    try {
      const opening = runtime.prepareAgent({ agentId: 'test', provider: 'qoder', cwd: root, approvalMode: 'full', env: process.env });
      if (scenario === 'legacy' || scenario === 'selected') {
        await opening;
        assert.equal(runtime.getSession('test').currentModeId, 'bypassPermissions');
        await runtime.prompt('test', [{ type: 'text', text: 'Write via legacy modes' }]);
      } else {
        await assert.rejects(opening, /did not advertise permission mode|Permission mode rejected|did not confirm config option/);
        const requestFile = path.join(root, 'mode-requests.jsonl');
        const calls = fs.existsSync(requestFile) ? fs.readFileSync(requestFile, 'utf8').trim().split('\n').length : 0;
        assert.equal(calls, scenario === 'missing' ? 0 : 1, 'permission mutation must not be silently replayed');
      }
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('every ACP provider has an explicit Terminal bypass launch contract', () => {
  const flags: Record<string, string[]> = {
    codex: ['--dangerously-bypass-approvals-and-sandbox'], claude: ['--dangerously-skip-permissions'],
    qoder: ['--dangerously-skip-permissions'], qwen: ['--yolo'], opencode: ['--auto'],
    agy: ['--dangerously-skip-permissions'], pi: [],
  };
  const providers = listProviderAdapters().map(adapter => adapter.id as string);
  const agents = getSupportedAgents().filter(agent => providers.includes(agent.name));
  assert.deepEqual(agents.map(agent => agent.name).sort(), Object.keys(flags).sort());
  for (const agent of agents) {
    const launch = resolveLaunchCommand(agent.name, { dangerouslySkipPermissions: true });
    for (const flag of flags[agent.name]) assert.ok(launch.args.includes(flag), `${agent.name}: ${flag}`);
    const restricted = resolveLaunchCommand(agent.name, { dangerouslySkipPermissions: false });
    for (const flag of flags[agent.name]) assert.ok(!restricted.args.includes(flag));
  }
});
