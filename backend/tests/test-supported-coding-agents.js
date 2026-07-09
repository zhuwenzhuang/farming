const assert = require('assert');
const CLI_AGENTS = require('../cli-agents');
const { getSupportedAgents, getAgentSpec, isSupportedHistoryAgent, resolveLaunchCommand } = require('../cli-agents');

function run() {
  const supported = getSupportedAgents();
  const supportedNames = supported.map((agent) => agent.name);

  assert(supported.length > 0, 'there should be supported coding agents');
  assert.deepStrictEqual(
    supportedNames.slice(0, 6),
    ['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh'],
    'primary launch agents should keep the expected product order'
  );
  assert(!supportedNames.includes('cursor'), 'cursor should not be exposed as a supported agent');
  assert(!supportedNames.includes('continue'), 'continue should not be exposed as a supported agent');
  assert(supportedNames.includes('claude'), 'claude should remain supported');
  assert(supportedNames.includes('codex'), 'codex should remain supported');
  assert(supportedNames.includes('qoder'), 'qoder should remain supported');
  assert(supportedNames.includes('bash'), 'bash should be available as a supported shell agent');
  assert(supportedNames.includes('zsh'), 'zsh should be available as a supported shell agent');

  const unsupported = CLI_AGENTS.filter((agent) => !agent.supported);
  assert(
    unsupported.every((agent) => agent.preferredEngine === 'none'),
    'unsupported agents should not claim a runnable engine'
  );

  const spec = getAgentSpec('claude --help');
  assert(spec, 'lookup should resolve the program name from a command string');
  assert.strictEqual(spec.name, 'claude');
  const qoderSpec = getAgentSpec('qodercli --help');
  assert(qoderSpec, 'lookup should resolve Qoder by its executable name');
  assert.strictEqual(qoderSpec.name, 'qoder');
  assert.strictEqual(qoderSpec.command, 'qodercli');
  assert.strictEqual(
    resolveLaunchCommand('qoder').program,
    'qodercli',
    'the UI-facing Qoder provider name should launch the real qodercli executable'
  );
  assert.strictEqual(
    resolveLaunchCommand('qodercli').program,
    'qodercli',
    'direct qodercli commands should keep launching qodercli'
  );
  assert.strictEqual(isSupportedHistoryAgent('codex resume session-1'), true);
  assert.strictEqual(isSupportedHistoryAgent('env TERM=xterm-256color /usr/local/bin/qodercli'), true);
  assert.strictEqual(isSupportedHistoryAgent('/bin/bash'), false);
  assert.strictEqual(isSupportedHistoryAgent('unknown-agent'), false);

  console.log('✓ Supported coding agent list is curated');
}

run();
