const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NATIVE_PTY_HOST_PROTOCOL_VERSION = 8;
const NATIVE_PTY_HOST_RUNTIME_FILES = Object.freeze([
  'agent-env.js',
  'input-parts.js',
  'local-session-engine.js',
  'native-pty-host.js',
  'shell-busy-integration.js',
  'terminal-screen-worker-pool.js',
  'terminal-screen-worker-thread.js',
  'terminal-screen-worker.js',
  'terminal-reducer-flow-control.js',
  'terminal-state-serialization.js',
  'native-pty-controller-generation.js',
  'terminal-status.js',
]);

function readFileForIdentity(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    return Buffer.from(`missing:${error && error.code ? error.code : 'unknown'}`, 'utf8');
  }
}

function packageVersion(backendDir) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(backendDir, '..', 'package.json'), 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '';
  } catch {
    return '';
  }
}

function nativePtyHostRuntimeIdentity(backendDir = __dirname) {
  const hash = crypto.createHash('sha256');
  const version = packageVersion(backendDir);
  hash.update(`protocol:${NATIVE_PTY_HOST_PROTOCOL_VERSION}\n`);
  hash.update(`version:${version}\n`);
  for (const filename of NATIVE_PTY_HOST_RUNTIME_FILES) {
    hash.update(`file:${filename}\n`);
    hash.update(readFileForIdentity(path.join(backendDir, filename)));
    hash.update('\n');
  }
  return Object.freeze({
    protocolVersion: NATIVE_PTY_HOST_PROTOCOL_VERSION,
    buildId: hash.digest('hex'),
    version,
  });
}

function normalizeNativePtyHostRuntimeIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const protocolVersion = Number(value.protocolVersion);
  const buildId = typeof value.buildId === 'string' ? value.buildId.trim() : '';
  if (!Number.isInteger(protocolVersion) || protocolVersion <= 0 || !/^[a-f0-9]{64}$/i.test(buildId)) {
    return null;
  }
  return {
    protocolVersion,
    buildId: buildId.toLowerCase(),
    version: typeof value.version === 'string' ? value.version : '',
  };
}

function nativePtyHostRuntimeIdentityMatches(expected, actual) {
  const normalizedExpected = normalizeNativePtyHostRuntimeIdentity(expected);
  const normalizedActual = normalizeNativePtyHostRuntimeIdentity(actual);
  return Boolean(
    normalizedExpected &&
    normalizedActual &&
    normalizedExpected.protocolVersion === normalizedActual.protocolVersion &&
    normalizedExpected.buildId === normalizedActual.buildId
  );
}

module.exports = {
  NATIVE_PTY_HOST_PROTOCOL_VERSION,
  NATIVE_PTY_HOST_RUNTIME_FILES,
  nativePtyHostRuntimeIdentity,
  nativePtyHostRuntimeIdentityMatches,
  normalizeNativePtyHostRuntimeIdentity,
};
