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

function historyDir(configDir) {
  return path.join(configDir, 'history');
}

function runHistoryFile(configDir) {
  return path.join(historyDir(configDir), 'runs.json');
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

module.exports = {
  farmingConfigDir,
  historyDir,
  nativePtyHostLogFile,
  runHistoryFile,
  serverLogFile,
  serverPidFile,
  serverStateFile,
  sessionIndexFile,
  sessionTokenFile,
  sessionsDir,
  settingsFile,
  themeSettingsFile,
};
