import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBrowserMcpServer } from '../extensions/browser/backend/browser-mcp-server.cjs';
import { createComputerMcpServer } from '../extensions/computer/backend/computer-mcp-server.cjs';
import { canonicalWorkspacePath } from './workspace-root-registry.cjs';
import type {
  AgentCapability,
  AgentCapabilityBinding,
} from './agent-capability-tokens.cjs';

interface CapabilityRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface CapabilityResponse {
  headersSent: boolean;
  status(code: number): CapabilityResponse;
  json(value: unknown): void;
}

interface AgentCapabilityMcpOptions {
  authDisabled?: boolean;
  capability: AgentCapability;
  controlUrl: string;
  resolveAgentBinding: (agentId: string) => { runtimeEpoch: string; workspace: string } | null;
  resolveToken: (token: string, capability: AgentCapability) => AgentCapabilityBinding | null;
  tokenFile?: string;
}

function bearerToken(request: CapabilityRequest): string {
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = String(value || '').match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  return match?.[1] || '';
}

function jsonRpcError(response: CapabilityResponse, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function createAgentCapabilityMcpHandler(options: AgentCapabilityMcpOptions) {
  return async (request: CapabilityRequest, response: CapabilityResponse): Promise<void> => {
    const binding = options.resolveToken(bearerToken(request), options.capability);
    if (!binding) {
      jsonRpcError(response, 401, 'Invalid Agent capability token');
      return;
    }
    const current = options.resolveAgentBinding(binding.agentId);
    if (
      !current
      || current.runtimeEpoch !== binding.runtimeEpoch
      || canonicalWorkspacePath(current.workspace) !== canonicalWorkspacePath(binding.workspace)
    ) {
      jsonRpcError(response, 403, 'Agent capability binding is no longer active');
      return;
    }

    const env: NodeJS.ProcessEnv = {
      FARMING_AGENT_ID: binding.agentId,
      FARMING_CONTROL_URL: options.controlUrl,
      FARMING_PROJECT_WORKSPACE: binding.workspace,
      ...(options.authDisabled ? { FARMING_DISABLE_AUTH: '1' } : {}),
      ...(options.tokenFile ? { FARMING_TOKEN_FILE: options.tokenFile } : {}),
    };
    const server = options.capability === 'browser'
      ? createBrowserMcpServer({ env })
      : createComputerMcpServer({ env });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request as never, response as never, request.body);
    } catch (error) {
      if (!response.headersSent) {
        jsonRpcError(
          response,
          500,
          error instanceof Error ? error.message : 'Agent capability MCP request failed',
        );
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}

export {
  createAgentCapabilityMcpHandler,
};
