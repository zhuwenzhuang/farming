/**
 * LSP client behavior adapted from OpenCode.
 *
 * Upstream: https://github.com/anomalyco/opencode
 * Commit: 1882c33827cf0ce5c948b69ab5a87ed8f6790cf8
 * Copyright (c) 2025 OpenCode
 * Licensed under the MIT License.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

const INITIALIZE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_WAIT_MS = 2_000;
const SEMANTIC_TOKENS_LEGEND_WAIT_MS = 500;
const MAX_HIERARCHY_HANDLES = 2_048;
const MAX_DOCUMENT_HIGHLIGHTS = 20_000;
const MAX_INLAY_HINTS = 10_000;
const MAX_SEMANTIC_TOKEN_INTEGERS = 1_000_000;
const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
  'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp',
  'operator', 'decorator', 'annotationMember', 'record', 'recordComponent',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
];

type JsonRecord = Record<string, unknown>;

interface ManagedLanguageServerClientOptions {
  id: string;
  command: string;
  args: string[];
  root: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  onExit?: () => void;
  onRefresh?: (kind: LanguageServerRefreshKind) => void;
}

type LanguageServerRefreshKind = 'semanticTokens' | 'inlayHints';

interface OpenDocument {
  signature: string;
  version: number;
}

interface DiagnosticSnapshot {
  revision: number;
  items: unknown[];
}

interface HierarchyHandle {
  kind: 'call' | 'type';
  item: JsonRecord;
}

interface DynamicRegistration {
  method: string;
  registerOptions: JsonRecord;
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

function languageServerError(message: string, code: string, status = 502): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = code;
  error.status = status;
  return error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(languageServerError(message, 'LANGUAGE_SERVER_REQUEST_TIMEOUT', 504)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function languageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const values: Record<string, string> = {
    '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.go': 'go', '.rs': 'rust',
    '.py': 'python', '.pyi': 'python', '.js': 'javascript', '.jsx': 'javascriptreact',
    '.ts': 'typescript', '.tsx': 'typescriptreact', '.vue': 'vue', '.svelte': 'svelte',
    '.cs': 'csharp', '.fs': 'fsharp', '.swift': 'swift', '.rb': 'ruby', '.php': 'php',
    '.lua': 'lua', '.dart': 'dart', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shellscript',
    '.tf': 'terraform', '.tex': 'latex', '.nix': 'nix', '.hs': 'haskell', '.jl': 'julia',
  };
  return values[extension] || extension.replace(/^\./, '') || 'plaintext';
}

function hoverContents(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap(item => {
    if (typeof item === 'string') return [item];
    const record = recordValue(item);
    if (typeof record.value === 'string') {
      if (typeof record.language === 'string') return [`\`\`\`${record.language}\n${record.value}\n\`\`\``];
      return [record.value];
    }
    return [];
  });
}

function normalizeLocations(value: unknown): unknown[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(item => {
    const record = recordValue(item);
    if (typeof record.targetUri === 'string') {
      return {
        uri: record.targetUri,
        range: record.targetRange || record.targetSelectionRange || null,
        selectionRange: record.targetSelectionRange || record.targetRange || null,
        originSelectionRange: record.originSelectionRange || null,
      };
    }
    return record;
  });
}

function normalizeWorkspaceSymbols(value: unknown): JsonRecord[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.flatMap(item => {
    const symbol = recordValue(item);
    const location = recordValue(symbol.location);
    const uri = typeof location.uri === 'string'
      ? location.uri
      : typeof symbol.uri === 'string' ? symbol.uri : '';
    if (!uri) return [];
    const range = location.range || symbol.range || null;
    return [{
      name: String(symbol.name || ''),
      detail: String(symbol.detail || symbol.containerName || ''),
      kind: Number(symbol.kind || 0),
      uri,
      range,
      selectionRange: symbol.selectionRange || range,
    }];
  });
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  const items = Array.isArray(value) ? value : [];
  if (items.length > maximum) {
    throw languageServerError(
      `${label} result is too large`,
      'LANGUAGE_SERVER_RESULT_TOO_LARGE',
      413,
    );
  }
  return items;
}

function normalizeSemanticTokenData(value: unknown): number[] {
  const data = boundedArray(value, MAX_SEMANTIC_TOKEN_INTEGERS, 'Semantic Tokens');
  if (data.length % 5 !== 0 || data.some(item => !Number.isInteger(item) || Number(item) < 0 || Number(item) > 0xffffffff)) {
    throw languageServerError('Language Server returned invalid Semantic Tokens', 'LANGUAGE_SERVER_RESULT_INVALID');
  }
  return data.map(Number);
}

class ManagedLanguageServerClient {
  readonly id: string;
  readonly root: string;
  readonly workspaceRoot: string;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, DiagnosticSnapshot>();
  private readonly providerRefreshDocumentVersions = new Map<string, number>();
  private readonly diagnosticWaiters = new Map<string, Set<() => void>>();
  private readonly hierarchyHandles = new Map<string, HierarchyHandle>();
  private readonly dynamicRegistrations = new Map<string, DynamicRegistration>();
  private readonly semanticLegendWaiters = new Set<() => void>();
  private serverCapabilities: JsonRecord = {};
  private disposed = false;
  private serviceReadyProviderRefreshSent = false;
  private diagnosticRevision = 0;
  private readonly onExit: () => void;
  private readonly onRefresh: (kind: LanguageServerRefreshKind) => void;

  private constructor(options: ManagedLanguageServerClientOptions) {
    this.id = options.id;
    this.root = options.root;
    this.workspaceRoot = options.workspaceRoot;
    this.onExit = options.onExit || (() => {});
    this.onRefresh = options.onRefresh || (() => {});
    this.process = spawn(options.command, options.args, {
      cwd: options.root,
      env: options.env || process.env,
      stdio: 'pipe',
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.onRequest('workspace/configuration', (params: unknown) => {
      const items = recordValue(params).items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });
    this.connection.onRequest('client/registerCapability', (params: unknown) => {
      const registrations = recordValue(params).registrations;
      if (Array.isArray(registrations)) {
        for (const value of registrations) {
          const registration = recordValue(value);
          const id = String(registration.id || '');
          const method = String(registration.method || '');
          if (!id || !method) continue;
          this.dynamicRegistrations.set(id, {
            method,
            registerOptions: recordValue(registration.registerOptions),
          });
        }
        this.resolveSemanticLegendWaiters();
      }
      return null;
    });
    this.connection.onRequest('client/unregisterCapability', (params: unknown) => {
      const source = recordValue(params);
      const registrations = source.unregisterations || source.unregistrations;
      if (Array.isArray(registrations)) {
        for (const value of registrations) {
          const id = String(recordValue(value).id || '');
          if (id) this.dynamicRegistrations.delete(id);
        }
      }
      return null;
    });
    this.connection.onRequest('window/workDoneProgress/create', () => null);
    this.connection.onRequest('workspace/workspaceFolders', () => [this.workspaceFolder()]);
    this.connection.onRequest('workspace/semanticTokens/refresh', () => {
      this.emitProviderRefresh('semanticTokens');
      return null;
    });
    this.connection.onRequest('workspace/inlayHint/refresh', () => {
      this.emitProviderRefresh('inlayHints');
      return null;
    });
    this.connection.onNotification('workspace/semanticTokens/refresh', () => {
      this.emitProviderRefresh('semanticTokens');
    });
    this.connection.onNotification('workspace/inlayHint/refresh', () => {
      this.emitProviderRefresh('inlayHints');
    });
    this.connection.onNotification('language/status', (params: unknown) => {
      if (
        String(recordValue(params).type || '') !== 'ServiceReady'
        || this.serviceReadyProviderRefreshSent
      ) return;
      this.serviceReadyProviderRefreshSent = true;
      this.emitProviderRefresh('semanticTokens');
      this.emitProviderRefresh('inlayHints');
    });
    this.connection.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
      const record = recordValue(params);
      const uri = String(record.uri || '');
      if (!uri) return;
      this.diagnostics.set(uri, {
        revision: this.diagnosticRevision += 1,
        items: Array.isArray(record.diagnostics) ? record.diagnostics : [],
      });
      const waiters = this.diagnosticWaiters.get(uri);
      if (waiters) [...waiters].forEach(resolve => resolve());
      const documentVersion = this.documents.get(uri)?.version;
      if (
        documentVersion !== undefined
        && this.providerRefreshDocumentVersions.get(uri) !== documentVersion
      ) {
        this.providerRefreshDocumentVersions.set(uri, documentVersion);
        this.emitProviderRefresh('semanticTokens');
        this.emitProviderRefresh('inlayHints');
      }
    });
    this.process.once('exit', () => {
      this.disposed = true;
      this.connection.dispose();
      this.onExit();
      for (const waiters of this.diagnosticWaiters.values()) [...waiters].forEach(resolve => resolve());
      this.diagnosticWaiters.clear();
      for (const resolve of this.semanticLegendWaiters) resolve();
      this.semanticLegendWaiters.clear();
    });
    this.connection.listen();
  }

  static async create(options: ManagedLanguageServerClientOptions): Promise<ManagedLanguageServerClient> {
    const client = new ManagedLanguageServerClient(options);
    await new Promise<void>((resolve, reject) => {
      client.process.once('spawn', resolve);
      client.process.once('error', reject);
    }).catch(error => {
      throw languageServerError(
        `${options.id} failed to start: ${error instanceof Error ? error.message : String(error)}`,
        'LANGUAGE_SERVER_START_FAILED',
      );
    });
    try {
      const initializeResult = recordValue(await withTimeout(client.connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(options.root).toString(),
        workspaceFolders: [client.workspaceFolder()],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            hover: {},
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            documentHighlight: { dynamicRegistration: true },
            semanticTokens: {
              dynamicRegistration: true,
              requests: { range: false, full: { delta: false } },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
              serverCancelSupport: true,
              augmentsSyntaxTokens: true,
            },
            inlayHint: { dynamicRegistration: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {},
            typeHierarchy: {},
            publishDiagnostics: {},
          },
          workspace: {
            symbol: {},
            configuration: true,
            workspaceFolders: true,
            semanticTokens: { refreshSupport: true },
            inlayHint: { refreshSupport: true },
          },
        },
      }), INITIALIZE_TIMEOUT_MS, `${options.id} initialization timed out`));
      client.serverCapabilities = recordValue(initializeResult.capabilities);
      client.connection.sendNotification('initialized', {});
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }

  private workspaceFolder() {
    return {
      uri: pathToFileURL(this.root).toString(),
      name: path.basename(this.root) || this.id,
    };
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw languageServerError(`${this.id} is not running`, 'LANGUAGE_SERVER_PROCESS_EXITED', 503);
    }
  }

  private resolveSemanticLegendWaiters(): void {
    if (!this.semanticTokensLegend()) return;
    for (const resolve of this.semanticLegendWaiters) resolve();
    this.semanticLegendWaiters.clear();
  }

  private emitProviderRefresh(kind: LanguageServerRefreshKind): void {
    this.onRefresh(kind);
  }

  private semanticTokensLegend(): { tokenTypes: string[]; tokenModifiers: string[] } | null {
    const dynamic = [...this.dynamicRegistrations.values()]
      .reverse()
      .find(registration => registration.method === 'textDocument/semanticTokens');
    const provider = dynamic?.registerOptions || recordValue(this.serverCapabilities.semanticTokensProvider);
    const legend = recordValue(provider.legend);
    const tokenTypes = Array.isArray(legend.tokenTypes)
      ? legend.tokenTypes.filter(value => typeof value === 'string') as string[]
      : [];
    const tokenModifiers = Array.isArray(legend.tokenModifiers)
      ? legend.tokenModifiers.filter(value => typeof value === 'string') as string[]
      : [];
    return tokenTypes.length > 0 ? { tokenTypes, tokenModifiers } : null;
  }

  private async waitForSemanticTokensLegend(): Promise<{ tokenTypes: string[]; tokenModifiers: string[] } | null> {
    const current = this.semanticTokensLegend();
    if (current) return current;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.semanticLegendWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, SEMANTIC_TOKENS_LEGEND_WAIT_MS);
      this.semanticLegendWaiters.add(finish);
    });
    return this.semanticTokensLegend();
  }

  private async ensureDocument(filePath: string): Promise<string> {
    this.ensureActive();
    const [text, stat] = await Promise.all([
      fs.promises.readFile(filePath, 'utf8'),
      fs.promises.stat(filePath),
    ]);
    const uri = pathToFileURL(filePath).toString();
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const current = this.documents.get(uri);
    if (!current) {
      this.documents.set(uri, { signature, version: 1 });
      this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: languageId(filePath), version: 1, text },
      });
    } else if (current.signature !== signature) {
      const version = current.version + 1;
      this.documents.set(uri, { signature, version });
      this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.ensureActive();
    try {
      return await withTimeout(
        this.connection.sendRequest(method, params),
        REQUEST_TIMEOUT_MS,
        `${this.id} request timed out`,
      );
    } catch (error) {
      const value = recordValue(error);
      if (Number(value.code) === -32601) {
        throw languageServerError(`${this.id} does not support ${method}`, 'LANGUAGE_SERVER_METHOD_UNSUPPORTED', 400);
      }
      throw error;
    }
  }

  private hierarchyItem(item: unknown, kind: 'call' | 'type'): JsonRecord {
    const source = recordValue(item);
    const id = crypto.randomUUID();
    this.hierarchyHandles.set(id, { kind, item: source });
    while (this.hierarchyHandles.size > MAX_HIERARCHY_HANDLES) {
      const oldest = this.hierarchyHandles.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.hierarchyHandles.delete(oldest);
    }
    return {
      ...source,
      id,
      detail: String(source.detail || ''),
    };
  }

  ownsHierarchyHandle(itemId: string): boolean {
    return this.hierarchyHandles.has(itemId);
  }

  private async waitForDiagnostics(uri: string, afterRevision: number): Promise<unknown[]> {
    const current = this.diagnostics.get(uri);
    if (current && current.revision > afterRevision) return current.items;
    await new Promise<void>(resolve => {
      const waiters = this.diagnosticWaiters.get(uri) || new Set<() => void>();
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.diagnosticWaiters.delete(uri);
        resolve();
      };
      const timer = setTimeout(finish, DIAGNOSTICS_WAIT_MS);
      waiters.add(finish);
      this.diagnosticWaiters.set(uri, waiters);
    });
    return this.diagnostics.get(uri)?.items || [];
  }

  async execute(payload: JsonRecord): Promise<{ result: unknown; supported: boolean }> {
    const method = String(payload.method || '');
    const uri = typeof payload.uri === 'string' ? payload.uri : '';
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
    const position = payload.position;
    const documentUri = filePath ? await this.ensureDocument(filePath) : uri;

    if (method === 'hover') {
      const value = recordValue(await this.request('textDocument/hover', { textDocument: { uri: documentUri }, position }));
      if (!Object.keys(value).length) return { result: [], supported: true };
      return { result: [{ contents: hoverContents(value.contents), ...(value.range ? { range: value.range } : {}) }], supported: true };
    }
    if (method === 'definition' || method === 'implementation') {
      const rpcMethod = method === 'definition' ? 'textDocument/definition' : 'textDocument/implementation';
      return { result: normalizeLocations(await this.request(rpcMethod, { textDocument: { uri: documentUri }, position })), supported: true };
    }
    if (method === 'references') {
      return {
        result: normalizeLocations(await this.request('textDocument/references', {
          textDocument: { uri: documentUri }, position, context: { includeDeclaration: true },
        })),
        supported: true,
      };
    }
    if (method === 'documentHighlights') {
      return {
        result: boundedArray(await this.request('textDocument/documentHighlight', {
          textDocument: { uri: documentUri }, position,
        }), MAX_DOCUMENT_HIGHLIGHTS, 'Document Highlight'),
        supported: true,
      };
    }
    if (method === 'semanticTokens') {
      const value = recordValue(await this.request('textDocument/semanticTokens/full', {
        textDocument: { uri: documentUri },
      }));
      const legend = await this.waitForSemanticTokensLegend();
      if (!legend) {
        throw languageServerError('Language Server did not provide a Semantic Tokens legend', 'LANGUAGE_SERVER_RESULT_INVALID');
      }
      return {
        result: {
          data: normalizeSemanticTokenData(value.data),
          ...(typeof value.resultId === 'string' ? { resultId: value.resultId } : {}),
          legend,
        },
        supported: true,
      };
    }
    if (method === 'inlayHints') {
      return {
        result: boundedArray(await this.request('textDocument/inlayHint', {
          textDocument: { uri: documentUri }, range: payload.range,
        }), MAX_INLAY_HINTS, 'Inlay Hints'),
        supported: true,
      };
    }
    if (method === 'documentSymbols') {
      return { result: await this.request('textDocument/documentSymbol', { textDocument: { uri: documentUri } }) || [], supported: true };
    }
    if (method === 'workspaceSymbols') {
      return {
        result: normalizeWorkspaceSymbols(await this.request('workspace/symbol', { query: String(payload.query || '') })),
        supported: true,
      };
    }
    if (method === 'diagnostics') {
      const before = this.diagnostics.get(documentUri)?.revision || 0;
      return {
        result: (await this.waitForDiagnostics(documentUri, before)).map(item => {
          const diagnostic = recordValue(item);
          return {
            ...diagnostic,
            severity: Math.max(0, Math.min(3, Number(diagnostic.severity || 3) - 1)),
          };
        }),
        supported: true,
      };
    }
    if (method === 'prepareCallHierarchy' || method === 'prepareTypeHierarchy') {
      const kind = method === 'prepareCallHierarchy' ? 'call' : 'type';
      const rpcMethod = kind === 'call' ? 'textDocument/prepareCallHierarchy' : 'textDocument/prepareTypeHierarchy';
      const result = await this.request(rpcMethod, { textDocument: { uri: documentUri }, position });
      const items = Array.isArray(result) ? result : result ? [result] : [];
      return { result: items.map(item => this.hierarchyItem(item, kind)), supported: true };
    }
    if (['incomingCalls', 'outgoingCalls', 'supertypes', 'subtypes'].includes(method)) {
      const handle = this.hierarchyHandles.get(String(payload.itemId || ''));
      if (!handle) {
        throw languageServerError('Language Server hierarchy item expired', 'LANGUAGE_SERVER_HIERARCHY_ITEM_EXPIRED', 410);
      }
      const rpcMethods: Record<string, string> = {
        incomingCalls: 'callHierarchy/incomingCalls',
        outgoingCalls: 'callHierarchy/outgoingCalls',
        supertypes: 'typeHierarchy/supertypes',
        subtypes: 'typeHierarchy/subtypes',
      };
      const result = await this.request(rpcMethods[method], { item: handle.item });
      const items = Array.isArray(result) ? result : [];
      if (method === 'incomingCalls' || method === 'outgoingCalls') {
        const itemKey = method === 'incomingCalls' ? 'from' : 'to';
        return {
          result: items.map(value => {
            const record = recordValue(value);
            return { item: this.hierarchyItem(record[itemKey], 'call'), ranges: record.fromRanges || [] };
          }),
          supported: true,
        };
      }
      return { result: items.map(item => this.hierarchyItem(item, 'type')), supported: true };
    }
    throw languageServerError('Unsupported Language Server method', 'LANGUAGE_SERVER_METHOD_UNSUPPORTED', 400);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await withTimeout(this.connection.sendRequest('shutdown'), 1_000, `${this.id} shutdown timed out`).catch(() => null);
    const exited = new Promise<void>(resolve => this.process.once('exit', () => resolve()));
    await this.connection.sendNotification('exit').catch(() => null);
    await Promise.race([
      exited,
      new Promise<void>(resolve => setTimeout(resolve, 250)),
    ]);
    if (this.process.exitCode === null && !this.process.killed) this.process.kill('SIGTERM');
    this.connection.dispose();
    for (const resolve of this.semanticLegendWaiters) resolve();
    this.semanticLegendWaiters.clear();
  }
}

export {
  ManagedLanguageServerClient,
  languageServerError,
  type LanguageServerRefreshKind,
  type ManagedLanguageServerClientOptions,
};
