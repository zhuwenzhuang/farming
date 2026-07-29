import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { renderMainAgentSkills } = require('./main-agent-skills.cjs');
const storageLayout = require('./storage-layout.cjs');

interface AuthOptions {
  authDisabled?: boolean;
  token?: string;
  tokenFile?: string;
}

interface RequestOptions extends AuthOptions {
  baseUrl?: string;
  body?: unknown;
  headers?: OutgoingHttpHeaders;
  method?: string;
}

interface HttpRequestOptions {
  body?: string;
  headers?: OutgoingHttpHeaders;
  method?: string;
  timeoutMs?: number;
}

interface HttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface BrowserCapabilityStatus {
  available?: boolean;
  enabled?: boolean;
  message?: string;
  browser?: {
    kind?: string;
  };
}

interface Capability {
  id: string;
  state: string;
  summary: string;
  commands: Record<string, string>;
}

interface CapabilityReport {
  runtime: string;
  agentId: string;
  projectWorkspace: string;
  capabilities: Capability[];
}

interface AgentSummary {
  id: string;
  command: string;
  status: string;
  cwd: string;
  isMain?: boolean;
  parentAgentId?: string;
  task?: string;
}

interface CliIo {
  stdout: {
    write(chunk: string): unknown;
  };
}

type ParsedArgs =
  | { command: 'help' | 'skills' }
  | { command: 'capabilities'; options: { json: boolean } }
  | { command: 'list'; options: { json: boolean; parent: string } }
  | {
      command: 'spawn';
      options: {
        workspace: string;
        task: string;
        parent: string;
        json: boolean;
        dangerouslySkipPermissions: boolean;
        childCommand: string;
      };
    }
  | { command: 'output'; options: { agentId: string; tail: number } }
  | { command: 'send'; options: { agentId: string; input: string } }
  | { command: 'kill'; options: { agentId: string } };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return `Usage:
  farming skills
  farming capabilities [--json]
  farming list [--json] [--parent <agentId>]
  farming spawn [--workspace <path>] [--task <text>] [--parent <agentId>] [--json] -- <command...>
  farming output <agentId> [--tail <chars>]
  farming send <agentId> <text...>
  farming kill <agentId>

Examples:
  farming spawn --workspace /repo --task "Inspect this module for bugs" -- claude
  farming skills
  farming capabilities
  farming list --parent "$FARMING_AGENT_ID"
  farming output agent-123 --tail 2000
  farming send agent-123 "Please run the focused tests"`;
}

function readTokenFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function isAuthDisabled(options: AuthOptions = {}): boolean {
  if (options.authDisabled === true) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.FARMING_DISABLE_AUTH || '').toLowerCase());
}

function getToken(options: AuthOptions = {}): string {
  if (isAuthDisabled(options)) return '';
  if (options.token) return options.token;
  if (process.env.FARMING_TOKEN) return process.env.FARMING_TOKEN;

  const tokenFile = options.tokenFile
    || process.env.FARMING_TOKEN_FILE
    || storageLayout.sessionTokenFile(storageLayout.farmingConfigDir());
  return readTokenFile(tokenFile);
}

function normalizeBaseUrl(value?: string): string {
  const raw = value || process.env.FARMING_CONTROL_URL || `http://127.0.0.1:${process.env.PORT || 3000}${process.env.FARMING_BASE_PATH || ''}`;
  return raw.replace(/\/+$/, '');
}

function splitOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'skills') {
    if (rest.length > 0) {
      throw new Error('skills does not accept arguments');
    }
    return { command };
  }

  if (command === 'capabilities') {
    if (rest.some(arg => arg !== '--json')) {
      throw new Error('capabilities accepts only --json');
    }
    return { command, options: { json: rest.includes('--json') } };
  }

  if (command === 'list') {
    const options = { json: false, parent: '' };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') options.json = true;
      else if (rest[i] === '--parent') {
        options.parent = splitOptionValue(rest, i, '--parent');
        i++;
      } else {
        throw new Error(`Unknown option: ${rest[i]}`);
      }
    }
    return { command, options };
  }

  if (command === 'spawn') {
    const options = {
      workspace: '',
      task: '',
      parent: process.env.FARMING_AGENT_ID || '',
      json: false,
      dangerouslySkipPermissions: false,
      childCommand: '',
    };
    const childParts = [];
    let passthrough = false;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (passthrough) {
        childParts.push(arg);
      } else if (arg === '--') {
        passthrough = true;
      } else if (arg === '--workspace' || arg === '-w') {
        options.workspace = splitOptionValue(rest, i, arg);
        i++;
      } else if (arg === '--task' || arg === '-t') {
        options.task = splitOptionValue(rest, i, arg);
        i++;
      } else if (arg === '--parent') {
        options.parent = splitOptionValue(rest, i, '--parent');
        i++;
      } else if (arg === '--json') {
        options.json = true;
      } else if (arg === '--dangerously-skip-permissions') {
        options.dangerouslySkipPermissions = true;
      } else {
        childParts.push(arg);
      }
    }

    options.childCommand = childParts.join(' ').trim();
    if (!options.childCommand) {
      throw new Error('spawn requires a child command');
    }
    return { command, options };
  }

  if (command === 'output') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('output requires an agent id');
    const options = { agentId, tail: 4000 };
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--tail') {
        options.tail = Number(splitOptionValue(rest, i, '--tail'));
        i++;
      } else {
        throw new Error(`Unknown option: ${rest[i]}`);
      }
    }
    return { command, options };
  }

  if (command === 'send') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('send requires an agent id');
    const text = rest.slice(1).join(' ');
    if (!text) throw new Error('send requires input text');
    return {
      command,
      options: {
        agentId,
        input: (text.endsWith('\r') || text.endsWith('\n')) ? text : `${text}\r`,
      },
    };
  }

  if (command === 'kill') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('kill requires an agent id');
    return { command, options: { agentId } };
  }

  throw new Error(`Unknown command: ${command}`);
}

async function request<T = unknown>(pathname: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = getToken(options);
  if (!token && !isAuthDisabled(options)) {
    throw new Error('Farming token not found. Start this command from a Farming agent session or set FARMING_TOKEN_FILE.');
  }

  const headers: OutgoingHttpHeaders = {
    ...(options.headers || {}),
  };
  if (token) {
    headers.Cookie = `farming_token=${encodeURIComponent(token)}`;
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await httpRequest(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? '' : JSON.stringify(options.body),
  });

  const contentType = response.headers['content-type'] || '';
  const payload: unknown = contentType.includes('application/json')
    ? JSON.parse(response.body || 'null')
    : response.body;

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = isObject(payload) ? payload.error : payload;
    throw new Error(typeof message === 'string' && message ? message : `HTTP ${response.statusCode}`);
  }

  return payload as T;
}

function httpRequest(urlValue: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const url = new URL(urlValue);
    const body = options.body || '';
    const headers: OutgoingHttpHeaders = {
      ...(options.headers || {}),
    };
    if (body && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 30000,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: string | Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out: ${urlValue}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function formatAgent(agent: AgentSummary): string {
  const marker = agent.isMain ? '*' : '-';
  const task = agent.task ? ` | task: ${agent.task}` : '';
  const parent = agent.parentAgentId ? ` | parent: ${agent.parentAgentId}` : '';
  return `${marker} ${agent.id} | ${agent.command} | ${agent.status} | ${agent.cwd}${parent}${task}`;
}

function farmingCapabilities(browser?: BrowserCapabilityStatus): CapabilityReport {
  const state = browser?.available === true
    ? 'available'
    : (browser?.enabled === true ? 'unavailable' : 'disabled');
  return {
    runtime: 'farming',
    agentId: process.env.FARMING_AGENT_ID || '',
    projectWorkspace: process.env.FARMING_PROJECT_WORKSPACE || '',
    capabilities: [{
      id: 'browser',
      state,
      summary: state === 'available'
        ? (browser?.browser?.kind === 'external-cdp'
            ? 'Default browser path for web tasks. An externally managed CDP Browser can be created or attached as a shared, user-visible Farming Resource.'
            : browser?.browser?.kind === 'managed-chromium'
              ? 'Default browser path for web tasks. Farming-managed Chromium can be created or attached as a shared, user-visible Farming Resource.'
              : 'Default browser path for web tasks. An installed system Chromium Browser can be created or attached as a shared, user-visible Farming Resource.')
        : (browser?.message || 'Browser integration is unavailable in Farming.'),
      commands: state === 'available'
        ? {
            list: 'farming browser list',
            create: 'farming browser create',
            workflow: 'farming browser help workflow',
          }
        : {},
    }],
  };
}

function formatCapabilities(report: CapabilityReport): string {
  const lines = ['Farming runtime capabilities:'];
  for (const capability of report.capabilities) {
    lines.push(`- ${capability.id}: ${capability.state} — ${capability.summary}`);
    for (const [label, command] of Object.entries(capability.commands || {})) {
      lines.push(`  ${label}: ${command}`);
    }
  }
  return lines.join('\n');
}

async function run(argv: string[] = process.argv.slice(2), io: CliIo = process): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.command === 'help') {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (parsed.command === 'skills') {
    io.stdout.write(`${renderMainAgentSkills()}\n`);
    return 0;
  }

  if (parsed.command === 'capabilities') {
    const report = farmingCapabilities(await request<BrowserCapabilityStatus>('/api/browsers/capability'));
    io.stdout.write(parsed.options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatCapabilities(report)}\n`);
    return 0;
  }

  if (parsed.command === 'list') {
    const query = parsed.options.parent ? `?parent=${encodeURIComponent(parsed.options.parent)}` : '';
    const state = await request<{ agents: AgentSummary[] }>(`/api/control/agents${query}`);
    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      state.agents.forEach((agent) => io.stdout.write(`${formatAgent(agent)}\n`));
    }
    return 0;
  }

  if (parsed.command === 'spawn') {
    const result = await request<{ agentId: string }>('/api/control/agents', {
      method: 'POST',
      body: {
        command: parsed.options.childCommand,
        workspace: parsed.options.workspace || undefined,
        task: parsed.options.task || undefined,
        initialInput: parsed.options.task || undefined,
        parentAgentId: parsed.options.parent || undefined,
        dangerouslySkipPermissions: parsed.options.dangerouslySkipPermissions,
      },
    });

    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(`Started ${result.agentId}\n`);
    }
    return 0;
  }

  if (parsed.command === 'output') {
    const output = await request<string>(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}/output?tail=${parsed.options.tail}`);
    io.stdout.write(output);
    if (!String(output).endsWith('\n')) io.stdout.write('\n');
    return 0;
  }

  if (parsed.command === 'send') {
    await request(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}/input`, {
      method: 'POST',
      body: { input: parsed.options.input },
    });
    io.stdout.write('Sent\n');
    return 0;
  }

  if (parsed.command === 'kill') {
    await request(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}`, {
      method: 'DELETE',
    });
    io.stdout.write('Killed\n');
    return 0;
  }

  return 1;
}

export {
  formatAgent,
  farmingCapabilities,
  formatCapabilities,
  getToken,
  httpRequest,
  isAuthDisabled,
  normalizeBaseUrl,
  parseArgs,
  request,
  run,
  usage,
};

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
