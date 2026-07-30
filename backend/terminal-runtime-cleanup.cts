const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
import { nativePtyHostSocketPath } from './native-pty-host-path.cjs';

interface TerminalRuntimeCleanupOptions {
  configDir?: string;
  socketPath?: string;
  timeoutMs?: number;
}

type UnixSocketProbe = {
  active: boolean;
  code?: string;
};

interface NativePtySocketCleanup extends UnixSocketProbe {
  socketPath: string;
  removed: boolean;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'error';
}

function canUseUnixSocket(socketPath: unknown): socketPath is string {
  return process.platform !== 'win32' && typeof socketPath === 'string' && socketPath.length > 0;
}

function socketExists(socketPath: string): boolean {
  try {
    fs.accessSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

function probeUnixSocket(socketPath: string, timeoutMs = 120): Promise<UnixSocketProbe> {
  if (!canUseUnixSocket(socketPath)) {
    return Promise.resolve({ active: false, code: 'unsupported' });
  }

  return new Promise<UnixSocketProbe>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (result: UnixSocketProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ active: false, code: 'timeout' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    socket.once('connect', () => finish({ active: true }));
    socket.once('error', (error: Error) => finish({ active: false, code: errorCode(error) }));
  });
}

async function cleanupStaleNativePtySocket(
  options: TerminalRuntimeCleanupOptions = {},
): Promise<NativePtySocketCleanup> {
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
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return { socketPath, removed: false, active: false, code: probe.code };
    }
    throw error;
  }
}

async function cleanupTerminalRuntime(
  options: TerminalRuntimeCleanupOptions = {},
): Promise<{ skipped: true } | { nativeSocket: NativePtySocketCleanup }> {
  if (process.env.FARMING_SKIP_TERMINAL_RUNTIME_CLEANUP === '1') {
    return { skipped: true };
  }

  const configDir = options.configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');

  return {
    nativeSocket: await cleanupStaleNativePtySocket({ ...options, configDir }),
  };
}

export {
  cleanupStaleNativePtySocket,
  cleanupTerminalRuntime,
  probeUnixSocket,
};
