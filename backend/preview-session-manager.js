const crypto = require('crypto');

const DEFAULT_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PREVIEW_SESSIONS = 128;

class PreviewSessionManager {
  constructor(options = {}) {
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_PREVIEW_SESSION_TTL_MS);
    this.maxSessions = Math.max(1, Number(options.maxSessions) || DEFAULT_MAX_PREVIEW_SESSIONS);
    this.now = options.now || (() => Date.now());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.sessions = new Map();
  }

  createStatic(input) {
    this.cleanupExpired();
    while (this.sessions.size >= this.maxSessions) {
      const oldestId = this.sessions.keys().next().value;
      if (!oldestId) break;
      this.sessions.delete(oldestId);
    }

    const now = this.now();
    const session = Object.freeze({
      id: this.randomUUID(),
      kind: 'static',
      rootId: input.rootId,
      workspaceRoot: input.workspaceRoot,
      authorizedRoot: input.authorizedRoot,
      entryPath: input.entryPath,
      baseDirectory: input.baseDirectory,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(session.id);
      return null;
    }
    return session;
  }

  delete(sessionId) {
    return this.sessions.delete(String(sessionId || ''));
  }

  cleanupExpired() {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  dispose() {
    this.sessions.clear();
  }
}

module.exports = {
  DEFAULT_PREVIEW_SESSION_TTL_MS,
  PreviewSessionManager,
};
