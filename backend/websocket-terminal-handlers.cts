import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type InputMessage,
  type ResizeAgentMessage,
  type TerminalCheckpointRequestMessage,
} from '../shared/browser-protocol.js';
import { inputPartsFromMessage } from './input-parts.cjs';
import { resolveInputTargetAgentId } from './input-routing.cjs';

type ClearTerminalMessage = Extract<ClientMessage, { type: 'clear-terminal' }>;

interface WebSocketTerminalClient {
  agentId?: string;
  focusedAgentId?: string | null;
  protocolVersion?: number;
  readyState: number;
  send(data: string): void;
}

interface WebSocketTerminalPorts {
  openState: number;
  getAgentSessionView(agentId: string): Promise<unknown | null>;
  sendInput(agentId: string, inputParts: ReturnType<typeof inputPartsFromMessage>): Promise<unknown>;
  requestResize(agentId: string, cols: number, rows: number): unknown;
  clearBuffer(agentId: string): Promise<unknown>;
  checkpointErrorMessage(caught: unknown): string;
}

function createWebSocketTerminalHandlers<Client extends WebSocketTerminalClient>(ports: WebSocketTerminalPorts) {
  const sendTerminalCheckpointResult = async (
    client: Client,
    requestId: string,
    agentId: string,
  ): Promise<void> => {
    try {
      const session = await ports.getAgentSessionView(agentId);
      if (client.readyState !== ports.openState) return;
      if (!session) {
        client.send(JSON.stringify({
          type: 'terminal-checkpoint-result',
          requestId,
          agentId,
          ok: false,
          error: 'Agent not found',
        }));
        return;
      }
      client.send(JSON.stringify({
        type: 'terminal-checkpoint-result',
        requestId,
        agentId,
        ok: true,
        session,
      }));
    } catch (caught) {
      if (client.readyState !== ports.openState) return;
      client.send(JSON.stringify({
        type: 'terminal-checkpoint-result',
        requestId,
        agentId,
        ok: false,
        error: ports.checkpointErrorMessage(caught),
      }));
    }
  };

  const terminalCheckpointRequest = (client: Client, message: TerminalCheckpointRequestMessage): void => {
    if (!client.protocolVersion) {
      client.send(JSON.stringify({
        type: 'protocol-error',
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        message: 'Terminal checkpoint requires a negotiated Farming protocol',
      }));
      return;
    }
    void sendTerminalCheckpointResult(client, message.requestId, message.agentId);
  };

  const input = (client: Client, message: InputMessage): void => {
    const targetAgentId = resolveInputTargetAgentId(client, message);
    if (!targetAgentId) return;

    const inputParts = inputPartsFromMessage(message);
    if (inputParts.length === 0) return;
    void ports.sendInput(targetAgentId, inputParts);
  };

  const resizeAgent = (_client: Client, message: ResizeAgentMessage): void => {
    if (message.agentId && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
      ports.requestResize(message.agentId, message.cols, message.rows);
    }
  };

  const clearTerminal = (_client: Client, message: ClearTerminalMessage): void => {
    if (message.agentId) void ports.clearBuffer(message.agentId);
  };

  return { clearTerminal, input, resizeAgent, terminalCheckpointRequest };
}

export {
  createWebSocketTerminalHandlers,
  type WebSocketTerminalClient,
  type WebSocketTerminalPorts,
};
