import type {
  AcpPermissionResponseMessage,
  ComposerInputMessage,
} from '../shared/browser-protocol.js';
import { attachmentExtension } from './attachment-upload.cjs';
import { resolveInputTargetAgentId } from './input-routing.cjs';
import { isSameOrDescendantPath } from './path-containment.cjs';
import { reportWebSocketAdmissionFailure } from './websocket-admission-errors.cjs';

const path = require('path');
const { pathToFileURL } = require('url');

interface WebSocketAcpClient {
  agentId?: string;
  focusedAgentId?: string | null;
  readyState: number;
  send(data: string): void;
}

interface ComposerAttachment {
  kind?: unknown;
  path?: unknown;
  type?: unknown;
}

interface ComposerInputWithAttachments extends ComposerInputMessage {
  attachments?: ComposerAttachment[];
}

interface ComposerError extends Error {
  uncertain?: boolean;
}

interface WebSocketAcpPorts {
  openState: number;
  attachmentsRoot: string;
  readAttachment(filePath: string): Promise<Buffer>;
  agentRuntimeKind(agentId: string): unknown;
  sendComposerMessage(
    agentId: string,
    content: unknown[],
    options: { requestId: string; delivery: 'auto' | 'prompt' | 'steer' },
  ): Promise<unknown>;
  respondToAcpPermission(
    agentId: string,
    requestId: string,
    optionId: string,
    cancelled: boolean,
  ): unknown;
}

function caughtError(error: unknown): ComposerError {
  if (error instanceof Error) return error as ComposerError;
  const normalized = new Error(String(error)) as ComposerError;
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function sendJson(
  client: WebSocketAcpClient,
  value: Record<string, unknown>,
  openState: number,
): void {
  if (client.readyState !== openState) return;
  try {
    client.send(JSON.stringify(value));
  } catch {
    // The operation is already terminal. A socket close race must not create
    // another rejection or replay a mutation.
  }
}

function attachmentMimeType(kind: 'audio' | 'image', value: unknown): string {
  if (typeof value !== 'string') return '';
  if (kind === 'image' && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(value)) return '';
  if (kind === 'audio' && !attachmentExtension(kind, value)) return '';
  return value.toLowerCase();
}

function createWebSocketAcpHandlers<Client extends WebSocketAcpClient>(ports: WebSocketAcpPorts) {
  const attachmentsRoot = path.resolve(ports.attachmentsRoot);
  const composerInput = (client: Client, message: ComposerInputWithAttachments): void => {
    const targetAgentId = resolveInputTargetAgentId(client, message);
    const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
    const composerMessage = typeof message.message === 'string' ? message.message : '';
    const delivery = message.delivery === 'steer' || message.delivery === 'prompt'
      ? message.delivery
      : 'auto';
    const responseAgentId = targetAgentId
      || (typeof message.agentId === 'string' ? message.agentId : '');
    const respond = (accepted: boolean, responseMessage = '', uncertain = false): void => {
      if (!requestId || !responseAgentId) return;
      sendJson(client, {
        type: 'composer-input-result',
        requestId,
        agentId: responseAgentId,
        accepted,
        ...(responseMessage ? { message: responseMessage } : {}),
        ...(uncertain ? { uncertain: true } : {}),
      }, ports.openState);
    };

    void (async () => {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
        if (responseAgentId) {
          sendJson(client, {
            type: 'composer-input-result',
            requestId: requestId || 'invalid-request',
            agentId: responseAgentId,
            accepted: false,
            message: 'Structured Composer input requires a valid requestId',
          }, ports.openState);
        }
        return;
      }

      const content: unknown[] = [];
      if (composerMessage.trim()) content.push({ type: 'text', text: composerMessage });
      const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 8) : [];
      for (const attachment of attachments) {
        if (
          (attachment?.kind !== 'image' && attachment?.kind !== 'audio')
          || typeof attachment.path !== 'string'
        ) continue;
        const filePath = path.resolve(attachment.path);
        if (
          filePath === attachmentsRoot
          || !isSameOrDescendantPath(attachmentsRoot, filePath)
        ) continue;
        const mimeType = attachmentMimeType(attachment.kind, attachment.type);
        if (!mimeType) continue;
        try {
          const data = await ports.readAttachment(filePath);
          if (data.length === 0 || data.length > 12 * 1024 * 1024) continue;
          content.push({
            type: attachment.kind,
            data: data.toString('base64'),
            mimeType,
            path: filePath,
            uri: pathToFileURL(filePath).href,
          });
        } catch {
          // The text fallback already explains failed or unavailable uploads.
        }
      }

      if (!targetAgentId || content.length === 0) {
        respond(false, 'Composer message is empty');
        return;
      }
      if (ports.agentRuntimeKind(targetAgentId) !== 'acp') {
        respond(false, 'Terminal Composer input requires the active terminal owner');
        return;
      }

      try {
        await ports.sendComposerMessage(targetAgentId, content, { requestId, delivery });
        respond(true);
      } catch (error) {
        const normalized = caughtError(error);
        respond(
          false,
          normalized.message || 'Failed to send Composer message',
          normalized.uncertain === true,
        );
      }
    })().catch((error: unknown) => {
      const normalized = caughtError(error);
      respond(false, normalized.message || 'Failed to send Composer message', normalized.uncertain === true);
    });
  };

  const acpPermissionResponse = (
    client: Client,
    message: AcpPermissionResponseMessage,
  ): void => {
    try {
      const result = ports.respondToAcpPermission(
        message.agentId,
        message.requestId,
        message.optionId,
        message.cancelled === true,
      );
      void Promise.resolve(result).catch((error: unknown) => {
        reportWebSocketAdmissionFailure(client, caughtError(error), {
          openState: ports.openState,
          fallbackMessage: 'Failed to respond to ACP permission',
        });
      });
    } catch (error) {
      reportWebSocketAdmissionFailure(client, caughtError(error), {
        openState: ports.openState,
        fallbackMessage: 'Failed to respond to ACP permission',
      });
    }
  };

  return { acpPermissionResponse, composerInput };
}

export {
  createWebSocketAcpHandlers,
  type WebSocketAcpClient,
  type WebSocketAcpPorts,
};
