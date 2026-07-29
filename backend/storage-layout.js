const os = require('os');
const path = require('path');

function farmingConfigDir(env = process.env) {
  return env.FARMING_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.farming');
}

function settingsFile(configDir) {
  return path.join(configDir, 'settings.json');
}

function themeSettingsFile(configDir) {
  return path.join(configDir, 'theme-settings.json');
}

function sessionTokenFile(configDir) {
  return path.join(configDir, '.session-token');
}

function sessionsDir(configDir) {
  return path.join(configDir, 'sessions');
}

function acpCheckpointsDir(configDir) {
  return path.join(sessionsDir(configDir), 'acp-checkpoints');
}

function agentStateFile(configDir, agentRecordId) {
  return path.join(sessionsDir(configDir), `${agentRecordId}.state.json`);
}

function historyDir(configDir) {
  return path.join(configDir, 'history');
}

function runHistoryFile(configDir) {
  return path.join(historyDir(configDir), 'runs.json');
}

function reviewStateFile(configDir) {
  return path.join(historyDir(configDir), 'review-state.json');
}

function reviewSessionsFile(configDir) {
  return path.join(historyDir(configDir), 'review-sessions.json');
}

function usageHistoryCacheFile(configDir) {
  return path.join(historyDir(configDir), 'usage-history-v2.sqlite3');
}

function browserResourcesDir(configDir) {
  return path.join(configDir, 'browsers');
}

function browserResourcesFile(configDir) {
  return path.join(browserResourcesDir(configDir), 'resources.json');
}

function browserProfileDir(configDir, browserId) {
  return path.join(browserResourcesDir(configDir), browserId, 'profile');
}

function runtimeDependenciesDir(configDir) {
  return path.join(configDir, 'runtimes');
}

function runtimeDependenciesActiveFile(configDir) {
  return path.join(runtimeDependenciesDir(configDir), 'active.json');
}

function runtimeDependenciesLockDir(configDir) {
  return path.join(runtimeDependenciesDir(configDir), '.prepare.lock');
}

function managedChromiumRootDir(configDir) {
  return path.join(runtimeDependenciesDir(configDir), 'chromium');
}

function managedChromiumVersionDir(configDir, agentBrowserVersion, platformKey) {
  return path.join(managedChromiumRootDir(configDir), agentBrowserVersion, platformKey);
}

function managedChromiumInstallLockDir(configDir) {
  return path.join(managedChromiumRootDir(configDir), '.install.lock');
}

function farmingAgentBootstrapFile(configDir) {
  return path.join(configDir, 'farming-agent-bootstrap.zh_cn.md');
}

function sessionIndexFile(configDir) {
  return path.join(sessionsDir(configDir), 'index.json');
}

function serverPidFile(configDir) {
  return path.join(configDir, 'farming-server.pid');
}

function serverStateFile(configDir) {
  return path.join(configDir, 'farming-server.json');
}

function serverLogFile(configDir) {
  return path.join(configDir, 'farming-server.log');
}

function nativePtyHostLogFile(configDir) {
  return path.join(configDir, 'native-pty-host.log');
}

function nativePtyControllerGenerationFile(configDir) {
  return path.join(configDir, 'native-pty-controller-generation');
}

function nativePtyControllerGenerationLockDir(configDir) {
  return path.join(configDir, '.native-pty-controller-generation.lock');
}

function nativePtyRuntimeGenerationFile(configDir) {
  return path.join(configDir, 'native-pty-runtime-generation');
}

function nativePtyRuntimeGenerationLockDir(configDir) {
  return path.join(configDir, '.native-pty-runtime-generation.lock');
}

function updateStateFile(configDir) {
  return path.join(configDir, 'farming-update.json');
}

function updateLogFile(configDir) {
  return path.join(configDir, 'farming-update.log');
}

function updateStagingDir(configDir) {
  return path.join(configDir, 'updates');
}

function farmingNetInstancesFile(configDir) {
  return path.join(configDir, 'instances.json');
}

function farmingNetServerStateFile(configDir) {
  return path.join(configDir, 'farming-net-server.json');
}

function farmingNetServerLogFile(configDir) {
  return path.join(configDir, 'farming-net-server.log');
}

function farmingNetSigningPrivateKeyFile(configDir) {
  return path.join(configDir, 'signing-private-key.pem');
}

function farmingNetSigningPublicKeyFile(configDir) {
  return path.join(configDir, 'signing-public-key.pem');
}

function farmingNetTrustFile(configDir) {
  return path.join(configDir, 'farming-net-trust.json');
}

module.exports = {
  acpCheckpointsDir,
  agentStateFile,
  browserProfileDir,
  browserResourcesDir,
  browserResourcesFile,
  farmingAgentBootstrapFile,
  farmingNetInstancesFile,
  farmingNetServerLogFile,
  farmingNetServerStateFile,
  farmingNetSigningPrivateKeyFile,
  farmingNetSigningPublicKeyFile,
  farmingNetTrustFile,
  farmingConfigDir,
  historyDir,
  managedChromiumInstallLockDir,
  managedChromiumRootDir,
  managedChromiumVersionDir,
  runtimeDependenciesActiveFile,
  runtimeDependenciesDir,
  runtimeDependenciesLockDir,
  nativePtyControllerGenerationFile,
  nativePtyControllerGenerationLockDir,
  nativePtyHostLogFile,
  nativePtyRuntimeGenerationFile,
  nativePtyRuntimeGenerationLockDir,
  runHistoryFile,
  reviewSessionsFile,
  reviewStateFile,
  serverLogFile,
  serverPidFile,
  serverStateFile,
  sessionIndexFile,
  sessionTokenFile,
  sessionsDir,
  settingsFile,
  themeSettingsFile,
  updateLogFile,
  updateStagingDir,
  updateStateFile,
  usageHistoryCacheFile,
};
