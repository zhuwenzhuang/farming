const EventEmitter = require('events');
const SessionEngineRouter = require('./session-engine-router');

class SessionEngineBridge extends EventEmitter {
  constructor(configManager) {
    super();
    this.router = new SessionEngineRouter(configManager);
    this.bindEngineEvents();
  }

  bindEngineEvents() {
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
      engine.on('session-exited', (payload) => {
        this.emit('session-exited', { engineName, ...payload });
      });
      engine.on('session-error', (payload) => {
        this.emit('session-error', { engineName, ...payload });
      });
    });
  }

  resolve(command) {
    return this.router.resolve(command);
  }

  getEngine(name) {
    return this.router.getEngine(name);
  }

  async createSession(command, options) {
    const resolution = this.resolve(command);
    await resolution.engine.createSession(options);
    return resolution;
  }

  async sendInput(engineName, sessionId, input, options = {}) {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.sendInput(sessionId, input, options);
  }

  async claimSessionGeometry(engineName, sessionId, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.claimSessionGeometry) return { status: 'rejected', reason: 'unsupported-engine' };
    return engine.claimSessionGeometry(sessionId, geometry);
  }

  async activateSessionRenderer(engineName, sessionId, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.activateSessionRenderer) {
      return { status: 'renderer-ready-rejected', reason: 'unsupported-engine' };
    }
    return engine.activateSessionRenderer(sessionId, geometry);
  }

  async renewSessionGeometry(engineName, sessionId, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.renewSessionGeometry) return { status: 'rejected', reason: 'unsupported-engine' };
    return engine.renewSessionGeometry(sessionId, geometry);
  }

  async releaseSessionGeometry(engineName, sessionId, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.releaseSessionGeometry) return { status: 'unowned', reason: 'unsupported-engine' };
    return engine.releaseSessionGeometry(sessionId, geometry);
  }

  async acknowledgeSessionOutput(engineName, sessionId, charCount, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.acknowledgeSessionOutput) {
      return { status: 'output-ack-rejected', reason: 'unsupported-engine' };
    }
    return engine.acknowledgeSessionOutput(sessionId, charCount, geometry);
  }

  async resizeSession(engineName, sessionId, cols, rows, geometry) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.resizeSession) return;
    return engine.resizeSession(sessionId, cols, rows, geometry);
  }

  async clearBuffer(engineName, sessionId) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.clearBuffer) return;
    return engine.clearBuffer(sessionId);
  }

  async killSession(engineName, sessionId) {
    const engine = this.getEngine(engineName);
    if (!engine) return;
    return engine.killSession(sessionId);
  }

  async getSessionState(engineName, sessionId) {
    const engine = this.getEngine(engineName);
    if (!engine) return null;
    return engine.getSessionState(sessionId);
  }

  async getSessionAttachCheckpoint(engineName, sessionId) {
    const engine = this.getEngine(engineName);
    if (!engine || !engine.getSessionAttachCheckpoint) return null;
    return engine.getSessionAttachCheckpoint(sessionId);
  }

  async getSessionPreview(engineName, sessionId) {
    const engine = this.getEngine(engineName);
    if (!engine) return '';
    return engine.getSessionPreview(sessionId);
  }

  async recoverSessions(options = {}) {
    const recovered = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.recoverSessions !== 'function') continue;
      const sessions = await engine.recoverSessions(options);
      for (const session of sessions || []) {
        recovered.push({ engineName, ...session });
      }
    }
    return recovered;
  }

  consumeRuntimeRotations() {
    const rotations = [];
    for (const [engineName, engine] of Object.entries(this.router.engines)) {
      if (!engine || typeof engine.consumeRuntimeRotation !== 'function') continue;
      const rotation = engine.consumeRuntimeRotation();
      if (rotation) rotations.push({ engineName, ...rotation });
    }
    return rotations;
  }

  dispose(options = {}) {
    return this.router.dispose(options);
  }
}

module.exports = SessionEngineBridge;
