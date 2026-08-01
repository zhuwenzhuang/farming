'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_INSTANCE_FINGERPRINT_LENGTH = 16;

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
}

function canonicalConfigDir(configDir: string): string {
  if (typeof configDir !== 'string' || configDir.length === 0) {
    throw new Error('FARMING_CONFIG_DIR must be a non-empty path');
  }

  const absolutePath = path.resolve(configDir);
  const missingSegments: string[] = [];
  let candidate = absolutePath;

  while (true) {
    try {
      const existingAncestor = fs.realpathSync.native(candidate);
      return path.join(existingAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function configInstanceFingerprint(configDir: string): string {
  return crypto
    .createHash('sha256')
    .update('farming-config-instance-v1\0')
    .update(canonicalConfigDir(configDir))
    .digest('hex')
    .slice(0, CONFIG_INSTANCE_FINGERPRINT_LENGTH);
}

export {
  canonicalConfigDir,
  configInstanceFingerprint,
};
