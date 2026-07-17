const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');
const { resolveAgentExecutable } = require('../executable-discovery');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-fork-'));
  const repo = path.join(tmpRoot, 'repo');
  const nonGit = path.join(tmpRoot, 'plain');
  const binDir = path.join(tmpRoot, 'bin');
  const commandLog = path.join(tmpRoot, 'codex-commands.jsonl');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(nonGit, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeFakeExecutable(path.join(binDir, 'codex'), 'codex 9.9.9\n');
  writeFakeExecutable(path.join(binDir, 'claude'), 'claude 9.9.9\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fork fixture\n');
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=Farming Test', '-c', 'user.email=farming@example.test', 'commit', '-m', 'init'], { stdio: 'ignore' });
  const previousPath = process.env.PATH;
  const previousCodexBin = process.env.FARMING_CODEX_BIN;
  const previousCommandLog = process.env.FARMING_TEST_COMMAND_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  process.env.FARMING_CODEX_BIN = path.join(binDir, 'codex');
  process.env.FARMING_TEST_COMMAND_LOG = commandLog;

  const captured = [];
  const manager = new AgentManager({
    getWorkspace() {
      return tmpRoot;
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getCodingAgentEngine() {
      return 'local';
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
  });

  manager.engineBridge.resolve = () => ({
    engineName: 'local',
    engine: {
      async createSession(options) {
        captured.push(options);
      },
    },
    spec: { category: 'coding' },
  });
  manager.engineBridge.getEngine = () => ({
    async killSession() {},
  });

  try {
    const expectedCodexCommand = resolveAgentExecutable('codex') || 'codex';
    const expectedClaudeCommand = resolveAgentExecutable('claude') || 'claude';

    const sourceId = await startAgent(manager, 'codex', repo, { wantsMain: false });
    const sourceAgent = manager.getState().agents.find(agent => agent.id === sourceId);
    assert.strictEqual(sourceAgent.canForkNewWorktree, true);
    assert.strictEqual(sourceAgent.command, 'codex');

    const sameWorktree = await manager.forkAgent(sourceId, 'same-worktree');
    assert.strictEqual(sameWorktree.error, undefined);
    assert.strictEqual(sameWorktree.workspace, repo);
    assert.notStrictEqual(sameWorktree.agentId, sourceId);
    assert.strictEqual(captured.at(-1).command, expectedCodexCommand);
    assert.strictEqual(captured.at(-1).cwd, repo);

    const sameAgent = manager.getState().agents.find(agent => agent.id === sameWorktree.agentId);
    assert(sameAgent, 'same-worktree fork should appear in state');
    assert.strictEqual(sameAgent.parentAgentId, sourceId);
    assert.strictEqual(sameAgent.source, 'ui-fork-same-worktree');
    assert.strictEqual(typeof sameAgent.startedAt, 'number');

    const newWorktree = await manager.forkAgent(sourceId, 'new-worktree');
    assert.strictEqual(newWorktree.error, undefined);
    assert.notStrictEqual(newWorktree.workspace, repo);
    assert(fs.existsSync(newWorktree.workspace), 'new worktree directory should exist');
    assert.strictEqual(captured.at(-1).command, expectedCodexCommand);
    assert.strictEqual(captured.at(-1).cwd, newWorktree.workspace);
    const worktreeList = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    assert(worktreeList.includes(newWorktree.workspace), 'git should know about the created worktree');
    const newWorktreeAgent = await waitFor(() => {
      const current = manager.getState().agents.find(agent => agent.id === newWorktree.agentId);
      return current?.gitWorktree?.workspace === newWorktree.workspace ? current : null;
    });
    assert.strictEqual(newWorktreeAgent.gitWorktree.linked, true);
    assert.strictEqual(newWorktreeAgent.gitWorktree.mainWorkspace, fs.realpathSync(repo));
    assert.strictEqual(manager.getAgentWorkspaceRoot(newWorktree.agentId), newWorktree.workspace);

    const cleanWorktree = await manager.forkAgent(sourceId, 'new-worktree');
    assert.strictEqual(cleanWorktree.error, undefined);
    const cleanDelete = await manager.deleteForkWorktreeProject(cleanWorktree.workspace);
    assert.strictEqual(cleanDelete.error, undefined);
    assert.strictEqual(cleanDelete.deleted, true);
    assert.strictEqual(fs.existsSync(cleanWorktree.workspace), false, 'clean delete should remove the worktree directory');
    assert(!manager.getState().agents.some(agent => agent.id === cleanWorktree.agentId), 'clean delete should archive project agents');

    fs.writeFileSync(path.join(newWorktree.workspace, 'scratch.txt'), 'dirty worktree\n');
    const dirtyDelete = await manager.deleteForkWorktreeProject(newWorktree.workspace);
    assert.strictEqual(dirtyDelete.requiresForce, true);
    assert(dirtyDelete.error, 'dirty worktree delete should require confirmation before archiving');
    assert(fs.existsSync(newWorktree.workspace), 'dirty delete without force should keep the worktree directory');
    assert(manager.getState().agents.some(agent => agent.id === newWorktree.agentId), 'dirty delete without force should not archive agents');

    const forcedDelete = await manager.deleteForkWorktreeProject(newWorktree.workspace, { force: true });
    assert.strictEqual(forcedDelete.error, undefined);
    assert.strictEqual(forcedDelete.deleted, true);
    assert.strictEqual(forcedDelete.forced, true);
    assert.strictEqual(fs.existsSync(newWorktree.workspace), false, 'force delete should remove the dirty worktree directory');
    assert(!manager.getState().agents.some(agent => agent.id === newWorktree.agentId), 'force delete should archive project agents');

    const plainId = await startAgent(manager, 'codex', nonGit, { wantsMain: false });
    const plainAgent = manager.getState().agents.find(agent => agent.id === plainId);
    assert.strictEqual(plainAgent.canForkNewWorktree, false);
    const failed = await manager.forkAgent(plainId, 'new-worktree');
    assert(failed.error, 'new-worktree fork should fail outside a git repo');
    execFileSync('git', ['-C', nonGit, 'init'], { stdio: 'ignore' });
    const refreshedPlainAgent = manager.getState().agents.find(agent => agent.id === plainId);
    assert.strictEqual(refreshedPlainAgent.canForkNewWorktree, true, 'fork capability should refresh when a workspace becomes a Git repository');

    const codexSessionId = '22222222-3333-4444-8555-666666666666';
    const codexHome = path.join(tmpRoot, '.codex-work');
    const codexSessionsDir = path.join(codexHome, 'archived_sessions');
    fs.mkdirSync(codexSessionsDir, { recursive: true });
    fs.writeFileSync(path.join(codexSessionsDir, `rollout-${codexSessionId}.jsonl`), [
      JSON.stringify({
        timestamp: '2026-07-15T07:00:00.000Z',
        type: 'session_meta',
        payload: { id: codexSessionId, cwd: '/repo/project', source: 'cli' },
      }),
      JSON.stringify({
        timestamp: '2026-07-15T07:01:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', cwd: '/repo/project', model: 'gpt-5.6-sol', effort: 'xhigh' },
      }),
      '',
    ].join('\n'));
    const resumedCodexId = await startAgent(manager, `codex resume ${codexSessionId}`, repo, {
      wantsMain: false,
      source: `codex-history:home:work:${codexSessionId}`,
      providerHomeId: 'work',
      providerHomePath: codexHome,
    });
    const resumedCodexMetadata = await manager.findRuntimeSwitchSession(manager.agents.get(resumedCodexId));
    assert.strictEqual(resumedCodexMetadata?.model, 'gpt-5.6-sol');
    assert.strictEqual(resumedCodexMetadata?.effort, 'xhigh');
    assert.strictEqual(resumedCodexMetadata?.archived, true);
    const resumedCodexLaunch = captured.at(-1);
    assert(!resumedCodexLaunch.args.includes('--model'));
    assert(!resumedCodexLaunch.args.some(arg => /^(?:model|model_reasoning_effort|service_tier)=/.test(arg)));
    const resumedCodexFork = await manager.forkAgent(resumedCodexId, 'same-worktree');
    assert.strictEqual(resumedCodexFork.error, undefined);
    assert.strictEqual(captured.at(-1).command, expectedCodexCommand);
    const resumedCodexForkArgs = captured.at(-1).args.slice(-6);
    assert.deepStrictEqual(resumedCodexForkArgs.slice(0, 4), [
      'fork',
      '-c',
      'model_provider="openai"',
      '-C',
    ]);
    assert.strictEqual(fs.realpathSync(resumedCodexForkArgs[4]), fs.realpathSync(repo));
    assert.strictEqual(resumedCodexForkArgs[5], codexSessionId);
    assert(!captured.at(-1).args.includes('--model'));
    assert(!captured.at(-1).args.some(arg => /^(?:model|model_reasoning_effort|service_tier)=/.test(arg)));
    assert.strictEqual(captured.at(-1).env.CODEX_HOME, codexHome);
    assert.strictEqual(manager.getState().agents.find(agent => agent.id === resumedCodexFork.agentId).providerHomeId, 'work');
    const unarchiveCommands = fs.readFileSync(commandLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.deepStrictEqual(unarchiveCommands, [{
      args: ['unarchive', codexSessionId],
      codexHome,
    }]);

    const originalUnarchiveCodexSession = manager.unarchiveCodexSession;
    let releaseConcurrentUnarchive;
    let concurrentUnarchiveCalls = 0;
    manager.unarchiveCodexSession = async () => {
      concurrentUnarchiveCalls += 1;
      await new Promise(resolve => { releaseConcurrentUnarchive = resolve; });
      return { unarchived: true };
    };
    const concurrentForkOne = manager.forkAgent(resumedCodexId, 'same-worktree');
    await waitFor(() => concurrentUnarchiveCalls === 1 && releaseConcurrentUnarchive);
    const concurrentForkTwo = manager.forkAgent(resumedCodexId, 'same-worktree');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(concurrentUnarchiveCalls, 1, 'concurrent forks should share one Codex unarchive transition');
    releaseConcurrentUnarchive();
    const concurrentForkResults = await Promise.all([concurrentForkOne, concurrentForkTwo]);
    assert(concurrentForkResults.every(result => !result.error));

    manager.unarchiveCodexSession = async () => ({ error: 'simulated unarchive failure' });
    const worktreesBeforeFailedFork = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const engineStartsBeforeFailedFork = captured.length;
    const failedArchivedFork = await manager.forkAgent(resumedCodexId, 'new-worktree');
    assert.match(failedArchivedFork.error, /could not be unarchived before forking: simulated unarchive failure/);
    assert.strictEqual(captured.length, engineStartsBeforeFailedFork, 'failed unarchive must not start a fork Agent');
    assert.strictEqual(
      execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }),
      worktreesBeforeFailedFork,
      'failed unarchive must not leave a fork worktree behind'
    );
    manager.unarchiveCodexSession = originalUnarchiveCodexSession;

    const claudeSessionId = '11111111-2222-4333-8444-555555555555';
    const resumedClaudeId = await startAgent(manager, `claude --resume ${claudeSessionId}`, repo, {
      wantsMain: false,
      source: `claude-history:${claudeSessionId}`,
    });
    const resumedFork = await manager.forkAgent(resumedClaudeId, 'same-worktree');
    assert.strictEqual(resumedFork.error, undefined);
    assert.strictEqual(captured.at(-1).command, expectedClaudeCommand);
    assert.strictEqual(captured.at(-1).args[0], '--session-id');
    assert.notStrictEqual(captured.at(-1).args[1], claudeSessionId);
    assert.deepStrictEqual(captured.at(-1).args.slice(2), ['--resume', claudeSessionId, '--fork-session']);

    manager.agentShellEnvProvider = () => ({ PATH: binDir });
    manager.agentShellEnvCache.clear();
    const previousFakeExecutables = process.env.FARMING_E2E_FAKE_EXECUTABLES;
    delete process.env.FARMING_E2E_FAKE_EXECUTABLES;
    const agentCountBeforeMissingResume = manager.getState().agents.length;
    const engineStartsBeforeMissingResume = captured.length;
    const missingQoder = await new Promise(resolve => {
      manager.startAgent(
        'qodercli --resume 51d0e65d-1ba7-47b6-a0ff-99e053d26e37',
        repo,
        (agentId, error) => resolve({ agentId, error }),
        { wantsMain: false, source: 'qoder-history:51d0e65d-1ba7-47b6-a0ff-99e053d26e37' }
      );
    });
    if (previousFakeExecutables === undefined) delete process.env.FARMING_E2E_FAKE_EXECUTABLES;
    else process.env.FARMING_E2E_FAKE_EXECUTABLES = previousFakeExecutables;
    assert.strictEqual(missingQoder.agentId, null);
    assert.match(missingQoder.error, /Qoder executable "qodercli" was not found/);
    assert.strictEqual(manager.getState().agents.length, agentCountBeforeMissingResume);
    assert.strictEqual(captured.length, engineStartsBeforeMissingResume);

    console.log('✓ AgentManager forks agents into same and new worktrees');
  } finally {
    if (previousCodexBin === undefined) {
      delete process.env.FARMING_CODEX_BIN;
    } else {
      process.env.FARMING_CODEX_BIN = previousCodexBin;
    }
    if (previousCommandLog === undefined) {
      delete process.env.FARMING_TEST_COMMAND_LOG;
    } else {
      process.env.FARMING_TEST_COMMAND_LOG = previousCommandLog;
    }
    process.env.PATH = previousPath;
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function writeFakeExecutable(filePath, versionOutput) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(versionOutput)});
}
if (process.argv[2] === 'unarchive' && process.env.FARMING_TEST_COMMAND_LOG) {
  fs.appendFileSync(process.env.FARMING_TEST_COMMAND_LOG, JSON.stringify({
    args: process.argv.slice(2),
    codexHome: process.env.CODEX_HOME || '',
  }) + '\\n');
}
`);
  fs.chmodSync(filePath, 0o755);
}

function startAgent(manager, command, workspace, options) {
  return new Promise((resolve, reject) => {
    manager.startAgent(command, workspace, (agentId, error) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(agentId);
    }, options);
  });
}

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
