const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');

async function run() {
  const farmingWorkspace = path.join(os.tmpdir(), 'farming-main-workspace');
  const resolvedMainWorkspace = path.join(farmingWorkspace, '.farming');
  const captured = [];
  fs.mkdirSync(farmingWorkspace, { recursive: true });

  const manager = new AgentManager({
    getWorkspace() {
      return farmingWorkspace;
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
    }
  }, { skipExecutablePreflight: true });

  manager.engineBridge.resolve = (command) => ({
    engineName: 'local',
    engine: {
      async createSession(options) {
        captured.push({ command, cwd: options.cwd, metadata: options.metadata, env: options.env });
      }
    },
    spec: { category: 'other' }
  });

  try {
    const mainAgentId = await startAgent(manager, 'bash', null, { wantsMain: true });
    assert.strictEqual(captured[0].cwd, resolvedMainWorkspace);
    assert(fs.existsSync(path.join(resolvedMainWorkspace, 'AGENTS.md')));
    assert(fs.existsSync(path.join(resolvedMainWorkspace, 'skills', 'memory-report.md')));
    assert.strictEqual(manager.getAgentWorkspaceRoot(mainAgentId), farmingWorkspace);
    assert.strictEqual(manager.agents.get(mainAgentId).status, 'running');
    assert.strictEqual(manager.agents.get(mainAgentId).validated, true);
    assert.strictEqual(manager.mainAgentId, mainAgentId);
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === mainAgentId).projectWorkspace,
      fs.realpathSync(farmingWorkspace)
    );
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === mainAgentId).engineName,
      'local'
    );
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === mainAgentId).isMain,
      true
    );
    manager.mainAgentId = null;
    manager.agents.get(mainAgentId).status = 'running';
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === mainAgentId).isMain,
      true,
      'active wantsMain agent should remain marked as Main Agent before mainAgentId is assigned'
    );

    const duplicateMainAgentId = await startAgent(manager, 'bash', null, { wantsMain: true });
    assert.strictEqual(duplicateMainAgentId, mainAgentId);
    assert.strictEqual(
      manager.mainAgentId,
      mainAgentId,
      'starting Main Agent should reclaim an active wantsMain Agent when the authoritative id was lost'
    );
    assert.strictEqual(captured.length, 1);

    const recoveryRaceWorkspace = path.join(os.tmpdir(), 'farming-recovery-race-workspace');
    fs.mkdirSync(recoveryRaceWorkspace, { recursive: true });
    const recoveryRaceCaptured = [];
    const recoveryRaceManager = new AgentManager({
      getWorkspace() {
        return recoveryRaceWorkspace;
      },
      getHeartbeatInterval() {
        return 1000;
      },
      getDangerouslySkipAgentPermissionsByDefault() {
        return false;
      },
    });
    recoveryRaceManager.engineBridge.resolve = (command) => ({
      engineName: 'local',
      engine: {
        async createSession(options) {
          recoveryRaceCaptured.push({ command, cwd: options.cwd });
        }
      },
      spec: { category: 'other' }
    });
    let releaseRecovery = () => {};
    recoveryRaceManager.recoveryPromise = new Promise(resolve => {
      releaseRecovery = resolve;
    });
    const recoveredMainAgentId = 'agent-recovered-main';
    const pendingMainStart = startAgent(recoveryRaceManager, 'bash', null, { wantsMain: true });
    await Promise.resolve();
    assert.strictEqual(recoveryRaceCaptured.length, 0, 'main auto-start should wait for engine recovery');
    recoveryRaceManager.agents.set(recoveredMainAgentId, {
      id: recoveredMainAgentId,
      command: 'bash',
      cwd: path.join(recoveryRaceWorkspace, '.farming'),
      projectWorkspace: recoveryRaceWorkspace,
      status: 'running',
      wantsMain: true,
    });
    recoveryRaceManager.mainAgentId = recoveredMainAgentId;
    releaseRecovery();
    assert.strictEqual(await pendingMainStart, recoveredMainAgentId);
    assert.strictEqual(recoveryRaceCaptured.length, 0, 'recovered Main Agent should prevent duplicate bash start');
    clearInterval(recoveryRaceManager.heartbeatInterval);
    recoveryRaceManager.engineBridge.dispose();

    manager.agents.get(mainAgentId).status = 'dead';

    const internalConfigWorkspace = path.join(os.tmpdir(), 'farming-internal-main-workspace', '.farming');
    const internalCaptured = [];
    fs.mkdirSync(internalConfigWorkspace, { recursive: true });
    const internalManager = new AgentManager({
      getWorkspace() {
        return internalConfigWorkspace;
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
      }
    });
    internalManager.engineBridge.resolve = (command) => ({
      engineName: 'local',
      engine: {
        async createSession(options) {
          internalCaptured.push({ command, cwd: options.cwd });
        }
      },
      spec: { category: 'other' }
    });
    const internalMainAgentId = await startAgent(internalManager, 'bash', null, { wantsMain: true });
    assert.strictEqual(internalCaptured[0].cwd, internalConfigWorkspace);
    assert.strictEqual(internalManager.getAgentWorkspaceRoot(internalMainAgentId), internalConfigWorkspace);
    assert.strictEqual(
      internalManager.getState().agents.find(agent => agent.id === internalMainAgentId).projectWorkspace,
      fs.realpathSync(internalConfigWorkspace)
    );
    clearInterval(internalManager.heartbeatInterval);
    internalManager.engineBridge.dispose();

    await assert.rejects(
      () => startAgent(manager, 'bash', path.join(os.tmpdir(), 'farming-missing-main-workspace'), { wantsMain: true }),
      /Workspace does not exist/
    );

    manager.mainAgentId = 'main-agent-existing';
    manager.agents.set('main-agent-existing', {
      id: 'main-agent-existing',
      status: 'running',
      output: '',
    });

    await startAgent(manager, 'zsh', null, { wantsMain: false });
    assert.strictEqual(captured[1].cwd, process.env.PWD || process.cwd() || process.env.HOME);

    const restoredProjectWorkspace = path.join(os.tmpdir(), 'farming-restored-project-root');
    const restoredWorkingDirectory = path.join(restoredProjectWorkspace, 'packages', 'api');
    fs.mkdirSync(restoredWorkingDirectory, { recursive: true });
    const restoredAgentId = await startAgent(manager, 'claude --resume session-123', restoredWorkingDirectory, {
      wantsMain: false,
      projectWorkspace: restoredProjectWorkspace,
      source: 'claude-history:session-123',
    });
    const restoredAgent = manager.agents.get(restoredAgentId);
    assert.strictEqual(restoredAgent.cwd, restoredWorkingDirectory);
    assert.strictEqual(restoredAgent.projectWorkspace, restoredProjectWorkspace);
    assert.strictEqual(captured[2].cwd, restoredWorkingDirectory);
    assert.strictEqual(captured[2].metadata.cwd, restoredWorkingDirectory);
    assert.strictEqual(captured[2].metadata.projectWorkspace, restoredProjectWorkspace);
    assert.strictEqual(captured[2].env.FARMING_PROJECT_WORKSPACE, restoredProjectWorkspace);

    const aliasedWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-aliased-project-'));
    const canonicalAliasedWorkspace = path.join(aliasedWorkspaceRoot, 'project');
    const aliasedWorkspace = path.join(aliasedWorkspaceRoot, 'project-link');
    fs.mkdirSync(canonicalAliasedWorkspace);
    fs.symlinkSync(
      canonicalAliasedWorkspace,
      aliasedWorkspace,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasedAgentId = await startAgent(manager, 'bash', aliasedWorkspace, { wantsMain: false });
    assert.strictEqual(
      manager.agents.get(aliasedAgentId).cwd,
      aliasedWorkspace,
      'the runtime should keep the user-selected working-directory spelling'
    );
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === aliasedAgentId).projectWorkspace,
      fs.realpathSync(canonicalAliasedWorkspace),
      'browser-facing Project identity should resolve filesystem aliases'
    );

    const outsideProjectWorkspace = path.join(os.tmpdir(), 'farming-outside-project-root');
    fs.mkdirSync(outsideProjectWorkspace, { recursive: true });
    const outsideAgentId = await startAgent(manager, 'claude --resume session-456', restoredWorkingDirectory, {
      wantsMain: false,
      projectWorkspace: outsideProjectWorkspace,
      source: 'claude-history:session-456',
    });
    const outsideAgent = manager.agents.get(outsideAgentId);
    assert.strictEqual(outsideAgent.cwd, restoredWorkingDirectory);
    assert.strictEqual(outsideAgent.projectWorkspace, restoredWorkingDirectory);

    console.log('✓ AgentManager uses .farming identity workspace for main agent and project cwd for sub agents by default');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
