/**
 * Managed language server launch behavior adapted from OpenCode.
 *
 * Upstream: https://github.com/anomalyco/opencode
 * Commit: 1882c33827cf0ce5c948b69ab5a87ed8f6790cf8
 * Copyright (c) 2025 OpenCode
 * Licensed under the MIT License.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ManagedLanguageServerClient,
  languageServerError,
  type LanguageServerRefreshKind,
} from './managed-language-server-client.cjs';
import {
  LANGUAGE_SERVERS,
  resolveLanguageServer,
  type LanguageServerDefinition,
} from './language-server-registry.cjs';

type JsonRecord = Record<string, unknown>;

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const JDTLS_VERSION = '1.60.0';
const LANGUAGE_SERVER_DOWNLOADS = {
  clangd: {
    darwin: {
      name: 'clangd-mac-22.1.6.zip',
      sha256: '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d',
      url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-mac-22.1.6.zip',
      version: '22.1.6',
    },
    linux: {
      name: 'clangd-linux-22.1.6.zip',
      sha256: 'a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa',
      url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip',
      version: '22.1.6',
    },
    win32: {
      name: 'clangd-windows-22.1.6.zip',
      sha256: 'ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1',
      url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip',
      version: '22.1.6',
    },
  },
  jdtls: {
    name: 'jdt-language-server-1.60.0-202606262232.tar.gz',
    sha256: 'e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d',
    url: 'https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz',
    version: JDTLS_VERSION,
  },
} as const;
const extractZip = require('extract-zip') as (source: string, options: { dir: string }) => Promise<void>;

type DownloadArtifact = {
  name: string;
  sha256: string;
  url: string;
  version: string;
};

interface DownloadFileOptions {
  fetchImpl?: typeof fetch;
}

interface ManagedClient {
  readonly id: string;
  readonly root: string;
  readonly workspaceRoot: string;
  execute(payload: JsonRecord): Promise<{ result: unknown; supported: boolean }>;
  ownsHierarchyHandle(itemId: string): boolean;
  dispose(): Promise<void>;
}

interface ManagedLanguageServerManagerOptions {
  configDir: string;
  definitions?: LanguageServerDefinition[];
  env?: NodeJS.ProcessEnv;
  onRefresh?: (event: ManagedLanguageServerRefreshEvent) => void;
  clientFactory?: (options: {
    id: string;
    command: string;
    args: string[];
    root: string;
    workspaceRoot: string;
    env?: NodeJS.ProcessEnv;
    onExit?: () => void;
    onRefresh?: (kind: LanguageServerRefreshKind) => void;
  }) => Promise<ManagedClient>;
}

interface ManagedLanguageServerRefreshEvent {
  kind: LanguageServerRefreshKind;
  workspaceRoot: string;
  revision: number;
}

interface LaunchCommand {
  command: string;
  args: string[];
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

function which(command: string, env: NodeJS.ProcessEnv): string {
  try {
    const program = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(program, [command], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      env,
    }).split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

async function downloadFile(
  url: string,
  target: string,
  expectedSha256: string,
  options: DownloadFileOptions = {},
): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      headers: { 'User-Agent': 'Farming-Language-Server' },
    });
    if (!response.ok || !response.body) {
      throw languageServerError(`Language Server download failed: HTTP ${response.status}`, 'LANGUAGE_SERVER_DOWNLOAD_FAILED');
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw languageServerError('Language Server download is too large', 'LANGUAGE_SERVER_DOWNLOAD_TOO_LARGE');
    }
    handle = await fs.promises.open(target, 'wx', 0o600);
    const sha256 = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_DOWNLOAD_BYTES) {
        throw languageServerError('Language Server download is too large', 'LANGUAGE_SERVER_DOWNLOAD_TOO_LARGE');
      }
      sha256.update(buffer);
      await handle.write(buffer);
    }
    await handle.close();
    handle = null;
    const actualSha256 = sha256.digest('hex');
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw languageServerError(
        `Language Server download integrity check failed (expected ${expectedSha256}, received ${actualSha256})`,
        'LANGUAGE_SERVER_INTEGRITY_FAILED',
      );
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

function cachedClangd(cacheRoot: string, version: string): string {
  const executableName = process.platform === 'win32' ? 'clangd.exe' : 'clangd';
  const candidate = path.join(cacheRoot, `clangd_${version}`, 'bin', executableName);
  return fs.existsSync(candidate) ? candidate : '';
}

function jdtlsLauncher(distPath: string): string {
  const plugins = path.join(distPath, 'plugins');
  try {
    const name = fs.readdirSync(plugins).find(entry => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(entry));
    return name ? path.join(plugins, name) : '';
  } catch {
    return '';
  }
}

function javaMajorVersion(java: string): number {
  const result = spawnSync(java, ['-version'], {
    encoding: 'utf8',
    timeout: 3_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/version\s+"(?:1\.)?(\d+)/i);
  return Number(match?.[1] || 0);
}

class ManagedLanguageServerManager {
  private readonly configDir: string;
  private readonly definitions: LanguageServerDefinition[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly clientFactory: NonNullable<ManagedLanguageServerManagerOptions['clientFactory']>;
  private readonly onRefresh: NonNullable<ManagedLanguageServerManagerOptions['onRefresh']>;
  private readonly clients = new Map<string, ManagedClient>();
  private readonly spawning = new Map<string, Promise<ManagedClient>>();
  private readonly preparing = new Map<string, Promise<string>>();
  private readonly refreshRevisions = new Map<string, number>();

  constructor(options: ManagedLanguageServerManagerOptions) {
    this.configDir = options.configDir;
    this.definitions = options.definitions || LANGUAGE_SERVERS;
    this.env = options.env || process.env;
    this.clientFactory = options.clientFactory || (value => ManagedLanguageServerClient.create(value));
    this.onRefresh = options.onRefresh || (() => {});
  }

  private emitRefresh(kind: LanguageServerRefreshKind, workspaceRoot: string): void {
    const key = `${workspaceRoot}\0${kind}`;
    const revision = (this.refreshRevisions.get(key) || 0) + 1;
    this.refreshRevisions.set(key, revision);
    this.onRefresh({ kind, workspaceRoot, revision });
  }

  refreshSnapshot(): ManagedLanguageServerRefreshEvent[] {
    const activeWorkspaces = new Set([...this.clients.values()].map(client => client.workspaceRoot));
    return [...this.refreshRevisions.entries()]
      .flatMap(([key, revision]) => {
        const separator = key.lastIndexOf('\0');
        const workspaceRoot = key.slice(0, separator);
        const kind = key.slice(separator + 1);
        if (
          separator < 0
          || !activeWorkspaces.has(workspaceRoot)
          || (kind !== 'semanticTokens' && kind !== 'inlayHints')
        ) return [];
        return [{ kind: kind as LanguageServerRefreshKind, workspaceRoot, revision }];
      })
      .sort((left, right) => (
        `${left.workspaceRoot}\0${left.kind}`.localeCompare(`${right.workspaceRoot}\0${right.kind}`)
      ));
  }

  capability() {
    const connections = [...this.clients.values()]
      .sort((left, right) => `${left.workspaceRoot}\0${left.id}\0${left.root}`.localeCompare(`${right.workspaceRoot}\0${right.id}\0${right.root}`))
      .map(client => ({
        id: client.id,
        root: pathToFileURL(client.root).toString(),
        workspace: pathToFileURL(client.workspaceRoot).toString(),
      }));
    const workspaces = [...new Set(connections.map(connection => connection.workspace))];
    const active = connections.length > 0;
    return {
      status: active ? 'connected' as const : 'ready' as const,
      source: 'managed' as const,
      detail: active
        ? `${this.definitions.length} built-in language definitions · ${connections.length} active server${connections.length === 1 ? '' : 's'} · ${workspaces.length} project${workspaces.length === 1 ? '' : 's'}`
        : `${this.definitions.length} built-in language definitions · servers start on demand`,
      vscodeVersion: '',
      features: [
        'hover', 'definition', 'references', 'implementation', 'documentSymbols',
        'workspaceSymbols', 'callHierarchy', 'typeHierarchy', 'diagnostics',
        'documentHighlights', 'semanticTokens', 'inlayHints',
      ],
      workspaces,
      connections,
    };
  }

  private cacheRoot(id: string): string {
    return path.join(this.configDir, 'language-servers', id);
  }

  private prepareOnce(key: string, operation: () => Promise<string>): Promise<string> {
    const active = this.preparing.get(key);
    if (active) return active;
    const task = operation().finally(() => {
      if (this.preparing.get(key) === task) this.preparing.delete(key);
    });
    this.preparing.set(key, task);
    return task;
  }

  private async prepareClangd(): Promise<string> {
    return this.prepareOnce('clangd', async () => {
      const artifact = LANGUAGE_SERVER_DOWNLOADS.clangd[
        process.platform as keyof typeof LANGUAGE_SERVER_DOWNLOADS.clangd
      ] as DownloadArtifact | undefined;
      if (!artifact) return '';
      const cacheRoot = this.cacheRoot('clangd');
      const cached = cachedClangd(cacheRoot, artifact.version);
      if (cached) return cached;

      await fs.promises.mkdir(cacheRoot, { recursive: true });
      const tempRoot = await fs.promises.mkdtemp(path.join(cacheRoot, '.prepare-'));
      try {
        const archive = path.join(tempRoot, artifact.name);
        const extractRoot = path.join(tempRoot, 'extract');
        await fs.promises.mkdir(extractRoot);
        await downloadFile(artifact.url, archive, artifact.sha256);
        await extractZip(archive, { dir: extractRoot });
        const source = path.join(extractRoot, `clangd_${artifact.version}`);
        const finalPath = path.join(cacheRoot, `clangd_${artifact.version}`);
        if (!fs.existsSync(source)) return '';
        if (!fs.existsSync(finalPath)) await fs.promises.rename(source, finalPath);
        const executable = cachedClangd(cacheRoot, artifact.version);
        if (executable && process.platform !== 'win32') await fs.promises.chmod(executable, 0o755);
        return executable;
      } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      }
    });
  }

  private async prepareJdtls(): Promise<string> {
    return this.prepareOnce('jdtls', async () => {
      const artifact: DownloadArtifact = LANGUAGE_SERVER_DOWNLOADS.jdtls;
      const cacheRoot = this.cacheRoot('jdtls');
      const current = path.join(cacheRoot, artifact.version);
      if (jdtlsLauncher(current)) return current;
      await fs.promises.mkdir(cacheRoot, { recursive: true });
      const tempRoot = await fs.promises.mkdtemp(path.join(cacheRoot, '.prepare-'));
      try {
        const archive = path.join(tempRoot, artifact.name);
        const extractRoot = path.join(tempRoot, 'extract');
        await fs.promises.mkdir(extractRoot);
        await downloadFile(artifact.url, archive, artifact.sha256);
        await execFileAsync('tar', ['-xzf', archive, '-C', extractRoot], { timeout: 120_000 });
        if (!jdtlsLauncher(extractRoot)) return '';
        if (!fs.existsSync(current)) await fs.promises.rename(extractRoot, current);
        return current;
      } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      }
    });
  }

  private async launchCommand(definition: LanguageServerDefinition, root: string): Promise<LaunchCommand> {
    const [command, ...args] = definition.command;
    const fromPath = which(command, this.env);
    if (fromPath && definition.id !== 'jdtls') return { command: fromPath, args };

    if (definition.id === 'clangd') {
      const managed = await this.prepareClangd();
      if (managed) return { command: managed, args };
    }
    if (definition.id === 'jdtls') {
      const workspaceHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
      const dataDir = path.join(this.configDir, 'language-server-workspaces', workspaceHash, 'java');
      await fs.promises.mkdir(dataDir, { recursive: true });
      if (fromPath) return { command: fromPath, args: ['-data', dataDir] };
      const java = which('java', this.env);
      if (!java || javaMajorVersion(java) < 21) {
        throw languageServerError('Java 21 or newer is required to run JDTLS', 'LANGUAGE_SERVER_JAVA_UNAVAILABLE', 503);
      }
      const distPath = await this.prepareJdtls();
      const launcher = jdtlsLauncher(distPath);
      if (launcher) {
        const platformConfig = process.platform === 'darwin' ? 'config_mac' : process.platform === 'win32' ? 'config_win' : 'config_linux';
        return {
          command: java,
          args: [
            '-jar', launcher,
            '-configuration', path.join(distPath, platformConfig),
            '-data', dataDir,
            '-Declipse.application=org.eclipse.jdt.ls.core.id1',
            '-Dosgi.bundles.defaultStartLevel=4',
            '-Declipse.product=org.eclipse.jdt.ls.core.product',
            '--add-modules=ALL-SYSTEM',
            '--add-opens', 'java.base/java.util=ALL-UNNAMED',
            '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          ],
        };
      }
    }
    throw languageServerError(
      `${definition.id} command was not found: ${command}`,
      'LANGUAGE_SERVER_RUNTIME_UNAVAILABLE',
      503,
    );
  }

  private async ensureClient(
    definition: LanguageServerDefinition,
    root: string,
    workspaceRoot: string,
  ): Promise<ManagedClient> {
    const key = `${definition.id}\0${root}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    const active = this.spawning.get(key);
    if (active) return active;
    const task = (async () => {
      const launch = await this.launchCommand(definition, root);
      let created: ManagedClient | null = null;
      const client = await this.clientFactory({
        id: definition.id,
        command: launch.command,
        args: launch.args,
        root,
        workspaceRoot,
        env: this.env,
        onExit: () => {
          if (created && this.clients.get(key) === created) this.clients.delete(key);
        },
        onRefresh: kind => this.emitRefresh(kind, workspaceRoot),
      });
      created = client;
      const raced = this.clients.get(key);
      if (raced) {
        await client.dispose();
        return raced;
      }
      this.clients.set(key, client);
      return client;
    })().finally(() => {
      if (this.spawning.get(key) === task) this.spawning.delete(key);
    });
    this.spawning.set(key, task);
    return task;
  }

  async request(body: unknown): Promise<{ result: unknown; supported: boolean }> {
    const payload = recordValue(body);
    const workspaceUri = String(payload.workspace || '');
    let workspaceRoot = '';
    try {
      workspaceRoot = fileURLToPath(workspaceUri);
    } catch {
      throw languageServerError('Managed Language Server requires a Project workspace', 'LANGUAGE_SERVER_WORKSPACE_INVALID', 400);
    }
    const method = String(payload.method || '');
    const itemId = String(payload.itemId || '');
    if (itemId) {
      const client = [...this.clients.values()].find(value => value.ownsHierarchyHandle(itemId));
      if (!client) throw languageServerError('Language Server hierarchy item expired', 'LANGUAGE_SERVER_HIERARCHY_ITEM_EXPIRED', 410);
      return client.execute(payload);
    }
    if (method === 'workspaceSymbols') {
      const uri = String(payload.uri || '');
      if (uri) {
        let filePath = '';
        try {
          filePath = fileURLToPath(uri);
        } catch {
          throw languageServerError('Managed Language Server requires a file', 'LANGUAGE_SERVER_FILE_REQUIRED', 400);
        }
        const resolved = await resolveLanguageServer(filePath, workspaceRoot, this.definitions);
        if (resolved) await this.ensureClient(resolved.definition, resolved.root, workspaceRoot);
      }
      const clients = [...this.clients.values()].filter(value => value.workspaceRoot === workspaceRoot);
      if (clients.length === 0) {
        throw languageServerError(
          'No managed Language Server is running for this Project',
          'LANGUAGE_SERVER_NOT_CONFIGURED',
          503,
        );
      }
      const results = await Promise.all(clients.map(client => client.execute(payload)));
      return { result: results.flatMap(value => Array.isArray(value.result) ? value.result : []), supported: true };
    }

    const uri = String(payload.uri || '');
    let filePath = '';
    try {
      filePath = fileURLToPath(uri);
    } catch {
      throw languageServerError('Managed Language Server requires a file', 'LANGUAGE_SERVER_FILE_REQUIRED', 400);
    }
    const resolved = await resolveLanguageServer(filePath, workspaceRoot, this.definitions);
    if (!resolved) {
      throw languageServerError('No managed Language Server supports this file', 'LANGUAGE_SERVER_NOT_CONFIGURED', 503);
    }
    const client = await this.ensureClient(resolved.definition, resolved.root, workspaceRoot);
    return client.execute({ ...payload, filePath });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map(client => client.dispose()));
    this.clients.clear();
    this.spawning.clear();
    this.refreshRevisions.clear();
  }
}

export {
  LANGUAGE_SERVER_DOWNLOADS,
  ManagedLanguageServerManager,
  downloadFile,
  type ManagedLanguageServerRefreshEvent,
  type ManagedLanguageServerManagerOptions,
};
