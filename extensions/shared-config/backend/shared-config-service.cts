'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson } from '../../../backend/atomic-json-store.cjs';

const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_ENV_FILE_BYTES = 256 * 1024;
const MAX_ENV_KEYS = 1024;
const SHELL_TIMEOUT_MS = 5_000;
const SHELL_MAX_BUFFER = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_EXACT = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'NODE_OPTIONS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG_DIR', 'QODER_CONFIG_DIR', 'QWEN_HOME',
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);

type SharedEnvironmentFormat = 'dotenv' | 'shell';
type EnvironmentOverlay = { set: Record<string, string>; unset: string[]; ignoredNames?: string[] };

interface StoredSharedConfig {
  version: 1;
  revision: number;
  enabled: boolean;
  instructions: string;
  environment: null | {
    format: SharedEnvironmentFormat;
    path: string;
    canonicalPath?: string;
    trustedDigest?: string;
  };
  environmentSummary: { names: string[]; setCount: number; unsetCount: number; ignoredNames?: string[] };
  updatedAt: number;
}

interface SharedLaunchConfig {
  revision: number;
  instructions: string;
  environment: StoredSharedConfig['environment'];
  environmentOverlay?: EnvironmentOverlay;
}

class SharedConfigError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'SHARED_CONFIG_INVALID', status = 400) {
    super(message);
    this.name = 'SharedConfigError';
    this.code = code;
    this.status = status;
  }
}

function emptyConfig(): StoredSharedConfig {
  return {
    version: 1,
    revision: 0,
    enabled: false,
    instructions: '',
    environment: null,
    environmentSummary: { names: [], setCount: 0, unsetCount: 0, ignoredNames: [] },
    updatedAt: 0,
  };
}

function protectedEnvironmentName(name: string): boolean {
  return name.startsWith('FARMING_') || name.startsWith('DYLD_') || PROTECTED_EXACT.has(name);
}

function validateOverlay(overlay: EnvironmentOverlay, ignoreProtected = false): EnvironmentOverlay {
  const names = [...Object.keys(overlay.set), ...overlay.unset];
  if (names.length > MAX_ENV_KEYS) throw new SharedConfigError(`Environment file exceeds ${MAX_ENV_KEYS} variables`);
  const invalid = names.filter(name => !ENV_NAME.test(name));
  if (invalid.length) throw new SharedConfigError(`Invalid environment variable name: ${invalid[0]}`);
  const protectedNames = [...new Set(names.filter(protectedEnvironmentName))].sort();
  if (protectedNames.length) {
    if (ignoreProtected) {
      return {
        set: Object.fromEntries(Object.entries(overlay.set).filter(([name]) => !protectedEnvironmentName(name))),
        unset: overlay.unset.filter(name => !protectedEnvironmentName(name)),
        ignoredNames: protectedNames,
      };
    }
    throw new SharedConfigError(
      `Farming-owned environment variables cannot be changed: ${protectedNames.join(', ')}`,
      'SHARED_CONFIG_PROTECTED_ENV',
    );
  }
  return overlay;
}

function decodeDotenvValue(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (!value) return '';
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value.replace(/\s+#.*$/, '').trimEnd();
  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new SharedConfigError(`Unclosed quote on environment file line ${lineNumber}`);
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\(n|r|t|"|\\)/g, (_match, escape: string) => ({
    n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\',
  }[escape] || escape));
}

function parseDotenv(content: string): EnvironmentOverlay {
  const set: Record<string, string> = {};
  content.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((sourceLine, index) => {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) return;
    const assignment = line.replace(/^export\s+/, '');
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new SharedConfigError(`Invalid environment file line ${index + 1}`);
    const name = assignment.slice(0, separator).trim();
    if (!ENV_NAME.test(name)) throw new SharedConfigError(`Invalid environment variable name on line ${index + 1}`);
    set[name] = decodeDotenvValue(assignment.slice(separator + 1), index + 1);
  });
  return validateOverlay({ set, unset: [] });
}

function readEnvironmentFile(filePath: string): { canonicalPath: string; content: string } {
  let canonicalPath = '';
  try {
    canonicalPath = fs.realpathSync(filePath);
  } catch {
    throw new SharedConfigError('Environment file was not found', 'SHARED_CONFIG_ENV_NOT_FOUND');
  }
  const stat = fs.statSync(canonicalPath);
  if (!stat.isFile()) throw new SharedConfigError('Environment path must be a regular file');
  if (stat.size > MAX_ENV_FILE_BYTES) throw new SharedConfigError('Environment file is larger than 256 KiB');
  const content = fs.readFileSync(canonicalPath, 'utf8');
  if (content.includes('\0')) throw new SharedConfigError('Environment file contains unsupported NUL bytes');
  return {
    canonicalPath,
    content,
  };
}

function shellOverlay(
  file: ReturnType<typeof readEnvironmentFile>,
  baseEnv: NodeJS.ProcessEnv,
): EnvironmentOverlay {
  const beforeMarker = `__FARMING_SHARED_ENV_BEFORE_${crypto.randomUUID()}__`;
  const afterMarker = `__FARMING_SHARED_ENV_AFTER_${crypto.randomUUID()}__`;
  const shell = String(baseEnv.SHELL || process.env.SHELL || '/bin/bash');
  const script = [
    'printf "%s\\0" "$FARMING_SHARED_CONFIG_BEFORE_MARKER"',
    'env -0',
    '. "$FARMING_SHARED_CONFIG_SOURCE" >/dev/null 2>&1',
    'source_status=$?',
    '[ "$source_status" -eq 0 ] || exit "$source_status"',
    'printf "%s\\0" "$FARMING_SHARED_CONFIG_AFTER_MARKER"',
    'env -0',
  ].join(' && ');
  let output = Buffer.alloc(0);
  try {
    output = execFileSync(shell, ['-lc', script], {
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...baseEnv,
        FARMING_SHARED_CONFIG_SOURCE: file.canonicalPath,
        FARMING_SHARED_CONFIG_BEFORE_MARKER: beforeMarker,
        FARMING_SHARED_CONFIG_AFTER_MARKER: afterMarker,
      },
    });
  } catch (caught) {
    const error = caught as Error & { signal?: string };
    const timedOut = error.signal === 'SIGTERM';
    throw new SharedConfigError(timedOut
      ? 'Shell environment file validation timed out'
      : 'Shell environment file returned an error');
  }
  const fields = output.toString('utf8').split('\0');
  const beforeIndex = fields.indexOf(beforeMarker);
  const afterIndex = fields.indexOf(afterMarker);
  if (beforeIndex < 0 || afterIndex <= beforeIndex) {
    throw new SharedConfigError('Shell environment file did not produce a valid environment');
  }
  const parseFields = (values: string[]): Record<string, string> => Object.fromEntries(
    values.flatMap((value): Array<[string, string]> => {
      const separator = value.indexOf('=');
      return separator > 0 ? [[value.slice(0, separator), value.slice(separator + 1)]] : [];
    }),
  );
  const before = parseFields(fields.slice(beforeIndex + 1, afterIndex));
  const after = parseFields(fields.slice(afterIndex + 1));
  const internal = new Set([
    'FARMING_SHARED_CONFIG_SOURCE', 'FARMING_SHARED_CONFIG_BEFORE_MARKER',
    'FARMING_SHARED_CONFIG_AFTER_MARKER',
  ]);
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [name, value] of Object.entries(after)) {
    if (internal.has(name)) continue;
    if (before[name] !== value) set[name] = String(value);
  }
  for (const name of Object.keys(before)) {
    if (!internal.has(name) && !(name in after)) unset.push(name);
  }
  return validateOverlay({ set, unset }, true);
}

function resolveEnvironmentPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function summarizeOverlay(overlay: EnvironmentOverlay) {
  return {
    names: [...new Set([...Object.keys(overlay.set), ...overlay.unset])].sort(),
    setCount: Object.keys(overlay.set).length,
    unsetCount: overlay.unset.length,
    ignoredNames: overlay.ignoredNames || [],
  };
}

class SharedConfigService {
  private readonly file: string;

  constructor(options: { configDir: string }) {
    this.file = path.join(options.configDir, 'shared-agent-config.json');
  }

  private readStored(): StoredSharedConfig {
    if (!fs.existsSync(this.file)) return emptyConfig();
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new SharedConfigError('Shared configuration store is invalid', 'SHARED_CONFIG_STORE_INVALID', 500);
    }
    const item = value as Partial<StoredSharedConfig>;
    if (
      !item || item.version !== 1 || !Number.isInteger(item.revision) || typeof item.enabled !== 'boolean'
      || typeof item.instructions !== 'string' || !item.environmentSummary || !Number.isFinite(item.updatedAt)
      || (item.environment !== null && (
        !item.environment || !['dotenv', 'shell'].includes(item.environment.format)
        || typeof item.environment.path !== 'string'
      ))
    ) throw new SharedConfigError('Shared configuration store is invalid', 'SHARED_CONFIG_STORE_INVALID', 500);
    return item as StoredSharedConfig;
  }

  private inspect(config: StoredSharedConfig, baseEnv: NodeJS.ProcessEnv = process.env) {
    const emptySummary = { names: [] as string[], setCount: 0, unsetCount: 0, ignoredNames: [] as string[] };
    if (!config.enabled) return { status: 'disabled' as const, detail: '', environmentSummary: emptySummary };
    if (!config.environment) return { status: 'ready' as const, detail: '', environmentSummary: emptySummary };
    try {
      const file = readEnvironmentFile(resolveEnvironmentPath(config.environment.path));
      const overlay = config.environment.format === 'shell' ? shellOverlay(file, baseEnv) : parseDotenv(file.content);
      return { status: 'ready' as const, detail: '', environmentSummary: summarizeOverlay(overlay) };
    } catch (caught) {
      return {
        status: 'invalid' as const,
        detail: caught instanceof Error ? caught.message : 'Environment file is invalid',
        environmentSummary: emptySummary,
      };
    }
  }

  getState(baseEnv: NodeJS.ProcessEnv = process.env) {
    const config = this.readStored();
    const inspection = this.inspect(config, baseEnv);
    return {
      revision: config.revision,
      enabled: config.enabled,
      instructions: config.instructions,
      environment: config.environment ? { format: config.environment.format, path: config.environment.path } : null,
      environmentSummary: inspection.environmentSummary,
      updatedAt: config.updatedAt,
      status: inspection.status,
      detail: inspection.detail,
    };
  }

  save(bodyValue: unknown, baseEnv: NodeJS.ProcessEnv = process.env) {
    const body = bodyValue && typeof bodyValue === 'object' ? bodyValue as Record<string, unknown> : {};
    const current = this.readStored();
    if (body.expectedRevision !== current.revision) {
      throw new SharedConfigError('Shared configuration changed; reload and try again', 'SHARED_CONFIG_REVISION_CONFLICT', 409);
    }
    const enabled = body.enabled === true;
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES || instructions.includes('\0')) {
      throw new SharedConfigError('Additional system instructions must be valid text up to 32 KiB');
    }
    const environmentValue = body.environment && typeof body.environment === 'object'
      ? body.environment as Record<string, unknown>
      : {};
    const requestedPath = typeof environmentValue.path === 'string' ? environmentValue.path.trim() : '';
    if (
      requestedPath
      && environmentValue.format !== undefined
      && environmentValue.format !== 'dotenv'
      && environmentValue.format !== 'shell'
    ) {
      throw new SharedConfigError('Environment file format must be dotenv or shell');
    }
    const format = environmentValue.format === 'shell' ? 'shell' : 'dotenv';
    if (enabled && !instructions && !requestedPath) {
      throw new SharedConfigError('Add system instructions or an environment file before enabling shared configuration');
    }
    let environment: StoredSharedConfig['environment'] = null;
    let summary = { names: [] as string[], setCount: 0, unsetCount: 0, ignoredNames: [] as string[] };
    if (requestedPath) {
      const resolved = resolveEnvironmentPath(requestedPath);
      if (enabled) {
        const file = readEnvironmentFile(resolved);
        const overlay = format === 'shell' ? shellOverlay(file, baseEnv) : parseDotenv(file.content);
        summary = summarizeOverlay(overlay);
        environment = { format, path: requestedPath };
      } else {
        environment = { format, path: requestedPath };
      }
    }
    const next: StoredSharedConfig = {
      version: 1,
      revision: current.revision + 1,
      enabled,
      instructions,
      environment,
      environmentSummary: summary,
      updatedAt: Date.now(),
    };
    atomicWriteJson(this.file, next, { mode: 0o600, trailingNewline: true });
    try { fs.chmodSync(this.file, 0o600); } catch { /* The atomic create already requested owner-only mode. */ }
    return this.getState(baseEnv);
  }

  captureLaunchConfig(): SharedLaunchConfig {
    const config = this.readStored();
    return {
      revision: config.revision,
      instructions: config.enabled ? config.instructions : '',
      environment: config.enabled ? config.environment : null,
    };
  }

  applyEnvironment(baseEnv: NodeJS.ProcessEnv, launch: SharedLaunchConfig): NodeJS.ProcessEnv {
    if (!launch.environment) return { ...baseEnv };
    if (launch.environmentOverlay === undefined) {
      const file = readEnvironmentFile(resolveEnvironmentPath(launch.environment.path));
      launch.environmentOverlay = launch.environment.format === 'shell'
        ? shellOverlay(file, baseEnv)
        : parseDotenv(file.content);
    }
    const overlay = launch.environmentOverlay;
    const next = { ...baseEnv };
    for (const name of overlay.unset) delete next[name];
    Object.assign(next, overlay.set);
    return next;
  }
}

export {
  SharedConfigError,
  SharedConfigService,
  parseDotenv,
  protectedEnvironmentName,
  type SharedLaunchConfig,
};
