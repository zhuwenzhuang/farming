import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type InputMessage,
  type ResizeAgentMessage,
  type TerminalCheckpointRequestMessage,
} from '../shared/browser-protocol.js';
import { inputPartsFromMessage } from './input-parts.cjs';
import { validPerformanceId } from '../shared/interaction-performance.js';
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
  getAgentSessionView(agentId: string, options?: { scrollback?: number }): Promise<unknown | null>;
  checkpointReconciled?(agentId: string, session: unknown): void;
  sendInput(agentId: string, inputParts: ReturnType<typeof inputPartsFromMessage>, performanceId?: string): Promise<unknown>;
  requestResize(agentId: string, cols: number, rows: number): unknown;
  clearBuffer(agentId: string): Promise<unknown>;
  checkpointErrorMessage(caught: unknown): string;
}

type TerminalInputRejectionResult = {
  reason?: unknown;
  sent?: unknown;
  status?: unknown;
};

const TERMINAL_INPUT_REJECTION_MESSAGES: Record<string, string> = {
  'uncertain-input-fence': 'Terminal input was not sent: an earlier write has an uncertain outcome until the terminal checkpoint recovers.',
  'runtime-epoch-mismatch': 'Terminal input was not sent: the terminal runtime changed.',
  'terminal-write-rejected': 'Terminal input was not sent: the terminal rejected the write.',
};
const TERMINAL_INPUT_UNCONFIRMED_REASON = 'delivery-not-confirmed';
const TERMINAL_INPUT_UNCONFIRMED_MESSAGE = 'Terminal input delivery could not be confirmed. Check the terminal state and retry.';

function createWebSocketTerminalHandlers<Client extends WebSocketTerminalClient>(ports: WebSocketTerminalPorts) {
  // Truly bounded dedupe: remember only the last consecutive error per
  // client, so repeated key events against an unchanged outcome cannot flood
  // the client, while a changed Agent or reason always becomes visible again.
  const lastInputErrors = new WeakMap<Client, { agentId: string; reason: string }>();

  const clearTerminalInputError = (client: Client, agentId: string): void => {
    const last = lastInputErrors.get(client);
    if (last && last.agentId === agentId) lastInputErrors.delete(client);
  };

  const reportTerminalInputError = (
    client: Client,
    agentId: string,
    reason: string,
    message: string,
  ): void => {
    const last = lastInputErrors.get(client);
    if (last && last.agentId === agentId && last.reason === reason) return;
    lastInputErrors.set(client, { agentId, reason });
    if (client.readyState !== ports.openState) return;
    try {
      client.send(JSON.stringify({
        type: 'error',
        message,
        agentId,
        reason,
      }));
    } catch {
      // The socket is already closing; the failure stays visible through the
      // next checkpoint recovery on reconnect.
    }
  };

  const sendTerminalCheckpointResult = async (
    client: Client,
    requestId: string,
    agentId: string,
    scrollbackLimit?: number,
  ): Promise<void> => {
    try {
      const session = await ports.getAgentSessionView(agentId, { scrollback: scrollbackLimit });
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
      // A completed checkpoint request is the viewer's explicit reconciliation
      // with authoritative Terminal state. Notify the owner before replying so
      // the fence state is consistent whether or not the reply is delivered.
      ports.checkpointReconciled?.(agentId, session);
      // A successful explicit reconciliation clears the dedupe slot so a new
      // fence with the same reason becomes visible again immediately.
      clearTerminalInputError(client, agentId);
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
    void sendTerminalCheckpointResult(
      client,
      message.requestId,
      message.agentId,
      message.scrollbackLimit,
    );
  };

  const input = (client: Client, message: InputMessage): void => {
    const targetAgentId = resolveInputTargetAgentId(client, message);
    if (!targetAgentId) return;

    const inputParts = inputPartsFromMessage(message);
    if (inputParts.length === 0) return;
    void Promise.resolve(ports.sendInput(targetAgentId, inputParts, validPerformanceId(message.performanceId) ? message.performanceId : undefined))
      .then(result => {
        const record = result && typeof result === 'object' ? result as TerminalInputRejectionResult : null;
        if (
          record
          && record.status === 'input-rejected'
          && typeof record.reason === 'string'
          && TERMINAL_INPUT_REJECTION_MESSAGES[record.reason]
        ) {
          reportTerminalInputError(
            client,
            targetAgentId,
            record.reason,
            TERMINAL_INPUT_REJECTION_MESSAGES[record.reason],
          );
          return;
        }
        if (record && record.sent === true) {
          clearTerminalInputError(client, targetAgentId);
          return;
        }
        // An undefined or unrecognized outcome means delivery could not be
        // confirmed. Raw terminal input has no other response path, so the
        // failure must become visible through the validated error message.
        reportTerminalInputError(
          client,
          targetAgentId,
          TERMINAL_INPUT_UNCONFIRMED_REASON,
          TERMINAL_INPUT_UNCONFIRMED_MESSAGE,
        );
      })
      .catch(() => {
        // A thrown failure also leaves delivery unconfirmed, and raw terminal
        // input has no other response path. Keep the visible message generic;
        // internals stay out of the client contract.
        reportTerminalInputError(
          client,
          targetAgentId,
          TERMINAL_INPUT_UNCONFIRMED_REASON,
          TERMINAL_INPUT_UNCONFIRMED_MESSAGE,
        );
      });
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
