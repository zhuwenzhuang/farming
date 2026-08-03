'use strict';

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { canonicalConfigDir } from './config-instance.cjs';

const PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

function portableSocketPath(filename: string): string {
  const temporaryPath = path.join(os.tmpdir(), filename);
  if (Buffer.byteLength(temporaryPath) <= PORTABLE_UNIX_SOCKET_PATH_BYTES) return temporaryPath;
  return path.join('/tmp', filename);
}

function acpRuntimeHostSocketPath(configDir?: string): string {
  const root = configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
  const hash = crypto.createHash('sha1').update(canonicalConfigDir(root)).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\farming-acp-runtime-${hash}`;
  const directory = portableSocketPath(
    `farming-acp-${process.getuid ? process.getuid() : 'user'}-${hash}`,
  );
  return path.join(directory, 'host.sock');
}

export { acpRuntimeHostSocketPath };
