const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { nativePtyHostSocketPath } = require('./native-pty-host-path');

function canUseUnixSocket(socketPath) {
  return process.platform !== 'win32' && typeof socketPath === 'string' && socketPath.length > 0;
}

function socketExists(socketPath) {
  try {
    fs.accessSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

function probeUnixSocket(socketPath, timeoutMs = 120) {
  if (!canUseUnixSocket(socketPath)) {
    return Promise.resolve({ active: false, code: 'unsupported' });
  }

  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ active: false, code: 'timeout' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    socket.once('connect', () => finish({ active: true }));
    socket.once('error', error => finish({ active: false, code: error && error.code ? error.code : 'error' }));
  });
}

async function cleanupStaleNativePtySocket(options = {}) {
  const socketPath = options.socketPath || nativePtyHostSocketPath(options.configDir);
  if (!canUseUnixSocket(socketPath) || !socketExists(socketPath)) {
    return { socketPath, removed: false, active: false };
  }

  const probe = await probeUnixSocket(socketPath, options.timeoutMs);
  if (probe.active) {
    return { socketPath, removed: false, active: true };
  }

  try {
    fs.unlinkSync(socketPath);
    return { socketPath, removed: true, active: false, code: probe.code };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { socketPath, removed: false, active: false, code: probe.code };
    }
    throw error;
  }
}

async function cleanupTerminalRuntime(options = {}) {
  if (process.env.FARMING_SKIP_TERMINAL_RUNTIME_CLEANUP === '1') {
    return { skipped: true };
  }

  const configDir = options.configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');

  return {
    nativeSocket: await cleanupStaleNativePtySocket({ ...options, configDir }),
  };
}

module.exports = {
  cleanupStaleNativePtySocket,
  cleanupTerminalRuntime,
  probeUnixSocket,
};
