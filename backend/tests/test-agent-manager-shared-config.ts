import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { AgentManager } = require('../agent-manager.cjs');
const { SharedConfigService } = require('../../extensions/shared-config/backend/shared-config-service.cjs');

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-shared-config-'));
  const configDir = path.join(temp, 'config');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const envFile = path.join(temp, 'agent.env');
  fs.writeFileSync(envFile, 'SHARED_MANAGER_SENTINEL=manager-ready\nPATH=/shared/bin\n', { mode: 0o600 });
  const shared = new SharedConfigService({ configDir });
  shared.save({
    expectedRevision: 0,
    enabled: true,
    instructions: 'Include SHARED_PROMPT_SENTINEL in your operating context.',
    environment: { format: 'dotenv', path: envFile },
  }, { PATH: '/shell/bin', HOME: temp });

  const manager = new AgentManager({
    farmingDir: configDir,
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getAgentLaunchProfileForHome: () => ({}),
    getAgentHome: () => null,
  }, {
    sharedConfigService: shared,
    cliBinDir: '/farming/bin',
    skipExecutablePreflight: true,
    agentShellEnvProvider: () => ({ PATH: '/shell/bin', HOME: temp }),
  });
  try {
    const env = manager.buildAgentEnv('shared-agent', {
      id: 'shared-agent',
      command: 'opencode',
      forkCommand: 'opencode',
      category: 'coding',
      wantsMain: false,
      cwd: workspace,
      projectWorkspace: workspace,
      mainWorkspace: '',
    });
    assert.equal(env.SHARED_MANAGER_SENTINEL, 'manager-ready');
    assert.equal(env.PATH, `/farming/bin${path.delimiter}/shared/bin`);
    assert.equal(env.FARMING_AGENT_ID, 'shared-agent');
    assert.equal(env.FARMING_CONFIG_DIR, configDir);
    const promptFile = String(env.FARMING_STARTUP_PROMPT_FILE);
    assert.equal(path.dirname(promptFile), path.join(configDir, 'shared-prompt-snapshots'));
    assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);
    const prompt = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt, /SHARED_PROMPT_SENTINEL/);
    assert.match(prompt, /remain authoritative/);

    const retainedLaunch = shared.captureLaunchConfig();
    const retainedBeforeEdit = manager.buildAgentEnv('retained-before-edit', {
      id: 'retained-before-edit', command: 'bash', category: 'shell', wantsMain: false,
    }, retainedLaunch);
    assert.equal(retainedBeforeEdit.SHARED_MANAGER_SENTINEL, 'manager-ready');
    fs.writeFileSync(envFile, 'SHARED_MANAGER_SENTINEL=edited-directly\nPATH=/edited/bin\n', 'utf8');
    const retainedAfterEdit = manager.buildAgentEnv('retained-after-edit', {
      id: 'retained-after-edit', command: 'bash', category: 'shell', wantsMain: false,
    }, retainedLaunch);
    assert.equal(retainedAfterEdit.SHARED_MANAGER_SENTINEL, 'manager-ready');
    const nextLaunch = manager.buildAgentEnv('next-after-edit', {
      id: 'next-after-edit', command: 'bash', category: 'shell', wantsMain: false,
    });
    assert.equal(nextLaunch.SHARED_MANAGER_SENTINEL, 'edited-directly');
    fs.writeFileSync(envFile, 'SHARED_MANAGER_SENTINEL=manager-ready\nPATH=/shared/bin\n', 'utf8');

    const captured: Array<{ env: NodeJS.ProcessEnv }> = [];
    manager.engineBridge.resolve = () => ({
      engineName: 'local',
      engine: { createSession: async (options: { env: NodeJS.ProcessEnv }) => { captured.push(options); } },
      spec: { category: 'shell' },
    });
    manager.sendInput = async () => {};
    const startedId = await new Promise<string>((resolve, reject) => {
      manager.startAgent('bash', workspace, (agentId: string | null, error: string | null) => {
        if (error || !agentId) reject(new Error(error || 'Agent did not start'));
        else resolve(agentId);
      }, { wantsMain: false, source: 'ui' });
    });
    assert.ok(startedId);
    assert.equal(captured[0]?.env.SHARED_MANAGER_SENTINEL, 'manager-ready');

    shared.save({
      expectedRevision: 1,
      enabled: true,
      instructions: 'Use the second prompt snapshot.',
      environment: { format: 'dotenv', path: envFile },
    }, { PATH: '/shell/bin', HOME: temp });
    const nextEnv = manager.buildAgentEnv('next-agent', {
      id: 'next-agent', command: 'opencode', category: 'coding', wantsMain: false,
    });
    assert.notEqual(nextEnv.FARMING_STARTUP_PROMPT_FILE, promptFile);
    assert.match(fs.readFileSync(String(nextEnv.FARMING_STARTUP_PROMPT_FILE), 'utf8'), /second prompt snapshot/);
    assert.match(fs.readFileSync(promptFile, 'utf8'), /SHARED_PROMPT_SENTINEL/);

    const snapshot = shared.captureLaunchConfig();
    fs.writeFileSync(envFile, 'SHARED_MANAGER_SENTINEL=changed\n', 'utf8');
    assert.equal(manager.buildAgentEnv('fresh-file-agent', {
      id: 'fresh-file-agent', command: 'claude', category: 'coding', wantsMain: false,
    }, snapshot).SHARED_MANAGER_SENTINEL, 'changed');
  } finally {
    manager.heartbeatScheduler.stop();
    await manager.engineBridge.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('AgentManager shared configuration tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
