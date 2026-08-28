'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ACP_RUNTIME_HOST_PROTOCOL_VERSION = 2;
const ACP_RUNTIME_HOST_RUNTIME_FILES = Object.freeze([
  'acp-checkpoint-store.cjs',
  'acp-runtime.cjs',
  'acp-runtime-host-client.cjs',
  'acp-runtime-host-controller.cjs',
  'acp-runtime-host-identity.cjs',
  'acp-runtime-host-path.cjs',
  'acp-runtime-host-process.cjs',
  'acp-runtime-host-runtime.cjs',
  'acp-runtime-host-service.cjs',
  'acp-runtime-host-state.cjs',
  'acp-transcript.cjs',
  'acp-turn-summary.cjs',
  'codex-transcript-sanitizer.cjs',
]);

interface AcpRuntimeHostIdentity {
  protocolVersion: number;
  buildId: string;
  version: string;
}

const identityCache = new Map<string, Readonly<AcpRuntimeHostIdentity>>();

function read(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    return Buffer.from(`missing:${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageVersion(backendDir: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(backendDir, '..', 'package.json'), 'utf8'));
    return typeof value.version === 'string' ? value.version : '';
  } catch {
    return '';
  }
}

function computeAcpRuntimeHostIdentity(backendDir: string): Readonly<AcpRuntimeHostIdentity> {
  const cacheKey = path.resolve(backendDir);
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;
  const version = packageVersion(backendDir);
  const injectedBuildId = String(process.env.FARMING_ACP_RUNTIME_HOST_BUILD_ID || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(injectedBuildId)) {
    const identity = Object.freeze({
      protocolVersion: ACP_RUNTIME_HOST_PROTOCOL_VERSION,
      buildId: injectedBuildId,
      version,
    });
    identityCache.set(cacheKey, identity);
    return identity;
  }
  const hash = crypto.createHash('sha256');
  hash.update(`protocol:${ACP_RUNTIME_HOST_PROTOCOL_VERSION}\nversion:${version}\n`);
  for (const filename of ACP_RUNTIME_HOST_RUNTIME_FILES) {
    hash.update(`file:${filename}\n`);
    hash.update(read(path.join(backendDir, filename)));
    hash.update('\n');
  }
  const identity = Object.freeze({
    protocolVersion: ACP_RUNTIME_HOST_PROTOCOL_VERSION,
    buildId: hash.digest('hex'),
    version,
  });
  identityCache.set(cacheKey, identity);
  return identity;
}

const DEFAULT_ACP_RUNTIME_HOST_IDENTITY = computeAcpRuntimeHostIdentity(__dirname);

function acpRuntimeHostIdentity(backendDir = __dirname): Readonly<AcpRuntimeHostIdentity> {
  if (path.resolve(backendDir) === path.resolve(__dirname)) return DEFAULT_ACP_RUNTIME_HOST_IDENTITY;
  return computeAcpRuntimeHostIdentity(backendDir);
}

function normalizeAcpRuntimeHostIdentity(value: unknown): AcpRuntimeHostIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const protocolVersion = Number(candidate.protocolVersion);
  const buildId = String(candidate.buildId || '').toLowerCase();
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0 || !/^[a-f0-9]{64}$/.test(buildId)) {
    return null;
  }
  return {
    protocolVersion,
    buildId,
    version: String(candidate.version || ''),
  };
}

export {
  ACP_RUNTIME_HOST_PROTOCOL_VERSION,
  acpRuntimeHostIdentity,
  normalizeAcpRuntimeHostIdentity,
};
