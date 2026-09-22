import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { AcpRuntime } = require('../acp-runtime.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-fixture-archive-'));
  const runtime = new AcpRuntime({
    configDir: root,
    resolveLaunch: () => ({
      command: process.execPath,
      args: ['--import', require.resolve('tsx'), path.join(__dirname, 'fixtures/fake-acp-agent.mts')],
      version: 'test',
    }),
  });
  try {
    for (const provider of ['codex', 'claude', 'qwen']) {
      const agentId = `${provider}-archive-fixture`;
      await runtime.prepareAgent({ agentId, provider, cwd: root, providerHomeId: 'test', providerHomePath: root });
      const binding = runtime.bindings.get(agentId);
      const child = binding.child;
      assert.deepEqual(binding.initializeResponse.agentCapabilities._meta.sessionArchive, {
        method: '_session/archive', version: 1,
      });
      assert.equal(await runtime.archiveSession(agentId), true, `${provider}: fake provider must confirm Archive`);
      assert.equal(runtime.getSession(agentId).state, 'closed');
      assert.equal(await runtime.unregisterAgentAndWait(agentId), true);
      assert.equal(runtime.hasBinding(agentId), false);
      assert.ok(child.exitCode !== null || child.signalCode !== null, `${provider}: fixture process must exit`);
    }
    console.log('ACP fixture Archive contract passed for Codex, Claude, and Qwen');
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
