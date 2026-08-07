const { PROTOCOL_VERSION } = require('../../../shared/browser-protocol.js');

type PendingCheckpoint = {
  resolve: (session: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class TerminalCheckpointClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private protocolReady = false;
  private requestSequence = 0;
  private readonly pending = new Map<string, PendingCheckpoint>();

  constructor(private readonly baseUrl: string) {}

  private websocketUrl() {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws`;
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private resetSocket(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.protocolReady = false;
  }

  private async ensureConnected() {
    if (this.socket?.readyState === WebSocket.OPEN && this.protocolReady) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.websocketUrl());
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.resetSocket(socket);
        socket.close();
        reject(new Error('Timed out negotiating terminal checkpoint WebSocket'));
      }, 5_000);

      const failConnect = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.resetSocket(socket);
        reject(error);
      };

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'protocol-hello',
          protocolVersion: PROTOCOL_VERSION,
        }));
      });
      socket.addEventListener('message', (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'protocol-hello') {
          this.protocolReady = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (message.type !== 'terminal-checkpoint-result') return;
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const request = this.pending.get(requestId);
        if (!request) return;
        this.pending.delete(requestId);
        clearTimeout(request.timer);
        if (message.ok !== true || !message.session || typeof message.session !== 'object') {
          request.reject(new Error(String(message.error || 'Terminal checkpoint unavailable')));
          return;
        }
        request.resolve(message.session as Record<string, unknown>);
      });
      socket.addEventListener('error', () => failConnect(new Error('Terminal checkpoint WebSocket failed')));
      socket.addEventListener('close', () => {
        this.resetSocket(socket);
        failConnect(new Error('Terminal checkpoint WebSocket closed during negotiation'));
        this.rejectPending(new Error('Terminal checkpoint WebSocket disconnected'));
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async request(agentId: string) {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.protocolReady) {
      throw new Error('Terminal checkpoint WebSocket is unavailable');
    }
    this.requestSequence += 1;
    const requestId = `backend-test-checkpoint:${this.requestSequence}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.resetSocket(socket);
        socket.close();
        reject(new Error('Timed out waiting for terminal checkpoint'));
      }, 5_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        type: 'terminal-checkpoint-request',
        requestId,
        agentId,
      }));
    });
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.protocolReady = false;
    this.rejectPending(new Error('Terminal checkpoint client closed'));
    socket?.close();
  }
}
