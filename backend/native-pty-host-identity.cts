'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const NATIVE_PTY_HOST_PROTOCOL_VERSION = 8;
const NATIVE_PTY_HOST_RUNTIME_FILES = Object.freeze([
  'agent-env.cjs',
  'input-parts.cjs',
  'local-session-engine.js',
  'native-pty-host.js',
  'shell-busy-integration.cjs',
  'storage-layout.cjs',
  'terminal-screen-worker-pool.cjs',
  'terminal-screen-worker-thread.cjs',
  'terminal-screen-worker.cjs',
  'terminal-screen-state.cjs',
  'terminal-reducer-flow-control.cjs',
  'terminal-state-serialization.cjs',
  'native-pty-controller-generation.cjs',
  'terminal-exit-quiescence.cjs',
  'terminal-status.cjs',
]);

interface NativePtyHostRuntimeIdentity {
  protocolVersion: number;
  buildId: string;
  version: string;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown';
}

function readFileForIdentity(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    return Buffer.from(`missing:${errorCode(error)}`, 'utf8');
  }
}

function packageVersion(backendDir: string): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(backendDir, '..', 'package.json'), 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '';
  } catch {
    return '';
  }
}

function nativePtyHostRuntimeIdentity(
  backendDir = __dirname,
): Readonly<NativePtyHostRuntimeIdentity> {
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

function normalizeNativePtyHostRuntimeIdentity(value: unknown): NativePtyHostRuntimeIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const protocolVersion = Number(candidate.protocolVersion);
  const buildId = typeof candidate.buildId === 'string' ? candidate.buildId.trim() : '';
  if (!Number.isInteger(protocolVersion) || protocolVersion <= 0 || !/^[a-f0-9]{64}$/i.test(buildId)) {
    return null;
  }
  return {
    protocolVersion,
    buildId: buildId.toLowerCase(),
    version: typeof candidate.version === 'string' ? candidate.version : '',
  };
}

function nativePtyHostRuntimeIdentityMatches(expected: unknown, actual: unknown): boolean {
  const normalizedExpected = normalizeNativePtyHostRuntimeIdentity(expected);
  const normalizedActual = normalizeNativePtyHostRuntimeIdentity(actual);
  return Boolean(
    normalizedExpected &&
    normalizedActual &&
    normalizedExpected.protocolVersion === normalizedActual.protocolVersion &&
    normalizedExpected.buildId === normalizedActual.buildId
  );
}

export {
  NATIVE_PTY_HOST_PROTOCOL_VERSION,
  NATIVE_PTY_HOST_RUNTIME_FILES,
  nativePtyHostRuntimeIdentity,
  nativePtyHostRuntimeIdentityMatches,
  normalizeNativePtyHostRuntimeIdentity,
};
