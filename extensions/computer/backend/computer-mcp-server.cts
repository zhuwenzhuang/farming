const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { rootIdForPath } from '../../../backend/workspace-root-registry.cjs';
import { requestJson } from './farming-computer-client.cjs';
import {
  COMPUTER_DRIVER_VERSION,
  COMPUTER_SCHEMA_SHA256,
  COMPUTER_TOOL_COUNT,
} from './computer-constants.cjs';

interface ToolManifest {
  driverVersion: string;
  toolCount: number;
  tools: Array<Tool & { upstreamName: string }>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: recordValue(value),
  };
}

function loadManifest(): ToolManifest {
  const file = path.join(__dirname, 'cua-tools.json');
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== COMPUTER_SCHEMA_SHA256) {
    throw new Error(`Farming Computer tool schema integrity mismatch: ${sha256}`);
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as ToolManifest;
  if (
    manifest.driverVersion !== COMPUTER_DRIVER_VERSION
    || manifest.toolCount !== COMPUTER_TOOL_COUNT
    || manifest.tools.length !== COMPUTER_TOOL_COUNT
  ) {
    throw new Error('Farming Computer tool schema does not match the pinned Cua Driver contract');
  }
  return manifest;
}

class ScopedComputerClient {
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly agentId: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.workspace = String(env.FARMING_PROJECT_WORKSPACE || '').trim();
    this.agentId = String(env.FARMING_AGENT_ID || '').trim();
  }

  requireBinding(): void {
    if (!this.workspace || !this.agentId) {
      throw new Error('This Computer tool server is not bound to a Farming Agent Project');
    }
  }

  async list(): Promise<Record<string, unknown>[]> {
    this.requireBinding();
    const snapshot = recordValue(await requestJson('GET', '/api/computers', undefined, this.env));
    return (Array.isArray(snapshot.resources) ? snapshot.resources : [])
      .map(recordValue)
      .filter(resource => resource.ownerAgentId === this.agentId);
  }

  async open(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requireBinding();
    const existing = (await this.list())[0];
    const resource = existing || recordValue(await requestJson('POST', '/api/computers', {
      rootId: rootIdForPath(this.workspace),
      agentId: this.agentId,
      name: input.name,
    }, this.env));
    if (resource.status === 'running') return resource;
    return recordValue(await requestJson(
      'POST',
      `/api/computers/${encodeURIComponent(String(resource.id))}/start`,
      undefined,
      this.env,
    ));
  }

  async stop(): Promise<Record<string, unknown>> {
    const resource = (await this.list())[0];
    if (!resource) return { stopped: true, resource: null };
    return recordValue(await requestJson(
      'POST',
      `/api/computers/${encodeURIComponent(String(resource.id))}/stop`,
      undefined,
      this.env,
    ));
  }

  async call(upstreamName: string, input: Record<string, unknown>): Promise<CallToolResult> {
    const resource = await this.open();
    const result = recordValue(await requestJson(
      'POST',
      `/api/computers/${encodeURIComponent(String(resource.id))}/tool/${encodeURIComponent(upstreamName)}`,
      input,
      this.env,
    ));
    return result as CallToolResult;
  }
}

function createComputerMcpServer(options: {
  client?: ScopedComputerClient;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const manifest = loadManifest();
  const client = options.client || new ScopedComputerClient(options.env);
  const server = new Server(
    { name: 'farming-computer', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const lifecycleTools: Tool[] = [{
    name: 'computer_open',
    title: 'Open Farming Computer',
    description: 'Create or start the isolated Computer owned by this Farming Agent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, {
    name: 'computer_list',
    title: 'List Farming Computer',
    description: 'List the isolated Computer owned by this Farming Agent.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, {
    name: 'computer_stop',
    title: 'Stop Farming Computer',
    description: 'Stop this Agent Computer while retaining its resource row and container state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...lifecycleTools, ...manifest.tools],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    const input = recordValue(request.params.arguments);
    if (name === 'computer_open') return textResult(await client.open(input));
    if (name === 'computer_list') return textResult({ resources: await client.list() });
    if (name === 'computer_stop') return textResult(await client.stop());
    const tool = manifest.tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Unknown Computer tool: ${name}`);
    return client.call(tool.upstreamName, input);
  });
  return server;
}

async function runComputerMcpServer(options: {
  client?: ScopedComputerClient;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
  const server = createComputerMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export {
  ScopedComputerClient,
  createComputerMcpServer,
  loadManifest,
  runComputerMcpServer,
};
