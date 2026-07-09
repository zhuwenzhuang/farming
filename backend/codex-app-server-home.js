const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

const SHARED_HOME_ENTRIES = Object.freeze([
  'auth.json',
  '.credentials.json',
  'config.toml',
  'AGENTS.md',
  'AGENTS.zh_cn.md',
  'skills',
  'plugins',
  'rules',
  'themes',
]);

function ensureLinkedEntry(sourceHome, runtimeHome, name) {
  const source = path.join(sourceHome, name);
  const target = path.join(runtimeHome, name);
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? 'dir' : 'file');
}

function ensureCodexAppServerHome(options = {}) {
  const sourceHome = path.resolve(String(options.sourceHome || ''));
  if (!sourceHome || !fs.statSync(sourceHome).isDirectory()) {
    throw new Error('Configured Codex home is unavailable for App Server mode');
  }
  const runtimeHome = storageLayout.codexAppServerAgentHome(options.configDir, options.agentId);
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  for (const name of SHARED_HOME_ENTRIES) {
    ensureLinkedEntry(sourceHome, runtimeHome, name);
  }
  return runtimeHome;
}

module.exports = {
  ensureCodexAppServerHome,
};
