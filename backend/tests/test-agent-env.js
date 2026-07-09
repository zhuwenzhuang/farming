const assert = require('assert');
const path = require('path');
const AgentManager = require('../agent-manager');
const {
  SHELL_ENV_BEGIN,
  SHELL_ENV_END,
  buildInteractiveAgentBaseEnv,
  isCatPager,
  normalizeInteractiveTerminalEnv,
  parseShellEnvOutput,
  scrubNonInteractivePagerEnv,
  shellEnvArgs,
} = require('../agent-env');
const { normalizeShellSessionOptions } = require('../local-session-engine');

async function run() {
  assert.strictEqual(isCatPager('cat'), true);
  assert.strictEqual(isCatPager('/bin/cat'), true);
  assert.strictEqual(isCatPager('cat -n'), true);
  assert.strictEqual(isCatPager('less'), false);
  assert.strictEqual(isCatPager('bat --paging=always'), false);

  const scrubbed = scrubNonInteractivePagerEnv({
    PAGER: 'cat',
    GIT_PAGER: '/bin/cat',
    LESS: '-R',
  });
  assert.strictEqual(scrubbed.PAGER, undefined);
  assert.strictEqual(scrubbed.GIT_PAGER, undefined);
  assert.strictEqual(scrubbed.LESS, '-R');

  const preserved = scrubNonInteractivePagerEnv({
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    FARMING_PRESERVE_AGENT_CAT_PAGER: '1',
  });
  assert.strictEqual(preserved.PAGER, 'cat');
  assert.strictEqual(preserved.GIT_PAGER, 'cat');

  const parsedShellEnv = parseShellEnvOutput([
    'startup noise',
    SHELL_ENV_BEGIN,
    '{"PATH":"/shell/bin","PAGER":"less","OPENAI_API_KEY":"from-shell"}',
    SHELL_ENV_END,
    'after noise',
  ].join('\n'));
  assert.deepStrictEqual(parsedShellEnv, {
    PATH: '/shell/bin',
    PAGER: 'less',
    OPENAI_API_KEY: 'from-shell',
  });

  assert.deepStrictEqual(
    shellEnvArgs('/bin/bash', 'echo ok'),
    ['-lic', 'echo ok'],
    'bash env resolution should use a login interactive shell'
  );
  assert.deepStrictEqual(
    shellEnvArgs('/bin/sh', 'echo ok'),
    ['-lc', 'echo ok'],
    'plain sh env resolution should use login shell command mode'
  );

  const baseEnv = buildInteractiveAgentBaseEnv({
    processEnv: {
      PATH: '/process/bin',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      OPENAI_API_KEY: 'from-process',
      HTTP_PROXY: 'http://proxy.local',
      FARMING_BASE_PATH: '/farming',
      CODEX_THREAD_ID: 'should-not-leak',
      CLAUDE_INTERNAL_STATE: 'should-not-leak',
      CLAUDE_CONFIG_DIR: '/process/claude',
    },
    shellEnv: {
      PATH: '/shell/bin',
      PAGER: 'less',
    },
  });
  assert.strictEqual(baseEnv.PATH, '/shell/bin', 'agent env should prefer the user shell PATH');
  assert.strictEqual(baseEnv.PAGER, 'less', 'agent env should keep an explicit user shell pager');
  assert.strictEqual(baseEnv.GIT_PAGER, undefined, 'raw process git pager should not be copied into shell env');
  assert.strictEqual(baseEnv.OPENAI_API_KEY, 'from-process', 'agent env should preserve coding-agent credentials');
  assert.strictEqual(baseEnv.HTTP_PROXY, 'http://proxy.local', 'agent env should preserve proxy settings');
  assert.strictEqual(baseEnv.FARMING_BASE_PATH, undefined, 'server-only Farming env should not leak into agents');
  assert.strictEqual(baseEnv.CODEX_THREAD_ID, undefined, 'Codex harness metadata should not leak into agents');
  assert.strictEqual(baseEnv.CLAUDE_INTERNAL_STATE, undefined, 'unknown Claude harness metadata should not leak into agents');
  assert.strictEqual(baseEnv.CLAUDE_CONFIG_DIR, '/process/claude', 'explicit Claude config path should be preserved');

  const normalizedEnv = normalizeInteractiveTerminalEnv({
    TERM: 'dumb',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    LD_LIBRARY_PATH: '/server/runtime-libraries',
    NODE_OPTIONS: '--max-old-space-size=99999',
    TERM_PROGRAM_VERSION: 'not-farming',
  });
  assert.strictEqual(normalizedEnv.TERM, 'xterm-256color');
  assert.strictEqual(normalizedEnv.NO_COLOR, undefined);
  assert.strictEqual(normalizedEnv.PAGER, undefined);
  assert.strictEqual(normalizedEnv.GIT_PAGER, undefined);
  assert.strictEqual(normalizedEnv.LD_LIBRARY_PATH, undefined);
  assert.strictEqual(normalizedEnv.NODE_OPTIONS, undefined);
  assert.strictEqual(normalizedEnv.TERM_PROGRAM, 'farming');
  assert.strictEqual(normalizedEnv.TERM_PROGRAM_VERSION, process.env.npm_package_version || '');

  const shellOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: [],
    category: 'other',
    env: {
      PAGER: 'cat',
      GIT_PAGER: 'cat',
    },
  });
  assert.strictEqual(shellOptions.env.PAGER, undefined);
  assert.strictEqual(shellOptions.env.GIT_PAGER, undefined);

  const resolvedShells = [];
  const manager = new AgentManager({
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  }, {
    agentShellEnvProvider(shell) {
      resolvedShells.push(shell || 'default');
      return String(shell).endsWith('zsh')
        ? { PATH: '/zsh/bin', PROMPT: 'zsh prompt', RPROMPT: 'zsh right prompt' }
        : { PATH: '/bash/bin', PS1: 'bash prompt', PROMPT_COMMAND: 'bash hook' };
    },
  });
  const previousPager = process.env.PAGER;
  const previousGitPager = process.env.GIT_PAGER;
  const previousControlledPrompt = process.env.FARMING_SHELL_CONTROLLED_PROMPT;
  const previousAnonymousPrompt = process.env.FARMING_ANONYMIZE_SHELL_PROMPT;
  process.env.PAGER = 'cat';
  process.env.GIT_PAGER = 'cat';
  process.env.FARMING_SHELL_CONTROLLED_PROMPT = '1';
  process.env.FARMING_ANONYMIZE_SHELL_PROMPT = '1';
  try {
    const env = manager.buildAgentEnv('agent-env', { wantsMain: false, category: 'other', command: 'bash' });
    assert.strictEqual(env.PATH.startsWith(`${manager.cliBinDir}${path.delimiter}`), true);
    assert.strictEqual(env.PAGER, undefined);
    assert.strictEqual(env.GIT_PAGER, undefined);
    assert.strictEqual(env.FARMING_SHELL_CONTROLLED_PROMPT, '1', 'shell sessions should retain their explicit prompt policy');
    assert.strictEqual(env.FARMING_ANONYMIZE_SHELL_PROMPT, '1');
    assert.strictEqual(env.PS1, undefined, 'bash must source its own prompt instead of inheriting another shell prompt');
    assert.strictEqual(env.PROMPT_COMMAND, undefined, 'bash must source its own prompt hook instead of inheriting one');

    const zshEnv = manager.buildAgentEnv('agent-zsh', { wantsMain: false, category: 'other', command: 'zsh' });
    assert.strictEqual(zshEnv.PATH.startsWith(`${manager.cliBinDir}${path.delimiter}/zsh/bin`), true);
    assert.strictEqual(zshEnv.PROMPT, undefined, 'zsh must source its own prompt instead of inheriting another shell prompt');
    assert.strictEqual(zshEnv.RPROMPT, undefined, 'zsh must source its own right prompt instead of inheriting one');
    assert(resolvedShells.some(shell => String(shell).endsWith('bash')) && resolvedShells.some(shell => String(shell).endsWith('zsh')), 'shell environment capture should be keyed by the target shell');

    const codingEnv = manager.buildAgentEnv('agent-coding', { wantsMain: false, category: 'coding' });
    assert.strictEqual(codingEnv.FARMING_SHELL_CONTROLLED_PROMPT, undefined, 'coding CLIs should not inherit shell prompt policy');
    assert.strictEqual(codingEnv.FARMING_ANONYMIZE_SHELL_PROMPT, undefined, 'coding CLIs should not inherit shell anonymization policy');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.engineBridge.dispose();
    if (previousPager === undefined) delete process.env.PAGER;
    else process.env.PAGER = previousPager;
    if (previousGitPager === undefined) delete process.env.GIT_PAGER;
    else process.env.GIT_PAGER = previousGitPager;
    if (previousControlledPrompt === undefined) delete process.env.FARMING_SHELL_CONTROLLED_PROMPT;
    else process.env.FARMING_SHELL_CONTROLLED_PROMPT = previousControlledPrompt;
    if (previousAnonymousPrompt === undefined) delete process.env.FARMING_ANONYMIZE_SHELL_PROMPT;
    else process.env.FARMING_ANONYMIZE_SHELL_PROMPT = previousAnonymousPrompt;
  }

  console.log('✓ Agent env removes non-interactive cat pagers');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
