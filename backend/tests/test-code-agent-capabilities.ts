const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const { capabilitiesForAgent } = importTsModule('src/components/code/capabilities.ts');

function agent(provider, goalSubmission) {
  return {
    id: `agent-${provider}`,
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: { kind: provider === 'shell' ? 'shell' : 'process', phase: 'idle' },
    providerCapabilities: { goalSubmission },
    isMain: false,
  };
}

function run() {
  for (const provider of ['opencode', 'qoder']) {
    const capabilities = capabilitiesForAgent(agent(provider, {
      terminal: { kind: 'prompt' },
      acp: { kind: 'prompt' },
    })).composer;
    assert.strictEqual(capabilities.goalMode, true, `${provider} should expose Goal mode`);
    assert.strictEqual(capabilities.plusMenu, false, `${provider} should not inherit unrelated provider controls`);
  }

  assert.strictEqual(
    capabilitiesForAgent(agent('shell', null)).composer.goalMode,
    false,
    'plain shells should not expose coding-agent Goal mode'
  );

  console.log('test-code-agent-capabilities passed');
}

run();
