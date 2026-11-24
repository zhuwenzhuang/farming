import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from '../acp-runtime.cts';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-model-isolation-'));
  const runtime = new AcpRuntime({ configDir: root });
  const prepare = (agentId: string, sessionId = '', model = '') => runtime.prepareAgent({
    agentId, provider: 'codex', providerHomeId: 'model-isolation', providerHomePath: root,
    cwd: root, projectWorkspace: root, sessionId, model,
    env: { ...process.env, CODEX_HOME: root,
      CODEX_PATH: path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts'),
      FARMING_TEST_MULTI_SESSION: '1', FARMING_TEST_MODEL_MATRIX: '1', FARMING_TEST_INCOMING_INPUTS: '1',
      FARMING_TEST_REQUEST_LOG_FILE: path.join(root, 'requests.jsonl') },
  });
  // Read back from the real adapter, not only Farming's cached snapshot.
  const readModel = async (agentId: string) => {
    const binding = runtime.bindings.get(agentId);
    assert.ok(binding);
    const response = await binding.connection.setSessionConfigOption({
      sessionId: binding.sessionId, configId: 'reasoning_effort', value: 'medium',
    });
    return response.configOptions?.find(option => option.id === 'model')?.currentValue;
  };
  try {
    const first = await prepare('model-first');
    const second = await prepare('model-second');
    const historical = await prepare('model-history', '019f0000-0000-7000-8000-000000000999');
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.sessionId, historical.sessionId);
    assert.equal(runtime.bindings.get('model-first')?.child.pid, runtime.bindings.get('model-second')?.child.pid,
      'the regression must exercise Sessions sharing the same adapter process');
    assert.equal(await readModel('model-first'), 'gpt-5.6');
    await runtime.setSessionConfigOption('model-second', 'model', 'gpt-6-astra');
    assert.equal(await readModel('model-second'), 'gpt-6-astra');
    assert.equal(await readModel('model-first'), 'gpt-5.6');
    assert.equal(await readModel('model-history'), 'gpt-5.6', 'an already-open historical Session is also isolated');
    await prepare('model-new-default', '', 'gpt-6-astra');
    assert.equal(await readModel('model-new-default'), 'gpt-6-astra');
    assert.equal(await readModel('model-first'), 'gpt-5.6');
    await runtime.restartAgentConnection('model-second');
    assert.equal(await readModel('model-second'), 'gpt-6-astra', 'reconnection restores only the selected Session override');
    assert.equal(await readModel('model-first'), 'gpt-5.6');
    assert.equal(await readModel('model-history'), 'gpt-5.6');
    const fork = await runtime.forkSession('model-first');
    await prepare('model-side', fork.sessionId);
    const modelOptions = runtime.requireBinding('model-side').configOptions.find(option => option.id === 'model')?.options;
    assert.ok(modelOptions);
    const metadata = (id: string) => {
      const option = modelOptions.find(option => option.value === id);
      const meta = option && '_meta' in option ? option._meta : undefined;
      return meta && typeof meta === 'object' && 'farming' in meta ? meta.farming : undefined;
    };
    assert.deepEqual(metadata('gpt-5.6'), { modelConfig: { version: 1,
      reasoningOptions: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
    } });
    assert.deepEqual(metadata('gpt-6-astra'), { modelConfig: { version: 1,
      reasoningOptions: [{ value: 'medium', name: 'Medium' }],
    } });
    await runtime.setSessionConfigOptions('model-side', [
      { configId: 'model', value: 'gpt-6-astra' },
      { configId: 'reasoning_effort', value: 'medium' },
    ]);
    assert.equal(await readModel('model-side'), 'gpt-6-astra');
    assert.equal(await readModel('model-first'), 'gpt-5.6');
    await runtime.retainAgent('model-side');
    await runtime.reconnectAgent('model-side');
    await runtime.setSessionConfigOptions('model-side', [
      { configId: 'model', value: 'gpt-5.6' },
      { configId: 'reasoning_effort', value: 'medium' },
    ]);
    assert.equal(await readModel('model-side'), 'gpt-5.6');
    await runtime.setSessionConfigOption('model-side', 'model', 'gpt-6.2-sol');
    // Checkpoints from the two-position picker store Fast as a boolean.
    const side = runtime.requireBinding('model-side');
    await runtime.restoreSessionConfigOverrides(side, [
      { configId: 'model', value: 'gpt-6.2-sol' }, { configId: 'fast-mode', value: true },
    ]);
    assert.equal(side.configOptions.find(option => option.id === 'fast-mode')?.currentValue, 'priority');
    await runtime.setSessionConfigOption('model-side', 'fast-mode', 'ultrafast');
    await runtime.restartAgentConnection('model-side');
    const speed = () => runtime.requireBinding('model-side').configOptions.find(option => option.id === 'fast-mode');
    assert.equal(speed()?.currentValue, 'ultrafast');
    await runtime.submitMessage('model-side', [{ type: 'text', text: 'Check selected speed' }], { delivery: 'prompt' });
    const starts = fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start' && !entry.params.outputSchema);
    assert.equal(starts.at(-1)?.params.serviceTier, 'ultrafast');
    assert.equal(starts.at(-1)?.params.model, 'gpt-6.2-sol');
    await runtime.setSessionConfigOption('model-side', 'model', 'gpt-6-astra');
    assert.equal(speed(), undefined);
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Codex ACP model capabilities and isolation across shared, forked and reconnected Sessions passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
