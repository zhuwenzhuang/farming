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

function ccStatisticsUsageCacheFile(configDir) {
  return path.join(historyDir(configDir), 'cc-statistics-usage-v1.sqlite3');
}

function ccStatisticsRuntimeDir(configDir, revision) {
  return path.join(configDir, 'runtime', `cc-statistics-${revision}`);
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
  farmingNetInstancesFile,
  farmingNetServerLogFile,
  farmingNetServerStateFile,
  farmingNetSigningPrivateKeyFile,
  farmingNetSigningPublicKeyFile,
  farmingNetTrustFile,
  farmingConfigDir,
  historyDir,
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
  updateStateFile,
  ccStatisticsRuntimeDir,
  ccStatisticsUsageCacheFile,
};
