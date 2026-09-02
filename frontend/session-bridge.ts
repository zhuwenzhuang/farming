interface FarmingRuntimePaths {
  apiPath(suffix?: string): string;
}

interface ComposerInputResult {
  type?: string;
  requestId?: string;
  accepted: boolean;
  message?: string;
  uncertain?: boolean;
  [key: string]: unknown;
}

interface TerminalCheckpointResult {
  type?: string;
  requestId?: string;
  agentId?: string;
  ok?: boolean;
  session?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

interface ComposerOptions {
  requestId?: string;
  onResult?: (result: ComposerInputResult) => void;
}

interface FocusAgentOptions {
  activityScope?: 'all' | 'focused' | 'none';
  stateScope?: 'all' | 'focused';
  streamScope?: string;
  previewScope?: string;
  refreshState?: boolean;
}

interface TerminalCheckpointOptions {
  signal?: AbortSignal;
  scrollbackLimit?: number;
}

interface SessionBridgeClientOptions {
  getSocket?: () => WebSocket | null;
}

interface FarmingSessionClient {
  focusAgent(agentId: string | null, options?: FocusAgentOptions): boolean;
  sendTerminalInput(agentId: string, input: string): boolean;
  sendComposerMessage(
    agentId: string,
    message: string,
    attachments?: readonly unknown[],
    options?: ComposerOptions,
  ): boolean;
  handleServerMessage(message: unknown): boolean;
  handleTransportDisconnected(message?: string): void;
  interruptAgent(agentId: string): boolean;
  resizeAgent(agentId: string, cols: number, rows: number): boolean;
  clearTerminal(agentId: string): boolean;
  archiveAgent(agentId: string): boolean;
  requestTerminalCheckpoint(agentId: string, options?: TerminalCheckpointOptions): Promise<unknown>;
}

interface Window {
  __FARMING_E2E__?: boolean;
  __farmingTerminalCheckpointInterceptor?: (
    message: TerminalCheckpointResult & { requestId: string; agentId: string },
  ) => TerminalCheckpointResult | null | Promise<TerminalCheckpointResult | null>;
  FarmingRuntimePaths: FarmingRuntimePaths;
  WebSocket: typeof WebSocket;
  FarmingSessionBridge: {
    createClient(options?: SessionBridgeClientOptions): FarmingSessionClient;
  };
}

(function attachSessionBridge(global: Window) {
  function createClient(options: SessionBridgeClientOptions = {}): FarmingSessionClient {
    const getSocket = options.getSocket || (() => null);
    const composerResults = new Map<string, (result: ComposerInputResult) => void>();
    const checkpointRequests = new Map<string, {
      agentId: string;
      sent: boolean;
      signal?: AbortSignal;
      scrollbackLimit?: number;
      resolve: (payload: { session: Record<string, unknown> }) => void;
      reject: (error: Error) => void;
      onAbort?: () => void;
    }>();
    let composerRequestSequence = 0;
    let checkpointRequestSequence = 0;
    let transportReady = false;

    function send(message: Record<string, unknown>) {
      const ws = getSocket();
      if (!ws || ws.readyState !== global.WebSocket.OPEN) {
        return false;
      }
      ws.send(JSON.stringify(message));
      return true;
    }

    function sendPendingCheckpoints() {
      if (!transportReady) return;
      for (const [requestId, request] of checkpointRequests) {
        if (request.sent || request.signal?.aborted) continue;
        request.sent = send({
          type: 'terminal-checkpoint-request',
          requestId,
          agentId: request.agentId,
          ...(request.scrollbackLimit === undefined ? {} : { scrollbackLimit: request.scrollbackLimit }),
        });
        if (!request.sent) {
          transportReady = false;
          return;
        }
      }
    }

    function deleteCheckpointRequest(requestId: string) {
      const request = checkpointRequests.get(requestId);
      if (!request) return null;
      checkpointRequests.delete(requestId);
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener('abort', request.onAbort);
      }
      return request;
    }

    function settleCheckpointResult(
      message: TerminalCheckpointResult & { requestId: string; agentId: string },
    ) {
      const request = checkpointRequests.get(message.requestId);
      if (!request || request.agentId !== message.agentId) return false;
      deleteCheckpointRequest(message.requestId);
      if (!message.ok || !message.session) {
        request.reject(new Error(message.error || 'Terminal checkpoint is unavailable'));
      } else {
        request.resolve({ session: message.session });
      }
      return true;
    }

    return {
      focusAgent(agentId, options = {}) {
        return send({
          type: 'focus-agent',
          agentId,
          ...(options.activityScope ? { activityScope: options.activityScope } : {}),
          ...(options.stateScope ? { stateScope: options.stateScope } : {}),
          ...(options.streamScope ? { streamScope: options.streamScope } : {}),
          ...(options.previewScope ? { previewScope: options.previewScope } : {}),
          ...(options.refreshState === true ? { refreshState: true } : {}),
        });
      },

      sendTerminalInput(agentId, input) {
        return send({ type: 'input', agentId, input });
      },

      sendComposerMessage(agentId, message, attachments = [], options = {}) {
        const requestedId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
        const requestId = requestedId
          || global.crypto?.randomUUID?.()
          || `composer-${Date.now().toString(36)}-${++composerRequestSequence}`;
        const sent = send({
          type: 'composer-input',
          agentId,
          message,
          requestId,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (sent && options.onResult) composerResults.set(requestId, options.onResult);
        return sent;
      },

      handleServerMessage(message) {
        if (isProtocolHello(message)) {
          transportReady = true;
          checkpointRequests.forEach(request => {
            request.sent = false;
          });
          sendPendingCheckpoints();
          return false;
        }
        if (isTerminalCheckpointResult(message)) {
          const request = checkpointRequests.get(message.requestId);
          if (!request || request.agentId !== message.agentId) return false;
          const interceptor = global.__FARMING_E2E__
            ? global.__farmingTerminalCheckpointInterceptor
            : undefined;
          if (!interceptor) return settleCheckpointResult(message);
          void Promise.resolve(interceptor(message)).then(result => {
            if (result && isTerminalCheckpointResult(result)) settleCheckpointResult(result);
          }).catch(error => {
            const pending = deleteCheckpointRequest(message.requestId);
            pending?.reject(error instanceof Error ? error : new Error(String(error)));
          });
          return true;
        }
        if (isComposerInputResult(message)) {
          const callback = composerResults.get(message.requestId);
          if (!callback) return false;
          composerResults.delete(message.requestId);
          callback(message);
          return true;
        }
        return false;
      },

      handleTransportDisconnected(message = 'Connection unavailable') {
        transportReady = false;
        checkpointRequests.forEach(request => {
          request.sent = false;
        });
        composerResults.forEach(callback => callback({ accepted: false, message, uncertain: true }));
        composerResults.clear();
      },

      interruptAgent(agentId) {
        return send({ type: 'interrupt-agent', agentId });
      },

      resizeAgent(agentId, cols, rows) {
        return send({ type: 'resize-agent', agentId, cols, rows });
      },

      clearTerminal(agentId) {
        return send({ type: 'clear-terminal', agentId });
      },

      archiveAgent(agentId) {
        return send({ type: 'archive-agent', agentId });
      },

      requestTerminalCheckpoint(agentId, options = {}) {
        if (options.signal?.aborted) {
          return Promise.reject(options.signal.reason instanceof Error
            ? options.signal.reason
            : new globalThis.DOMException('Terminal checkpoint request was cancelled', 'AbortError'));
        }
        const requestId = global.crypto?.randomUUID?.()
          || `terminal-checkpoint-${Date.now().toString(36)}-${++checkpointRequestSequence}`;
        const promise = new Promise<{ session: Record<string, unknown> }>((resolve, reject) => {
          const request = {
            agentId,
            sent: false,
            signal: options.signal,
            scrollbackLimit: options.scrollbackLimit,
            resolve,
            reject,
            onAbort: undefined as (() => void) | undefined,
          };
          request.onAbort = () => {
            deleteCheckpointRequest(requestId);
            reject(options.signal?.reason instanceof Error
              ? options.signal.reason
              : new globalThis.DOMException('Terminal checkpoint request was cancelled', 'AbortError'));
          };
          checkpointRequests.set(requestId, request);
          options.signal?.addEventListener('abort', request.onAbort, { once: true });
          sendPendingCheckpoints();
        });
        return promise;
      },
    };
  }

  function isComposerInputResult(message: unknown): message is ComposerInputResult & { requestId: string } {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as Partial<ComposerInputResult>;
    return candidate.type === 'composer-input-result' && typeof candidate.requestId === 'string';
  }

  function isProtocolHello(message: unknown): message is { type: 'protocol-hello' } {
    return Boolean(message && typeof message === 'object' && (message as { type?: string }).type === 'protocol-hello');
  }

  function isTerminalCheckpointResult(
    message: unknown,
  ): message is TerminalCheckpointResult & { requestId: string; agentId: string } {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as Partial<TerminalCheckpointResult>;
    return candidate.type === 'terminal-checkpoint-result'
      && typeof candidate.requestId === 'string'
      && typeof candidate.agentId === 'string';
  }

  global.FarmingSessionBridge = { createClient };
})(window);
