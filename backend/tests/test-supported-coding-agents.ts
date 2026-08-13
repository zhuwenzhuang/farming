const assert = require('assert');
const {
  CLI_AGENTS,
  getSupportedAgents,
  getAgentSpec,
  isSupportedHistoryAgent,
  resolveLaunchCommand,
} = require('../cli-agents.cjs');

function run() {
  const supported = getSupportedAgents();
  const supportedNames = supported.map((agent) => agent.name);

  assert.deepStrictEqual(CLI_AGENTS.slice(0, 6), [
    {
      name: 'codex',
      description: 'Codex CLI - OpenAI coding assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      permissions: {
        supportsDangerousSkip: true,
        dangerousSkipArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      },
    },
    {
      name: 'claude',
      description: 'Claude CLI - Anthropic assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      permissions: {
        supportsDangerousSkip: true,
        dangerousSkipArgs: ['--dangerously-skip-permissions'],
      },
      systemPromptArg: '--append-system-prompt',
    },
    {
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'OpenCode - AI coding assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      permissions: {
        supportsDangerousSkip: true,
        dangerousSkipArgs: ['--auto'],
      },
    },
    {
      name: 'qoder',
      command: 'qodercli',
      description: 'Qoder - AI coding assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      permissions: {
        supportsDangerousSkip: true,
        dangerousSkipArgs: ['--dangerously-skip-permissions'],
      },
      systemPromptArg: '--append-system-prompt',
    },
    {
      name: 'qwen',
      description: 'Qwen Code coding assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      permissions: {
        supportsDangerousSkip: true,
        dangerousSkipArgs: ['--yolo'],
      },
      systemPromptArg: '--append-system-prompt',
    },
    {
      name: 'pi',
      description: 'Pi - AI coding assistant',
      category: 'coding',
      interactive: true,
      supported: true,
      preferredEngine: 'native',
      systemPromptArg: '--append-system-prompt',
    },
  ], 'Provider CLI specs must preserve their complete public shape and order');

  assert(supported.length > 0, 'there should be supported coding agents');
  assert.deepStrictEqual(
    supportedNames.slice(0, 8),
    ['codex', 'claude', 'opencode', 'qoder', 'qwen', 'pi', 'bash', 'zsh'],
    'primary launch agents should keep the expected product order'
  );
  assert(!supportedNames.includes('cursor'), 'cursor should not be exposed as a supported agent');
  assert(!supportedNames.includes('continue'), 'continue should not be exposed as a supported agent');
  assert(supportedNames.includes('claude'), 'claude should remain supported');
  assert(supportedNames.includes('codex'), 'codex should remain supported');
  assert(supportedNames.includes('qoder'), 'qoder should remain supported');
  assert(supportedNames.includes('qwen'), 'qwen should be available as a supported coding agent');
  assert(supportedNames.includes('pi'), 'Pi should be available as a supported coding agent');
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
  const qwenSpec = getAgentSpec('qwen --help');
  assert(qwenSpec, 'lookup should resolve Qwen Code by its executable name');
  assert.strictEqual(qwenSpec.name, 'qwen');
  assert.strictEqual(qwenSpec.systemPromptArg, '--append-system-prompt');
  const piSpec = getAgentSpec('pi --help');
  assert(piSpec, 'lookup should resolve Pi by its executable name');
  assert.strictEqual(piSpec.name, 'pi');
  assert.strictEqual(piSpec.systemPromptArg, '--append-system-prompt');
  assert.strictEqual(isSupportedHistoryAgent('codex resume session-1'), true);
  assert.strictEqual(isSupportedHistoryAgent('env TERM=xterm-256color /usr/local/bin/qodercli'), true);
  assert.strictEqual(isSupportedHistoryAgent('env PI_CODING_AGENT_DIR=/tmp/pi /usr/local/bin/pi'), true);
  assert.strictEqual(isSupportedHistoryAgent('/bin/bash'), false);
  assert.strictEqual(isSupportedHistoryAgent('unknown-agent'), false);

  console.log('✓ Supported coding agent list is curated');
}

run();
