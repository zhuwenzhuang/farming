const assert = require('assert');
const CLI_AGENTS = require('../cli-agents');
const { parseCommand, resolveLaunchCommand } = CLI_AGENTS;

function run() {
  const claudeDefault = resolveLaunchCommand('claude', { dangerouslySkipPermissions: false });
  assert.deepStrictEqual(claudeDefault.args, []);
  assert.strictEqual(claudeDefault.permissionMode, '');

  const claudeSkip = resolveLaunchCommand('claude', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(claudeSkip.args, ['--dangerously-skip-permissions']);
  assert.strictEqual(claudeSkip.permissionMode, 'bypassPermissions');

  const claudeExplicitPermission = resolveLaunchCommand('claude --resume claude-session-123', {
    claudePermissionMode: 'dontAsk',
    dangerouslySkipPermissions: true,
  });
  assert.deepStrictEqual(claudeExplicitPermission.args, ['--permission-mode', 'dontAsk', '--resume', 'claude-session-123']);
  assert.strictEqual(claudeExplicitPermission.permissionMode, 'dontAsk');

  ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'].forEach((permissionMode) => {
    const launch = resolveLaunchCommand('claude --resume claude-session-123', { claudePermissionMode: permissionMode });
    assert.deepStrictEqual(launch.args, ['--permission-mode', permissionMode, '--resume', 'claude-session-123']);
    assert.strictEqual(launch.permissionMode, permissionMode);
  });
  const claudeExplicitDefault = resolveLaunchCommand('claude --resume claude-session-123', { claudePermissionMode: 'default' });
  assert.deepStrictEqual(claudeExplicitDefault.args, ['--resume', 'claude-session-123']);
  assert.strictEqual(claudeExplicitDefault.permissionMode, '');

  const codexSkip = resolveLaunchCommand('codex', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(codexSkip.args, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.strictEqual(codexSkip.permissionMode, 'full');

  const codexAsk = resolveLaunchCommand('codex', { codexApprovalMode: 'ask', dangerouslySkipPermissions: true });
  assert.deepStrictEqual(codexAsk.args, ['--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write']);
  assert.strictEqual(codexAsk.permissionMode, 'ask');

  const codexApprove = resolveLaunchCommand('codex --search', { codexApprovalMode: 'approve' });
  assert.deepStrictEqual(codexApprove.args, ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write', '--search']);
  assert.strictEqual(codexApprove.permissionMode, 'approve');

  const codexModel = resolveLaunchCommand('codex', { codexModelPreset: 'gpt-5.5-pro:high' });
  assert.deepStrictEqual(codexModel.args, ['-c', 'model_reasoning_effort="high"', '--model', 'gpt-5.5-pro']);

  const codexSplitModel = resolveLaunchCommand('codex', {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'xhigh',
    codexServiceTier: 'priority',
  });
  assert.deepStrictEqual(codexSplitModel.args, [
    '-c',
    'service_tier="priority"',
    '-c',
    'model_reasoning_effort="xhigh"',
    '--model',
    'gpt-5.5',
  ]);

  const codexManualModel = resolveLaunchCommand('codex --model gpt-5.5', { codexModelPreset: 'gpt-5.5-pro:xhigh' });
  assert.deepStrictEqual(codexManualModel.args, ['--model', 'gpt-5.5']);

  const codexFull = resolveLaunchCommand('codex', { codexApprovalMode: 'full' });
  assert.deepStrictEqual(codexFull.args, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.strictEqual(codexFull.permissionMode, 'full');

  const codexManualApproval = resolveLaunchCommand('codex --ask-for-approval never', { codexApprovalMode: 'ask' });
  assert.deepStrictEqual(codexManualApproval.args, ['--ask-for-approval', 'never']);
  assert.strictEqual(codexManualApproval.permissionMode, 'custom');

  assert.deepStrictEqual(
    parseCommand("codex resume -C '/repo/with space' 019f0000-0000-7000-8000-000000000101"),
    ['codex', 'resume', '-C', '/repo/with space', '019f0000-0000-7000-8000-000000000101']
  );
  const codexResume = resolveLaunchCommand("codex resume -C '/repo/with space' 019f0000-0000-7000-8000-000000000101", {
    codexApprovalMode: 'approve',
  });
  assert.deepStrictEqual(codexResume.args, [
    '--ask-for-approval',
    'on-request',
    '--sandbox',
    'workspace-write',
    'resume',
    '-C',
    '/repo/with space',
    '019f0000-0000-7000-8000-000000000101',
  ]);
  assert.strictEqual(codexResume.permissionMode, 'approve');

  const codexFullResume = resolveLaunchCommand("codex resume -C '/repo/with space' 019f0000-0000-7000-8000-000000000101", {
    codexApprovalMode: 'full',
  });
  assert.deepStrictEqual(codexFullResume.args, [
    '--dangerously-bypass-approvals-and-sandbox',
    'resume',
    '-C',
    '/repo/with space',
    '019f0000-0000-7000-8000-000000000101',
  ]);
  assert.strictEqual(codexFullResume.permissionMode, 'full');

  const codexCustom = resolveLaunchCommand('codex', { codexApprovalMode: 'custom', dangerouslySkipPermissions: false });
  assert.deepStrictEqual(codexCustom.args, []);
  assert.strictEqual(codexCustom.permissionMode, 'custom');

  const codexCustomResume = resolveLaunchCommand('codex resume codex-session-123', { codexApprovalMode: 'custom' });
  assert.deepStrictEqual(codexCustomResume.args, ['resume', 'codex-session-123']);
  assert.strictEqual(codexCustomResume.permissionMode, 'custom');

  const codexUnifiedProfile = resolveLaunchCommand('codex --search', {
    agentLaunchProfiles: {
      codex: {
        approvalMode: 'ask',
        model: 'gpt-5.5-pro',
        reasoningEffort: 'high',
        serviceTier: 'priority',
      },
    },
  });
  assert.deepStrictEqual(codexUnifiedProfile.args, [
    '--ask-for-approval',
    'untrusted',
    '--sandbox',
    'workspace-write',
    '-c',
    'service_tier="priority"',
    '-c',
    'model_reasoning_effort="high"',
    '--model',
    'gpt-5.5-pro',
    '--search',
  ]);

  const claudeUnifiedProfile = resolveLaunchCommand('claude', {
    agentLaunchProfiles: {
      claude: { permissionMode: 'auto', model: 'sonnet', effort: 'high' },
    },
  });
  assert.deepStrictEqual(claudeUnifiedProfile.args, [
    '--permission-mode',
    'auto',
    '--effort',
    'high',
    '--model',
    'sonnet',
  ]);

  const claudeBracketModelProfile = resolveLaunchCommand('claude', {
    agentLaunchProfiles: {
      claude: { permissionMode: 'default', model: 'claude-opus-4-8[1m]', effort: 'high' },
    },
  });
  assert.deepStrictEqual(claudeBracketModelProfile.args, [
    '--effort',
    'high',
    '--model',
    'claude-opus-4-8[1m]',
  ]);

  const claudeBypassProfile = resolveLaunchCommand('claude', {
    dangerouslySkipPermissions: true,
    agentLaunchProfiles: {
      claude: { permissionMode: 'bypassPermissions', model: 'config', effort: 'config' },
    },
  });
  assert.deepStrictEqual(claudeBypassProfile.args, ['--dangerously-skip-permissions']);
  assert.strictEqual(claudeBypassProfile.permissionMode, 'bypassPermissions');

  const claudeManualProfileArgs = resolveLaunchCommand('claude --permission-mode default --model opus --effort low', {
    agentLaunchProfiles: {
      claude: { permissionMode: 'auto', model: 'sonnet', effort: 'high' },
    },
  });
  assert.deepStrictEqual(claudeManualProfileArgs.args, ['--permission-mode', 'default', '--model', 'opus', '--effort', 'low']);

  const codexDangerousOverridesProfile = resolveLaunchCommand('codex', {
    dangerouslySkipPermissions: true,
    agentLaunchProfiles: { codex: { approvalMode: 'approve' } },
  });
  assert.deepStrictEqual(codexDangerousOverridesProfile.args, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.strictEqual(codexDangerousOverridesProfile.permissionMode, 'full');

  const qwenSkip = resolveLaunchCommand('qwen', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(qwenSkip.args, ['--yolo']);

  const aiderSkip = resolveLaunchCommand('aider', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(aiderSkip.args, ['--yes-always']);
  assert.strictEqual(aiderSkip.permissionMode, 'full');

  const copilotSkip = resolveLaunchCommand('github-copilot-cli', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(copilotSkip.args, ['--allow-all-tools']);
  assert.strictEqual(copilotSkip.permissionMode, 'full');

  const amazonQSkip = resolveLaunchCommand('amazon-q', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(amazonQSkip.args, ['--trust-all-tools']);
  assert.strictEqual(amazonQSkip.permissionMode, 'full');

  CLI_AGENTS
    .filter(spec => spec.supported !== false && spec.interactive !== false && spec.category === 'coding')
    .forEach(spec => {
      assert(
        spec.permissions?.supportsDangerousSkip === true && Array.isArray(spec.permissions.dangerousSkipArgs) && spec.permissions.dangerousSkipArgs.length > 0,
        `${spec.name} should declare provider-specific dangerous skip args`
      );
      const launch = resolveLaunchCommand(spec.name, { dangerouslySkipPermissions: true });
      spec.permissions.dangerousSkipArgs.forEach(arg => assert(launch.args.includes(arg), `${spec.name} should launch with ${arg}`));
    });

  const shellSkip = resolveLaunchCommand('bash', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(shellSkip.args, process.platform === 'darwin' ? ['-l'] : []);
  const zshShell = resolveLaunchCommand('zsh');
  assert.deepStrictEqual(zshShell.args, process.platform === 'darwin' ? ['-l'] : []);

  const customArgs = resolveLaunchCommand('claude --debug', { dangerouslySkipPermissions: true });
  assert.deepStrictEqual(customArgs.args, ['--dangerously-skip-permissions', '--debug']);

  const claudeMain = resolveLaunchCommand('claude', {
    dangerouslySkipPermissions: true,
    mainAgentSystemPrompt: 'You are the Farming Main Agent.',
  });
  assert.deepStrictEqual(claudeMain.args, [
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    'You are the Farming Main Agent.',
  ]);

  const qwenMain = resolveLaunchCommand('qwen', {
    dangerouslySkipPermissions: true,
    mainAgentSystemPrompt: 'You are the Farming Main Agent.',
  });
  assert.deepStrictEqual(qwenMain.args, ['--yolo']);

  console.log('✓ Agent launch profiles resolve per-agent dangerous skip flags correctly');
}

run();
