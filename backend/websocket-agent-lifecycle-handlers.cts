import type { ClientMessage } from '../shared/browser-protocol.js';
import {
  observeWebSocketCallbackRejection,
  reportWebSocketAdmissionFailure,
} from './websocket-admission-errors.cjs';

type StartAgentMessage = Extract<ClientMessage, { type: 'start-agent' }>;
type InterruptAgentMessage = Extract<ClientMessage, { type: 'interrupt-agent' }>;
type ArchiveAgentMessage = Extract<ClientMessage, { type: 'archive-agent' }>;
type RestartMainAgentMessage = Extract<ClientMessage, { type: 'restart-main-agent' }>;

interface WebSocketAgentLifecycleClient {
  agentId?: string;
  readyState: number;
  send(data: string): void;
}

interface AgentStateRecord {
  id: string;
  isMain?: boolean;
}

interface AgentLifecycleResult {
  error?: string;
}

interface StartAgentOptions extends Record<string, unknown> {
  acpHistoryMode?: 'load' | 'resume';
  agentRuntimeMode?: 'terminal' | 'chat' | 'acp';
  createRequestId?: string;
  customTitle?: string;
  onAgentRegistered?: (agentId: string) => void;
  projectWorkspace?: string;
  providerHomeId?: string;
  task?: string;
  wantsMain?: boolean;
  workflowTemplate?: string;
}

type StartAgentCallback = (agentId: string | null, error?: string | null) => void;

interface WebSocketAgentLifecyclePorts {
  openState: number;
  canonicalProjectWorkspace(workspace: string | null): Promise<string>;
  startAgent(
    command: string,
    workspace: string | null,
    callback: StartAgentCallback,
    options: StartAgentOptions,
  ): PromiseLike<unknown>;
  mountProjectWorkspace(workspace: string): void;
  archiveAgent(agentId: string, options?: Record<string, unknown>): PromiseLike<AgentLifecycleResult>;
  interruptAgent(agentId: string): PromiseLike<unknown>;
  getAgentState(): { agents: AgentStateRecord[]; mainAgentId: string | null };
  killAgent(agentId: string): PromiseLike<AgentLifecycleResult>;
  publishAgentState(): void;
  revealAgentState(): void;
  warnStartCompletionFailure(agentId: string, error: unknown): void;
}

const MAIN_AGENT_RESTART_COMMANDS = new Set([
  'codex',
  'claude',
  'opencode',
  'qoder',
  'qwen',
  'bash',
  'zsh',
]);

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (
    error
    && typeof error === 'object'
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message || fallback;
  }
  return error === null || error === undefined ? fallback : String(error);
}

function sendJson(
  client: WebSocketAgentLifecycleClient,
  value: Record<string, unknown>,
  openState: number,
): boolean {
  if (client.readyState !== openState) return false;
  try {
    client.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function createWebSocketAgentLifecycleHandlers<Client extends WebSocketAgentLifecycleClient>(
  ports: WebSocketAgentLifecyclePorts,
) {
  const sendError = (client: Client, message: string): void => {
    sendJson(client, { type: 'error', message }, ports.openState);
  };

  const finishStartedAgent = async (
    client: Client,
    agentId: string,
    projectWorkspace: string,
  ): Promise<void> => {
    try {
      if (projectWorkspace) ports.mountProjectWorkspace(projectWorkspace);
    } catch (mountError) {
      let rollbackError = '';
      try {
        const rollback = await ports.archiveAgent(agentId, {
          reason: 'project-mount-failed',
          recordHistory: false,
          requireEngineExit: true,
          scheduleProviderArchive: false,
        });
        if (rollback?.error) rollbackError = rollback.error;
      } catch (cleanupError) {
        rollbackError = errorMessage(cleanupError, String(cleanupError));
      }
      ports.publishAgentState();
      const mountMessage = errorMessage(mountError, 'Failed to create Project');
      sendError(
        client,
        rollbackError ? `${mountMessage}. Rollback failed: ${rollbackError}` : mountMessage,
      );
      return;
    }

    client.agentId = agentId;
    ports.publishAgentState();
    sendJson(client, { type: 'agent-started', agentId }, ports.openState);
  };

  const startAgent = (client: Client, message: StartAgentMessage): void => {
    const workspace = typeof message.workspace === 'string' ? message.workspace : null;
    const revealChatAgentWhileConnecting = message.agentRuntimeMode === 'chat';
    void (async () => {
      const projectWorkspace = message.asMain === true
        ? ''
        : await ports.canonicalProjectWorkspace(
          typeof message.projectWorkspace === 'string' && message.projectWorkspace.trim()
            ? message.projectWorkspace
            : workspace,
        );
      let startCallbackReported = false;
      const startResult = ports.startAgent(message.command, workspace, (agentId, error) => {
        startCallbackReported = true;
        if (error) {
          sendError(client, error);
        } else if (agentId) {
          void finishStartedAgent(client, agentId, projectWorkspace).catch((callbackError: unknown) => {
            ports.warnStartCompletionFailure(agentId, callbackError);
          });
        }
      }, {
        wantsMain: message.asMain === true,
        projectWorkspace,
        task: typeof message.task === 'string' ? message.task : '',
        workflowTemplate: typeof message.workflowTemplate === 'string' ? message.workflowTemplate : '',
        customTitle: typeof message.customTitle === 'string' ? message.customTitle : '',
        createRequestId: typeof message.requestId === 'string' ? message.requestId : '',
        codexApprovalMode: typeof message.codexApprovalMode === 'string'
          ? message.codexApprovalMode
          : undefined,
        agentRuntimeMode: message.agentRuntimeMode === 'acp'
          || message.agentRuntimeMode === 'chat'
          ? message.agentRuntimeMode
          : 'terminal',
        acpHistoryMode: message.acpHistoryMode === 'resume' ? 'resume' : 'load',
        providerHomeId: typeof message.providerHomeId === 'string' ? message.providerHomeId : '',
        ...(revealChatAgentWhileConnecting ? {
          onAgentRegistered: (agentId: string) => {
            client.agentId = agentId;
            ports.revealAgentState();
            sendJson(client, { type: 'agent-started', agentId }, ports.openState);
          },
        } : {}),
        ...(Array.isArray(message.additionalDirectories)
          ? { additionalDirectories: message.additionalDirectories }
          : {}),
        ...(Array.isArray(message.mcpServers) ? { mcpServers: message.mcpServers } : {}),
        ...(message.dangerouslySkipPermissions === true
          ? { dangerouslySkipPermissions: true }
          : {}),
      });
      observeWebSocketCallbackRejection(client, startResult, () => startCallbackReported, {
        openState: ports.openState,
        fallbackMessage: 'Failed to start Agent',
      });
    })().catch((error: unknown) => {
      const fallbackMessage = 'Failed to resolve Project workspace';
      reportWebSocketAdmissionFailure(
        client,
        error instanceof Error ? error : new Error(errorMessage(error, fallbackMessage)),
        {
          openState: ports.openState,
          fallbackMessage,
        },
      );
    });
  };

  const interruptAgent = (client: Client, message: InterruptAgentMessage): void => {
    if (!message.agentId) return;
    try {
      void Promise.resolve(ports.interruptAgent(message.agentId)).catch((error: unknown) => {
        reportWebSocketAdmissionFailure(client, error, {
          openState: ports.openState,
          fallbackMessage: 'Failed to interrupt Agent',
        });
      });
    } catch (error) {
      reportWebSocketAdmissionFailure(client, error, {
        openState: ports.openState,
        fallbackMessage: 'Failed to interrupt Agent',
      });
    }
  };

  const archiveAgent = (client: Client, message: ArchiveAgentMessage): void => {
    void (async () => {
      try {
        const result = await ports.archiveAgent(message.agentId);
        if (result?.error) sendError(client, result.error);
      } catch (error) {
        sendError(client, errorMessage(error, 'Failed to archive Agent'));
      } finally {
        ports.publishAgentState();
      }
    })();
  };

  const restartMainAgent = (client: Client, message: RestartMainAgentMessage): void => {
    const command = String(message.command || '').trim();
    if (!MAIN_AGENT_RESTART_COMMANDS.has(command)) {
      sendError(client, 'Unsupported Main Agent restart command');
      return;
    }

    void (async () => {
      let startCallbackReported = false;
      try {
        const state = ports.getAgentState();
        const currentMain = state.agents.find(agent => (
          agent.id === state.mainAgentId || agent.isMain === true
        ));
        if (currentMain) {
          const killed = await ports.killAgent(currentMain.id);
          if (killed?.error) {
            sendError(client, killed.error);
            return;
          }
        }

        await ports.startAgent(command, null, (agentId, error) => {
          startCallbackReported = true;
          if (error) {
            sendError(client, error);
          } else if (agentId) {
            client.agentId = agentId;
            ports.publishAgentState();
            sendJson(client, { type: 'agent-started', agentId }, ports.openState);
          }
        }, {
          wantsMain: true,
        });
      } catch (error) {
        if (!startCallbackReported) {
          sendError(client, errorMessage(error, 'Failed to restart Main Agent'));
          ports.publishAgentState();
        }
      }
    })();
  };

  return { archiveAgent, interruptAgent, restartMainAgent, startAgent };
}

export {
  createWebSocketAgentLifecycleHandlers,
  type WebSocketAgentLifecycleClient,
  type WebSocketAgentLifecyclePorts,
};
