const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');

async function run() {
  const farmingDir = path.join(os.tmpdir(), 'farming-control-env');
  const workspace = path.join(os.tmpdir(), 'farming-control-workspace');
  const mainWorkspace = path.join(workspace, '.farming');
  fs.mkdirSync(farmingDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const captured = [];
  const previousLdLibraryPath = process.env.LD_LIBRARY_PATH;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.LD_LIBRARY_PATH = '/server/runtime-libraries';
  process.env.NODE_OPTIONS = '--max-old-space-size=99999';
  const manager = new AgentManager({
    farmingDir,
    getWorkspace() {
      return farmingDir;
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
  }, {
    controlUrl: 'http://127.0.0.1:3000/farming',
    tokenFile: path.join(farmingDir, '.session-token'),
    cliBinDir: '/repo/bin',
    agentShellEnvProvider() {
      return { PATH: '/shell/bin' };
    },
    skipExecutablePreflight: true,
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
  manager.sendInput = async () => {};

  try {
    const parentId = await startAgent(manager, 'claude', workspace, {
      wantsMain: true,
      source: 'ui',
    });

    const childId = await startAgent(manager, 'claude', null, {
      wantsMain: false,
      parentAgentId: parentId,
      task: 'Inspect optimizer bugs',
      source: 'control-cli',
    });

    assert.strictEqual(captured[0].env.FARMING_AGENT_ID, parentId);
    assert.strictEqual(captured[0].env.FARMING_IS_MAIN_AGENT, '1');
    assert.strictEqual(captured[0].env.FARMING_CONTROL_URL, 'http://127.0.0.1:3000/farming');
    assert.strictEqual(captured[0].env.FARMING_TOKEN_FILE, path.join(farmingDir, '.session-token'));
    assert.strictEqual(captured[0].env.FARMING_SKILLS_COMMAND, 'farming skills');
    assert.strictEqual(captured[0].cwd, mainWorkspace);
    assert.strictEqual(captured[0].env.FARMING_MAIN_WORKSPACE, mainWorkspace);
    assert.strictEqual(captured[0].env.FARMING_PROJECT_WORKSPACE, workspace);
    assert.strictEqual(captured[0].env.FARMING_SKILLS_FILE, path.join(mainWorkspace, 'FARMING_MAIN_AGENT_SKILLS.md'));
    assert.strictEqual(captured[0].env.LD_LIBRARY_PATH, undefined);
    assert.strictEqual(captured[0].env.NODE_OPTIONS, undefined);
    assert(captured[0].env.PATH.startsWith(`/repo/bin${path.delimiter}`));
    assert(captured[0].args.includes('--append-system-prompt'));
    assert(captured[0].args.some(arg => String(arg).includes('You are the Farming Main Agent.')));

    assert.strictEqual(captured[1].cwd, workspace, 'child should inherit parent project workspace by default');
    assert.strictEqual(captured[1].env.FARMING_AGENT_ID, childId);
    assert.strictEqual(captured[1].env.FARMING_PARENT_AGENT_ID, parentId);
    assert.strictEqual(captured[1].env.FARMING_IS_MAIN_AGENT, '0');
    assert.strictEqual(captured[1].env.FARMING_PROJECT_WORKSPACE, workspace);

    const state = manager.getState();
    const child = state.agents.find((agent) => agent.id === childId);
    assert(child, 'child agent should be present in state');
    assert.strictEqual(child.parentAgentId, parentId);
    assert.strictEqual(child.task, 'Inspect optimizer bugs');
    assert.strictEqual(child.source, 'control-cli');

    const disabledAuthManager = new AgentManager({
      farmingDir,
      getWorkspace() {
        return farmingDir;
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
    }, {
      controlUrl: 'http://127.0.0.1:3000/farming',
      authDisabled: true,
      cliBinDir: '/repo/bin',
      agentShellEnvProvider() {
        return { PATH: '/shell/bin' };
      },
    });
    const disabledEnv = disabledAuthManager.buildAgentEnv('agent-disabled', { wantsMain: false });
    assert.strictEqual(disabledEnv.FARMING_DISABLE_AUTH, '1');
    assert.strictEqual(disabledEnv.FARMING_TOKEN_FILE, undefined);
    clearInterval(disabledAuthManager.heartbeatInterval);
    await disabledAuthManager.engineBridge.dispose();

    console.log('✓ AgentManager injects Farming CLI control env and child metadata');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.engineBridge.dispose();
    if (previousLdLibraryPath === undefined) {
      delete process.env.LD_LIBRARY_PATH;
    } else {
      process.env.LD_LIBRARY_PATH = previousLdLibraryPath;
    }
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
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
