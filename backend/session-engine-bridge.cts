import { EventEmitter } from 'events';
import { SessionEngineRouter } from './session-engine-router.cjs';
import type {
  CreateTerminalSessionOptions,
  RecoveredEngineSession,
  RuntimeEpochOptions,
  RuntimeRotationRecord,
  SessionEngineContract,
  SessionEngineResolutionContract,
  TerminalAttachCheckpoint,
  TerminalClearResult,
  TerminalInput,
  TerminalInputResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalSessionState,
} from './agent-manager-engine-types.js';

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
        this.emit('session-started', { engineName, ...payload });
      });
      engine.on('session-output', (payload) => {
        this.emit('session-output', { engineName, ...payload });
      });
      engine.on('session-transition', (payload) => {
        this.emit('session-transition', { engineName, ...payload });
      });
      engine.on('session-sync', (payload) => {
        this.emit('session-sync', { engineName, ...payload });
      });
      engine.on('session-preview', (payload) => {
        this.emit('session-preview', { engineName, ...payload });
      });
      engine.on('session-title', (payload) => {
        this.emit('session-title', { engineName, ...payload });
      });
      engine.on('session-activity', (payload) => {
        this.emit('session-activity', { engineName, ...payload });
      });
      engine.on('session-busy-state', (payload) => {
        this.emit('session-busy-state', { engineName, ...payload });
      });
      engine.on('session-notification', (payload) => {
        this.emit('session-notification', { engineName, ...payload });
      });
      engine.on('session-exited', (payload) => {
        this.emit('session-exited', { engineName, ...payload });
      });
      engine.on('session-error', (payload) => {
        this.emit('session-error', { engineName, ...payload });
      });
    });
  }

  resolve(command: string): SessionEngineResolutionContract {
    return this.router.resolve(command);
  }

  getEngine(name: unknown): SessionEngineContract | null {
    return this.router.getEngine(name);
  }

  async createSession(
    command: string,
    options: CreateTerminalSessionOptions,
  ): Promise<SessionEngineResolutionContract> {
    const resolution = this.resolve(command);
    await resolution.engine.createSession(options);
    return resolution;
  }

  async sendInput(
    engineName: unknown,
    sessionId: string,
    input: TerminalInput,
    options: RuntimeEpochOptions = {},
  ): Promise<TerminalInputResult | undefined> {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.sendInput(sessionId, input, options);
  }

  async resizeSession(
    engineName: unknown,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalResizeResult | null | undefined> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.resizeSession) return;
    return engine.resizeSession(sessionId, cols, rows);
  }

  async clearBuffer(
    engineName: unknown,
    sessionId: string,
    options: RuntimeEpochOptions = {},
  ): Promise<TerminalClearResult | null | undefined> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.clearBuffer) return;
    return engine.clearBuffer(sessionId, options);
  }

  async killSession(
    engineName: unknown,
    sessionId: string,
  ): Promise<TerminalKillResult | void> {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.killSession(sessionId);
  }

  async getSessionState(
    engineName: unknown,
    sessionId: string,
  ): Promise<TerminalSessionState | null> {
    const engine = this.getEngine(engineName);
    if (!engine) return null;
    return engine.getSessionState(sessionId);
  }

  async getSessionAttachCheckpoint(
    engineName: unknown,
    sessionId: string,
  ): Promise<TerminalAttachCheckpoint | null> {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.getSessionAttachCheckpoint) return null;
    return engine.getSessionAttachCheckpoint(sessionId);
  }

  async getSessionPreview(engineName: unknown, sessionId: string): Promise<string> {
    const engine = this.getEngine(engineName);
    if (!engine) return '';
    return engine.getSessionPreview(sessionId);
  }

  async recoverSessions(
    options: { startHost?: boolean } = {},
  ): Promise<RecoveredEngineSession[]> {
    const recovered: RecoveredEngineSession[] = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.recoverSessions !== 'function') continue;
      const sessions = await engine.recoverSessions(options);
      for (const session of sessions) {
        recovered.push({
          ...session,
          engineName,
        });
      }
    }
    return recovered;
  }

  consumeRuntimeRotations(): RuntimeRotationRecord[] {
    const rotations: RuntimeRotationRecord[] = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.consumeRuntimeRotation !== 'function') continue;
      const rotation = engine.consumeRuntimeRotation();
      if (rotation) rotations.push({ engineName, ...rotation });
    }
    return rotations;
  }

  dispose(
    options: { preserveHost?: boolean } = {},
  ): Promise<PromiseSettledResult<unknown>[]> {
    return this.router.dispose(options);
  }
}

export {
  SessionEngineBridge,
};
