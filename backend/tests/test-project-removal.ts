const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');
const { executeProjectRemoval, projectArchiveTargets } = importTsModule('src/components/code/project-removal.ts');

function plan(overrides = {}) {
  return {
    workspace: '/repo',
    agents: [
      { id: 'agent-a', acknowledgeUnprovenAcpExit: false },
      { id: 'agent-b', acknowledgeUnprovenAcpExit: true },
    ],
    sessionHandles: ['session-a'],
    files: [{ agentId: 'wroot_repo', filePath: 'README.md', workspaceRoot: '/repo' }],
    ...overrides,
  };
}

async function run() {
  const archiveTargets = projectArchiveTargets({
    workspace: '/repo',
    agents: [
      { id: 'ordinary-agent', isMain: false, pinned: false },
      { id: 'manual-pin', isMain: false, pinned: true },
      { id: 'dynamic-pin', isMain: false, pinned: false },
      { id: 'main', isMain: true, pinned: false },
    ],
  }, [
    { provider: 'codex', id: 'ordinary-session', workspace: '/repo', pinned: false },
    { provider: 'codex', id: 'pinned-session', workspace: '/repo', pinned: true },
    { provider: 'codex', id: 'other-project', workspace: '/other', pinned: false },
  ], new Set(['dynamic-pin']));
  assert.deepStrictEqual(archiveTargets, {
    agentIds: ['ordinary-agent'],
    sessionHandles: ['agent-session:codex:~2~default~ordinary-session'],
  }, 'Project Archive must protect every row shown in the pinned section');

  const effects = [];
  const succeeded = await executeProjectRemoval(plan(), {
    archiveAgent: async agent => {
      effects.push(`agent:${agent.id}:${agent.acknowledgeUnprovenAcpExit}`);
      return true;
    },
    archiveSessions: async handles => {
      effects.push(`sessions:${handles.join(',')}`);
      return true;
    },
    closeFiles: files => effects.push(`files:${files.map(file => file.filePath).join(',')}`),
    removeProject: async workspace => {
      effects.push(`project:${workspace}`);
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(succeeded, { status: 'succeeded' });
  assert.deepStrictEqual(effects, [
    'agent:agent-a:false',
    'agent:agent-b:true',
    'sessions:session-a',
    'files:README.md',
    'project:/repo',
  ]);

  const agentFailureEffects = [];
  const agentFailure = await executeProjectRemoval(plan(), {
    archiveAgent: async agent => {
      agentFailureEffects.push(`agent:${agent.id}`);
      return agent.id !== 'agent-b';
    },
    archiveSessions: async () => {
      agentFailureEffects.push('sessions');
      return true;
    },
    closeFiles: () => agentFailureEffects.push('files'),
    removeProject: async () => {
      agentFailureEffects.push('project');
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(agentFailure, { status: 'failed', stage: 'archive-agents', uncertain: false });
  assert.deepStrictEqual(agentFailureEffects, ['agent:agent-a', 'agent:agent-b']);

  const sessionFailureEffects = [];
  const sessionFailure = await executeProjectRemoval(plan({ agents: [] }), {
    archiveAgent: async () => true,
    archiveSessions: async () => {
      sessionFailureEffects.push('sessions');
      return false;
    },
    closeFiles: () => sessionFailureEffects.push('files'),
    removeProject: async () => {
      sessionFailureEffects.push('project');
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(sessionFailure, { status: 'failed', stage: 'archive-sessions', uncertain: false });
  assert.deepStrictEqual(sessionFailureEffects, ['sessions']);

  const thrownAgentEffects = [];
  const thrownAgent = await executeProjectRemoval(plan({ agents: [{ id: 'agent-a', acknowledgeUnprovenAcpExit: false }] }), {
    archiveAgent: async () => {
      thrownAgentEffects.push('agent');
      throw new Error('transport failed');
    },
    archiveSessions: async () => {
      thrownAgentEffects.push('sessions');
      return true;
    },
    closeFiles: () => thrownAgentEffects.push('files'),
    removeProject: async () => {
      thrownAgentEffects.push('project');
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(thrownAgent, { status: 'failed', stage: 'archive-agents', uncertain: true });
  assert.deepStrictEqual(thrownAgentEffects, ['agent']);

  const closeFailureEffects = [];
  const closeFailure = await executeProjectRemoval(plan({ agents: [], sessionHandles: [] }), {
    archiveAgent: async () => true,
    archiveSessions: async () => true,
    closeFiles: () => {
      closeFailureEffects.push('files');
      throw new Error('close failed');
    },
    removeProject: async () => {
      closeFailureEffects.push('project');
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(closeFailure, { status: 'failed', stage: 'close-files', uncertain: false });
  assert.deepStrictEqual(closeFailureEffects, ['files']);

  const definitiveProjectFailure = await executeProjectRemoval(plan({ agents: [], sessionHandles: [], files: [] }), {
    archiveAgent: async () => true,
    archiveSessions: async () => true,
    closeFiles: () => {},
    removeProject: async () => ({ status: 'failed', uncertain: false }),
  });
  assert.deepStrictEqual(definitiveProjectFailure, { status: 'failed', stage: 'remove-project', uncertain: false });

  const uncertainProject = await executeProjectRemoval(plan({ agents: [], sessionHandles: [], files: [] }), {
    archiveAgent: async () => true,
    archiveSessions: async () => true,
    closeFiles: () => {},
    removeProject: async () => ({ status: 'failed', uncertain: true }),
  });
  assert.deepStrictEqual(uncertainProject, { status: 'failed', stage: 'remove-project', uncertain: true });

  const emptyEffects = [];
  const emptyPlan = await executeProjectRemoval(plan({ agents: [], sessionHandles: [], files: [] }), {
    archiveAgent: async () => {
      emptyEffects.push('agent');
      return true;
    },
    archiveSessions: async () => {
      emptyEffects.push('sessions');
      return true;
    },
    closeFiles: () => emptyEffects.push('files'),
    removeProject: async () => {
      emptyEffects.push('project');
      return { status: 'succeeded' };
    },
  });
  assert.deepStrictEqual(emptyPlan, { status: 'succeeded' });
  assert.deepStrictEqual(emptyEffects, ['project']);

  console.log('test-project-removal passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
