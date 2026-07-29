import { EventEmitter } from 'events';

abstract class SessionEngine extends EventEmitter {
  async createSession(_options: unknown): Promise<unknown> {
    throw new Error('createSession() must be implemented by subclasses');
  }

  async sendInput(_sessionId: string, _input: unknown, _options: unknown = {}): Promise<unknown> {
    throw new Error('sendInput() must be implemented by subclasses');
  }

  async interruptSession(
    _sessionId: string,
    _input: unknown,
    _options: unknown = {},
  ): Promise<unknown> {
    throw new Error('interruptSession() must be implemented by subclasses');
  }

  async resizeSession(_sessionId: string, _cols: number, _rows: number): Promise<unknown> {
    throw new Error('resizeSession() must be implemented by subclasses');
  }

  async clearBuffer(_sessionId: string, _options: unknown = {}): Promise<unknown> {
    throw new Error('clearBuffer() must be implemented by subclasses');
  }

  async killSession(_sessionId: string): Promise<unknown> {
    throw new Error('killSession() must be implemented by subclasses');
  }

  async getSessionState(_sessionId: string): Promise<unknown> {
    throw new Error('getSessionState() must be implemented by subclasses');
  }

  async getSessionPreview(_sessionId: string): Promise<unknown> {
    throw new Error('getSessionPreview() must be implemented by subclasses');
  }

  async recoverSessions(_options: unknown = {}): Promise<unknown[]> {
    return [];
  }

  consumeRuntimeRotation(): unknown {
    return null;
  }

  dispose(_options: unknown = {}): unknown {
    return undefined;
  }
}

export {
  SessionEngine,
};
