const assert = require('assert');
const CLI_AGENTS = require('../cli-agents');
const { getSupportedAgents, getAgentSpec } = require('../cli-agents');

function run() {
  const supported = getSupportedAgents();
  const supportedNames = supported.map((agent) => agent.name);

  assert(supported.length > 0, 'there should be supported coding agents');
  assert(!supportedNames.includes('cursor'), 'cursor should not be exposed as a supported agent');
  assert(!supportedNames.includes('continue'), 'continue should not be exposed as a supported agent');
  assert(supportedNames.includes('claude'), 'claude should remain supported');
  assert(supportedNames.includes('codex'), 'codex should remain supported');
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

  console.log('✓ Supported coding agent list is curated');
}

run();
