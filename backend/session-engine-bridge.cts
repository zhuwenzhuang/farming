import { EventEmitter } from 'events';
import { SessionEngineRouter } from './session-engine-router.cjs';
import type {
  RecoveredSessionRecord,
  SessionRecord,
  SessionEngineLike,
  SessionEngineResolution,
} from './session-engine-router.cjs';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

class SessionEngineBridge extends EventEmitter {
  readonly router: SessionEngineRouter;

  constructor(configManager?: { farmingDir?: string } | null) {
    super();
    this.router = new SessionEngineRouter(configManager);
    this.bindEngineEvents();
  }

  private bindEngineEvents(): void {
    Object.entries(this.router.engines).forEach(([engineName, engine]) => {
      engine.on('session-started', (payload) => {
        this.emit('session-started', { engineName, ...recordValue(payload) });
      });
      engine.on('session-output', (payload) => {
        this.emit('session-output', { engineName, ...recordValue(payload) });
      });
      engine.on('session-transition', (payload) => {
        this.emit('session-transition', { engineName, ...recordValue(payload) });
      });
      engine.on('session-sync', (payload) => {
        this.emit('session-sync', { engineName, ...recordValue(payload) });
      });
      engine.on('session-preview', (payload) => {
        this.emit('session-preview', { engineName, ...recordValue(payload) });
      });
      engine.on('session-title', (payload) => {
        this.emit('session-title', { engineName, ...recordValue(payload) });
      });
      engine.on('session-activity', (payload) => {
        this.emit('session-activity', { engineName, ...recordValue(payload) });
      });
      engine.on('session-busy-state', (payload) => {
        this.emit('session-busy-state', { engineName, ...recordValue(payload) });
      });
      engine.on('session-exited', (payload) => {
        this.emit('session-exited', { engineName, ...recordValue(payload) });
      });
      engine.on('session-error', (payload) => {
        this.emit('session-error', { engineName, ...recordValue(payload) });
      });
    });
  }

  resolve(command: string): SessionEngineResolution {
    return this.router.resolve(command);
  }

  getEngine(name: unknown): SessionEngineLike | null {
    return this.router.getEngine(name) as SessionEngineLike | null;
  }

  async createSession(command: string, options: unknown): Promise<SessionEngineResolution> {
    const resolution = this.resolve(command);
    await resolution.engine.createSession(options);
    return resolution;
  }

  async sendInput(
    engineName: unknown,
    sessionId: string,
    input: unknown,
    options: unknown = {},
  ): Promise<unknown> {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.sendInput(sessionId, input, options);
  }

  async resizeSession(
    engineName: unknown,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionRecord | null | undefined> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.resizeSession) return;
    return engine.resizeSession(sessionId, cols, rows);
  }

  async clearBuffer(
    engineName: unknown,
    sessionId: string,
    options: unknown = {},
  ): Promise<SessionRecord | null | undefined> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.clearBuffer) return;
    return engine.clearBuffer(sessionId, options);
  }

  async killSession(engineName: unknown, sessionId: string): Promise<unknown> {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.killSession(sessionId);
  }

  async getSessionState(
    engineName: unknown,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const engine = this.getEngine(engineName);
    if (!engine) return null;
    return engine.getSessionState(sessionId);
  }

  async getSessionAttachCheckpoint(
    engineName: unknown,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.getSessionAttachCheckpoint) return null;
    return engine.getSessionAttachCheckpoint(sessionId);
  }

  async getSessionPreview(engineName: unknown, sessionId: string): Promise<unknown> {
    const engine = this.getEngine(engineName);
    if (!engine) return '';
    return engine.getSessionPreview(sessionId);
  }

  async recoverSessions(options: unknown = {}): Promise<RecoveredSessionRecord[]> {
    const recovered: RecoveredSessionRecord[] = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.recoverSessions !== 'function') continue;
      const sessions = await engine.recoverSessions(options);
      for (const session of Array.isArray(sessions) ? sessions : []) {
        const record = recordValue(session);
        recovered.push({
          ...record,
          engineName,
          metadata: recordValue(record.metadata),
          state: recordValue(record.state),
        });
      }
    }
    return recovered;
  }

  consumeRuntimeRotations(): Record<string, unknown>[] {
    const rotations: Record<string, unknown>[] = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.consumeRuntimeRotation !== 'function') continue;
      const rotation = engine.consumeRuntimeRotation();
      if (rotation) rotations.push({ engineName, ...recordValue(rotation) });
    }
    return rotations;
  }

  dispose(options: unknown = {}): Promise<PromiseSettledResult<unknown>[]> {
    return this.router.dispose(options);
  }
}

export {
  SessionEngineBridge,
};
