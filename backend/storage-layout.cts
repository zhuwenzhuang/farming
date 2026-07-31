const os = require('os');
const path = require('path');

function farmingConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FARMING_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.farming');
}

function settingsFile(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

function themeSettingsFile(configDir: string): string {
  return path.join(configDir, 'theme-settings.json');
}

function sessionTokenFile(configDir: string): string {
  return path.join(configDir, '.session-token');
}

function sessionsDir(configDir: string): string {
  return path.join(configDir, 'sessions');
}

function acpCheckpointsDir(configDir: string): string {
  return path.join(sessionsDir(configDir), 'acp-checkpoints');
}

function agentStateFile(configDir: string, agentRecordId: string): string {
  return path.join(sessionsDir(configDir), `${agentRecordId}.state.json`);
}

function historyDir(configDir: string): string {
  return path.join(configDir, 'history');
}

function runHistoryFile(configDir: string): string {
  return path.join(historyDir(configDir), 'runs.json');
}

function reviewStateFile(configDir: string): string {
  return path.join(historyDir(configDir), 'review-state.json');
}

function reviewSessionsFile(configDir: string): string {
  return path.join(historyDir(configDir), 'review-sessions.json');
}

function usageHistoryCacheFile(configDir: string): string {
  return path.join(historyDir(configDir), 'usage-history-v2.sqlite3');
}

function inventoryCacheDir(configDir: string): string {
  return path.join(configDir, 'cache');
}

function agentSessionInventoryCacheFile(configDir: string): string {
  return path.join(inventoryCacheDir(configDir), 'agent-sessions-v1.json');
}

function agentExtensionInventoryCacheFile(configDir: string): string {
  return path.join(inventoryCacheDir(configDir), 'agent-extensions-v1.json');
}

function browserResourcesDir(configDir: string): string {
  return path.join(configDir, 'browsers');
}

function browserResourcesFile(configDir: string): string {
  return path.join(browserResourcesDir(configDir), 'resources.json');
}

function browserProfileDir(configDir: string, browserId: string): string {
  return path.join(browserResourcesDir(configDir), browserId, 'profile');
}

function computerResourcesDir(configDir: string): string {
  return path.join(configDir, 'computers');
}

function computerResourcesFile(configDir: string): string {
  return path.join(computerResourcesDir(configDir), 'resources.json');
}

function runtimeDependenciesDir(configDir: string): string {
  return path.join(configDir, 'runtimes');
}

function runtimeDependenciesActiveFile(configDir: string): string {
  return path.join(runtimeDependenciesDir(configDir), 'active.json');
}

function runtimeDependencyBindingsDir(configDir: string): string {
  return path.join(runtimeDependenciesDir(configDir), 'bindings');
}

function runtimeDependencyBindingFile(configDir: string, bindingId: string): string {
  return path.join(runtimeDependencyBindingsDir(configDir), `${bindingId}.json`);
}

function runtimeDependenciesLockDir(configDir: string): string {
  return path.join(runtimeDependenciesDir(configDir), '.prepare.lock');
}

function managedChromiumRootDir(configDir: string): string {
  return path.join(runtimeDependenciesDir(configDir), 'chromium');
}

function managedChromiumVersionDir(
  configDir: string,
  agentBrowserVersion: string,
  platformKey: string,
): string {
  return path.join(managedChromiumRootDir(configDir), agentBrowserVersion, platformKey);
}

function managedChromiumInstallLockDir(configDir: string): string {
  return path.join(managedChromiumRootDir(configDir), '.install.lock');
}

function farmingAgentBootstrapFile(configDir: string): string {
  return path.join(configDir, 'farming-agent-bootstrap.zh_cn.md');
}

function sessionIndexFile(configDir: string): string {
  return path.join(sessionsDir(configDir), 'index.json');
}

function serverPidFile(configDir: string): string {
  return path.join(configDir, 'farming-server.pid');
}

function serverStateFile(configDir: string): string {
  return path.join(configDir, 'farming-server.json');
}

function serverLogFile(configDir: string): string {
  return path.join(configDir, 'farming-server.log');
}

function nativePtyHostLogFile(configDir: string): string {
  return path.join(configDir, 'native-pty-host.log');
}

function nativePtyControllerGenerationFile(configDir: string): string {
  return path.join(configDir, 'native-pty-controller-generation');
}

function nativePtyControllerGenerationLockDir(configDir: string): string {
  return path.join(configDir, '.native-pty-controller-generation.lock');
}

function nativePtyRuntimeGenerationFile(configDir: string): string {
  return path.join(configDir, 'native-pty-runtime-generation');
}

function nativePtyRuntimeGenerationLockDir(configDir: string): string {
  return path.join(configDir, '.native-pty-runtime-generation.lock');
}

function updateStateFile(configDir: string): string {
  return path.join(configDir, 'farming-update.json');
}

function updateLogFile(configDir: string): string {
  return path.join(configDir, 'farming-update.log');
}

function updateStagingDir(configDir: string): string {
  return path.join(configDir, 'updates');
}

function farmingNetInstancesFile(configDir: string): string {
  return path.join(configDir, 'instances.json');
}

function farmingNetServerStateFile(configDir: string): string {
  return path.join(configDir, 'farming-net-server.json');
}

function farmingNetServerLogFile(configDir: string): string {
  return path.join(configDir, 'farming-net-server.log');
}

function farmingNetSigningPrivateKeyFile(configDir: string): string {
  return path.join(configDir, 'signing-private-key.pem');
}

function farmingNetSigningPublicKeyFile(configDir: string): string {
  return path.join(configDir, 'signing-public-key.pem');
}

function farmingNetTrustFile(configDir: string): string {
  return path.join(configDir, 'farming-net-trust.json');
}

export {
  acpCheckpointsDir,
  agentExtensionInventoryCacheFile,
  agentSessionInventoryCacheFile,
  agentStateFile,
  browserProfileDir,
  browserResourcesDir,
  browserResourcesFile,
  computerResourcesDir,
  computerResourcesFile,
  farmingAgentBootstrapFile,
  farmingNetInstancesFile,
  farmingNetServerLogFile,
  farmingNetServerStateFile,
  farmingNetSigningPrivateKeyFile,
  farmingNetSigningPublicKeyFile,
  farmingNetTrustFile,
  farmingConfigDir,
  historyDir,
  inventoryCacheDir,
  managedChromiumInstallLockDir,
  managedChromiumRootDir,
  managedChromiumVersionDir,
  runtimeDependenciesActiveFile,
  runtimeDependencyBindingFile,
  runtimeDependencyBindingsDir,
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
