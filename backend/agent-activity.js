const { deriveRuntimeObservation } = require('./runtime-observation');

function agentKindForCommand(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const basename = (executable || '').split('/').pop() || '';
  if (basename === 'codex') return 'codex';
  if (basename === 'claude') return 'claude';
  if (['bash', 'zsh', 'sh', 'fish'].includes(basename)) return 'shell';
  return executable ? 'agent' : null;
}

function isRecoverableEngineAgent(agent) {
  return agent && agent.engineName === 'native';
}

function isRestartBlockingAgent(agent) {
  if (!agent || agent.isMain === true || agent.archived === true) return false;
  if (agent.status === 'pending') return true;
  if (agent.status !== 'running') return false;
  if (isRecoverableEngineAgent(agent)) return false;

  const observation = deriveRuntimeObservation(agent);
  if (observation.phase === 'starting' || observation.phase === 'working' || observation.phase === 'waiting') return true;
  if (observation.phase === 'idle' || observation.phase === 'exited') return false;
  return observation.kind !== 'shell';
}

module.exports = {
  agentKindForCommand,
  isRecoverableEngineAgent,
  isRestartBlockingAgent,
};
