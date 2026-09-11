import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};

export interface BrowserInputTransport {
  send(tabId: string, method: string, params: RecordValue): Promise<void>;
  close(): void;
}

/** Input-only attachment to the existing Runtime, never a browser launcher. */
export class CdpBrowserInputTransport implements BrowserInputTransport {
  private socket: WebSocket | null = null;
  private nextId = 0;
  private browserSession = '';
  private closed = false;
  private sessions = new Map<string, string>();
  private pending = new Map<number, {
    resolve: (value: RecordValue) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly command: (args: string[]) => Promise<unknown>;
  private readonly failed: (message: string) => void;

  constructor(command: (args: string[]) => Promise<unknown>, failed: (message: string) => void) {
    this.command = command;
    this.failed = failed;
  }

  private async connect() {
    if (this.closed) throw new Error('Browser input transport is closed');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const result = record(await this.command(['get', 'cdp-url']));
    if (this.closed) throw new Error('Browser input transport is closed');
    const url = new URL(String(record(result.data).cdpUrl || ''));
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Browser input requires the Runtime-owned loopback CDP endpoint');
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let opened = false;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Browser input connection timed out'));
      }, 3_000);
      socket.once('open', () => { opened = true; clearTimeout(timer); resolve(); });
      socket.on('message', bytes => {
        let response: RecordValue;
        try { response = record(JSON.parse(String(bytes))); } catch { return; }
        if (response.method === 'Target.detachedFromTarget') {
          for (const [tab, session] of this.sessions) {
            if (session === record(response.params).sessionId) this.sessions.delete(tab);
          }
        }
        const request = this.pending.get(Number(response.id));
        if (!request) return;
        this.pending.delete(Number(response.id));
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error(String(record(response.error).message || 'Browser input failed')));
        else request.resolve(record(response.result));
      });
      socket.on('error', () => {
        clearTimeout(timer);
        if (!opened) reject(new Error('Browser input connection failed'));
      });
      socket.once('close', () => {
        clearTimeout(timer);
        this.socket = null;
        this.sessions.clear();
        this.browserSession = '';
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Browser input disconnected; the outcome is uncertain'));
        }
        this.pending.clear();
        if (!opened) reject(new Error('Browser input connection closed'));
        if (opened && !this.closed) {
          this.closed = true;
          this.failed('Browser input connection was lost; restart this Browser before continuing.');
        }
      });
    });
  }

  private request(method: string, params: RecordValue, sessionId?: string): Promise<RecordValue> {
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser input is disconnected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser input timed out; its outcome is uncertain'));
        socket.terminate();
      }, 3_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private async session(tabId: string): Promise<string> {
    const existing = this.sessions.get(tabId);
    if (existing) return existing;
    // agent-browser's t<N> is not a CDP target ID. A temporary, unguessable
    // marker in its selected page proves identity even for identical URLs.
    // Candidate sessions read only this marker and are immediately detached.
    if (!this.browserSession) {
      const browser = await this.request('Target.attachToBrowserTarget', {});
      this.browserSession = String(browser.sessionId || '');
      if (!this.browserSession) throw new Error('Browser input could not attach to its Runtime');
    }
    const marker = `__farming_input_${randomUUID().replaceAll('-', '')}`;
    const evaluate = (expression: string) => {
      if (this.closed) throw new Error('Browser input transport is closed');
      return this.command(['eval', '--base64', Buffer.from(expression).toString('base64')]);
    };
    // A hard stop may interrupt cleanup on a borrowed page. Expire this exact
    // marker locally without issuing a CLI command after its Runtime is closed.
    await evaluate(`Object.defineProperty(globalThis, ${JSON.stringify(marker)}, {value:{timer:setTimeout(()=>delete globalThis[${JSON.stringify(marker)}],10000)},configurable:true}); true`);
    try {
      const targets = await this.request('Target.getTargets', {});
      const pages = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []).map(record)
        .filter(target => target.type === 'page' || target.type === 'webview');
      if (pages.length > 64) throw new Error('Too many Browser targets to bind input safely');
      const deadline = Date.now() + 5_000;
      for (const page of pages) {
        if (Date.now() > deadline) throw new Error('Browser input target verification timed out');
        const attached = await this.request('Target.attachToTarget', { targetId: page.targetId, flatten: true }, this.browserSession);
        const sessionId = String(attached.sessionId || '');
        if (!sessionId) throw new Error('Browser input target did not provide a session');
        let selected = false;
        try {
          const check = await this.request('Runtime.evaluate', {
            expression: `Object.hasOwn(globalThis, ${JSON.stringify(marker)})`, returnByValue: true,
          }, sessionId);
          if (record(check.result).value === true) {
            this.sessions.set(tabId, sessionId);
            selected = true;
            return sessionId;
          }
        } finally {
          if (!selected) await this.request('Target.detachFromTarget', { sessionId }, this.browserSession);
        }
      }
      throw new Error('Browser input could not verify the selected tab');
    } finally {
      if (!this.closed) await evaluate(`(()=>{clearTimeout(globalThis[${JSON.stringify(marker)}]?.timer); return delete globalThis[${JSON.stringify(marker)}]})()`);
    }
  }

  async send(tabId: string, method: string, params: RecordValue): Promise<void> {
    await this.connect();
    await this.request(method, params, await this.session(tabId));
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.sessions.clear();
  }
}
