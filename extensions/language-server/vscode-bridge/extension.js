'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 1024 * 1024;
const HANDLE_TTL_MS = 10 * 60 * 1000;
const MAX_HANDLES = 2_000;
const PROVIDER_ACTIVATION_RETRY_MS = 250;
const PROVIDER_ACTIVATION_ATTEMPTS = 3;
const UNSUPPORTED = Symbol('unsupported');
const FEATURES = [
  'hover',
  'definition',
  'references',
  'implementation',
  'documentSymbols',
  'workspaceSymbols',
  'callHierarchy',
  'typeHierarchy',
  'diagnostics',
];

let activeServer = null;
let activeDescriptor = null;
let activeToken = '';
let activeInstanceId = '';
const handles = new Map();

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function rangeValue(range) {
  if (!range) return null;
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function locationValue(location) {
  if (!location) return null;
  if (location.uri && location.range) {
    return { uri: location.uri.toString(), range: rangeValue(location.range) };
  }
  if (location.targetUri) {
    return {
      uri: location.targetUri.toString(),
      range: rangeValue(location.targetRange || location.targetSelectionRange),
      selectionRange: rangeValue(location.targetSelectionRange),
      originSelectionRange: rangeValue(location.originSelectionRange),
    };
  }
  return null;
}

function markdownValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.language === 'string' && typeof value.value === 'string') {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  if (value && typeof value.value === 'string') return value.value;
  return '';
}

function symbolValue(symbol) {
  if (!symbol) return null;
  if (symbol.location) {
    const location = locationValue(symbol.location);
    return location ? {
      name: String(symbol.name || ''),
      detail: String(symbol.containerName || ''),
      kind: Number(symbol.kind) || 0,
      ...location,
    } : null;
  }
  return {
    name: String(symbol.name || ''),
    detail: String(symbol.detail || ''),
    kind: Number(symbol.kind) || 0,
    range: rangeValue(symbol.range),
    selectionRange: rangeValue(symbol.selectionRange || symbol.range),
    children: Array.isArray(symbol.children) ? symbol.children.map(symbolValue).filter(Boolean) : [],
  };
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString());
}

function normalizeFsPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requireWorkspace(workspaceValue) {
  const uri = vscode.Uri.parse(String(workspaceValue || ''));
  if (uri.scheme !== 'file') throw new Error('A file workspace URI is required');
  const expected = normalizeFsPath(uri.fsPath);
  const folder = (vscode.workspace.workspaceFolders || []).find(candidate => (
    normalizeFsPath(candidate.uri.fsPath) === expected
  ));
  if (!folder) throw new Error('The requested Project is not open in VS Code');
  return folder;
}

function requireDocumentUri(value, folder) {
  const uri = vscode.Uri.parse(String(value || ''));
  if (uri.scheme !== 'file') throw new Error('A file URI is required');
  const owner = vscode.workspace.getWorkspaceFolder(uri);
  if (!owner || normalizeFsPath(owner.uri.fsPath) !== normalizeFsPath(folder.uri.fsPath)) {
    throw new Error('The requested file is outside the VS Code workspace');
  }
  return uri;
}

function positionValue(value) {
  const source = value && typeof value === 'object' ? value : {};
  const line = Number(source.line);
  const character = Number(source.character);
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    throw new Error('A valid zero-based position is required');
  }
  return new vscode.Position(line, character);
}

async function executeProvider(command, ...args) {
  for (let attempt = 0; attempt < PROVIDER_ACTIVATION_ATTEMPTS; attempt += 1) {
    const value = await vscode.commands.executeCommand(command, ...args);
    if (value != null) return value;
    if (attempt + 1 < PROVIDER_ACTIVATION_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, PROVIDER_ACTIVATION_RETRY_MS));
    }
  }
  return null;
}

function pruneHandles() {
  const cutoff = Date.now() - HANDLE_TTL_MS;
  for (const [id, entry] of handles) {
    if (entry.touchedAt < cutoff) handles.delete(id);
  }
  while (handles.size > MAX_HANDLES) handles.delete(handles.keys().next().value);
}

function storeHierarchyItem(item, workspace, hierarchy) {
  pruneHandles();
  const id = crypto.randomUUID();
  handles.set(id, { item, workspace, hierarchy, touchedAt: Date.now() });
  return {
    id,
    name: String(item.name || ''),
    detail: String(item.detail || ''),
    kind: Number(item.kind) || 0,
    uri: item.uri.toString(),
    range: rangeValue(item.range),
    selectionRange: rangeValue(item.selectionRange || item.range),
  };
}

function requireHandle(id, workspace, hierarchy) {
  pruneHandles();
  const entry = handles.get(String(id || ''));
  if (!entry || entry.workspace !== workspace || entry.hierarchy !== hierarchy) {
    throw new Error('The hierarchy item expired; prepare the hierarchy again');
  }
  entry.touchedAt = Date.now();
  return entry.item;
}

async function executeRequest(input) {
  const method = String(input.method || '');
  const folder = requireWorkspace(input.workspace);
  const workspace = folder.uri.toString();
  const uri = input.uri ? requireDocumentUri(input.uri, folder) : null;
  const position = input.position ? positionValue(input.position) : null;
  if (uri) await vscode.workspace.openTextDocument(uri);

  if (method === 'hover') {
    const values = await executeProvider('vscode.executeHoverProvider', uri, position);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(hover => ({
      contents: (hover.contents || []).map(markdownValue).filter(Boolean),
      range: rangeValue(hover.range),
    }));
  }
  if (method === 'definition' || method === 'implementation' || method === 'references') {
    const command = method === 'definition'
      ? 'vscode.executeDefinitionProvider'
      : method === 'implementation'
        ? 'vscode.executeImplementationProvider'
        : 'vscode.executeReferenceProvider';
    const values = await executeProvider(command, uri, position);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(locationValue).filter(Boolean);
  }
  if (method === 'documentSymbols') {
    const values = await executeProvider('vscode.executeDocumentSymbolProvider', uri);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(symbolValue).filter(Boolean);
  }
  if (method === 'workspaceSymbols') {
    const values = await executeProvider('vscode.executeWorkspaceSymbolProvider', String(input.query || ''));
    if (values == null) return UNSUPPORTED;
    return (values || []).map(symbolValue).filter(Boolean);
  }
  if (method === 'diagnostics') {
    let diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length === 0) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          subscription.dispose();
          resolve();
        }, 500);
        const subscription = vscode.languages.onDidChangeDiagnostics(event => {
          if (!event.uris.some(changed => changed.toString() === uri.toString())) return;
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        });
      });
      diagnostics = vscode.languages.getDiagnostics(uri);
    }
    return diagnostics.map(diagnostic => ({
      message: diagnostic.message,
      severity: diagnostic.severity,
      range: rangeValue(diagnostic.range),
      source: diagnostic.source || '',
      code: diagnostic.code && typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    }));
  }
  if (method === 'prepareCallHierarchy' || method === 'prepareTypeHierarchy') {
    const hierarchy = method === 'prepareCallHierarchy' ? 'call' : 'type';
    const command = hierarchy === 'call' ? 'vscode.prepareCallHierarchy' : 'vscode.prepareTypeHierarchy';
    const values = await executeProvider(command, uri, position);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(item => storeHierarchyItem(item, workspace, hierarchy));
  }
  if (method === 'incomingCalls' || method === 'outgoingCalls') {
    const item = requireHandle(input.itemId, workspace, 'call');
    const command = method === 'incomingCalls' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls';
    const values = await executeProvider(command, item);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(call => ({
      item: storeHierarchyItem(method === 'incomingCalls' ? call.from : call.to, workspace, 'call'),
      ranges: (call.fromRanges || []).map(rangeValue),
    }));
  }
  if (method === 'supertypes' || method === 'subtypes') {
    const item = requireHandle(input.itemId, workspace, 'type');
    const command = method === 'supertypes' ? 'vscode.provideSupertypes' : 'vscode.provideSubtypes';
    const values = await executeProvider(command, item);
    if (values == null) return UNSUPPORTED;
    return (values || []).map(value => storeHierarchyItem(value, workspace, 'type'));
  }
  throw new Error('Unsupported Language Server method');
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleRequest(request, response) {
  if (request.headers.authorization !== `Bearer ${activeToken}`) {
    json(response, 401, { error: 'Unauthorized', code: 'VSCODE_BRIDGE_UNAUTHORIZED' });
    return;
  }
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    json(response, 200, {
      version: PROTOCOL_VERSION,
      name: 'VS Code Bridge',
      vscodeVersion: vscode.version,
      features: FEATURES,
      workspaces: workspaceFolders(),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/request') {
    try {
      const result = await executeRequest(await readBody(request));
      json(response, 200, result === UNSUPPORTED
        ? { result: [], supported: false }
        : { result, supported: true });
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
        code: 'VSCODE_BRIDGE_REQUEST_FAILED',
      });
    }
    return;
  }
  json(response, 404, { error: 'Not found', code: 'VSCODE_BRIDGE_NOT_FOUND' });
}

async function activate(context) {
  await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  activeToken = crypto.randomBytes(32).toString('hex');
  activeInstanceId = crypto.randomUUID();
  activeDescriptor = path.join(context.globalStorageUri.fsPath, `bridge-${activeInstanceId}.json`);
  activeServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise((resolve, reject) => {
    activeServer.once('error', reject);
    activeServer.listen(0, '127.0.0.1', resolve);
  });
  const address = activeServer.address();
  if (!address || typeof address === 'string') throw new Error('VS Code Bridge failed to bind loopback');
  const descriptor = {
    version: PROTOCOL_VERSION,
    endpoint: `http://127.0.0.1:${address.port}`,
    token: activeToken,
    instanceId: activeInstanceId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const temporary = `${activeDescriptor}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temporary, activeDescriptor);
  await fs.promises.chmod(activeDescriptor, 0o600);
  context.subscriptions.push({ dispose: () => void deactivate() });
}

async function deactivate() {
  const descriptor = activeDescriptor;
  activeDescriptor = null;
  activeInstanceId = '';
  handles.clear();
  if (activeServer) {
    const server = activeServer;
    activeServer = null;
    await new Promise(resolve => server.close(resolve));
  }
  if (descriptor) await fs.promises.rm(descriptor, { force: true }).catch(() => {});
}

module.exports = { activate, deactivate };
