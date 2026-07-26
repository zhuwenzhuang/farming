const WebSocket = require('ws');

class CdpClient {
  constructor(options = {}) {
    this.WebSocket = options.WebSocket || WebSocket;
    this.timeoutMs = options.timeoutMs || 15_000;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closeListeners = new Set();
    this.closeNotified = false;
    this.closed = false;
  }

  connect(url) {
    if (this.socket) throw new Error('CDP client is already connected');
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocket(url);
      this.socket = socket;
      const onOpen = () => {
        cleanupConnectListeners();
        socket.on('message', data => this.handleMessage(data));
        socket.on('close', () => this.handleClose(new Error('CDP connection closed')));
        socket.on('error', error => this.handleClose(error));
        resolve();
      };
      const onError = error => {
        cleanupConnectListeners();
        this.socket = null;
        reject(error);
      };
      const onClose = () => {
        cleanupConnectListeners();
        this.socket = null;
        reject(new Error('CDP connection closed during startup'));
      };
      const cleanupConnectListeners = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.socket || this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is not open'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message), error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  on(method, handler, sessionId) {
    const listener = { handler, sessionId: sessionId || null };
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => {
      const listeners = this.listeners.get(method);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  onClose(handler) {
    this.closeListeners.add(handler);
    return () => this.closeListeners.delete(handler);
  }

  waitFor(method, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const off = this.on(method, params => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      }, options.sessionId);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`CDP event timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
    this.handleClose(new Error('CDP client closed'));
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'CDP command failed');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    const listeners = this.listeners.get(message.method);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (listener.sessionId && listener.sessionId !== message.sessionId) continue;
      listener.handler(message.params || {}, message);
    }
  }

  handleClose(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.closeNotified) return;
    this.closeNotified = true;
    for (const listener of [...this.closeListeners]) listener(error);
  }
}

module.exports = {
  CdpClient,
};
