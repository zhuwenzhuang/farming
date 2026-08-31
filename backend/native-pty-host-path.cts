'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalConfigDir } from './config-instance.cjs';

interface NativePtyPrivateSocketOptions {
  pid?: number;
  nonce?: string;
}

const PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

function nativePtyHostUnixSocketPath(filename: string): string {
  const temporaryPath = path.join(os.tmpdir(), filename);
  if (Buffer.byteLength(temporaryPath) <= PORTABLE_UNIX_SOCKET_PATH_BYTES) {
    return temporaryPath;
  }
  return path.join('/tmp', filename);
}

function nativePtyHostSocketPath(configDir?: string): string {
  const root = configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
  const hash = crypto
    .createHash('sha1')
    .update(canonicalConfigDir(root))
    .digest('hex')
    .slice(0, 12);

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\farming-native-pty-${hash}`;
  }

  return nativePtyHostUnixSocketPath(
    `farming-native-pty-${process.getuid ? process.getuid() : 'user'}-${hash}.sock`,
  );
}

function nativePtyHostPrivateSocketHash(socketPath: string): string {
  return crypto.createHash('sha256').update(socketPath).digest('hex').slice(0, 8);
}

function nativePtyHostPrivateSocketPath(
  socketPath: string,
  options: NativePtyPrivateSocketOptions = {},
): string {
  const pid = Number(options.pid || process.pid);
  const nonce = String(options.nonce || crypto.randomBytes(4).toString('hex'));
  return path.join(
    path.dirname(socketPath),
    `.fpty-${pid}-${nativePtyHostPrivateSocketHash(socketPath)}-${nonce}.sock`,
  );
}

function nativePtyHostPrivateSocketNamePattern(socketPath: string): RegExp {
  const hash = nativePtyHostPrivateSocketHash(socketPath);
  return new RegExp(`^\\.fpty-\\d+-${hash}-[a-f0-9]+\\.sock$`);
}

function publishNativePtyHostSocket(privateSocketPath: string, publicSocketPath: string): void {
  try {
    fs.linkSync(privateSocketPath, publicSocketPath);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
    // Startup and private-socket recovery can publish the same listener at once.
    // An existing name only completes publication when it is that exact socket.
    const bound = fs.lstatSync(privateSocketPath, { bigint: true });
    const published = fs.lstatSync(publicSocketPath, { bigint: true });
    if (
      !bound.isSocket()
      || !published.isSocket()
      || bound.dev !== published.dev
      || bound.ino !== published.ino
    ) {
      throw error;
    }
  }
}

export {
  nativePtyHostPrivateSocketNamePattern,
  nativePtyHostPrivateSocketPath,
  nativePtyHostSocketPath,
  publishNativePtyHostSocket,
};
