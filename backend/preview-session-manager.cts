const crypto = require('crypto');

const DEFAULT_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PREVIEW_SESSIONS = 128;

interface PreviewSessionManagerOptions {
  maxSessions?: number;
  now?: () => number;
  randomUUID?: () => string;
  ttlMs?: number;
}

interface StaticPreviewSessionInput {
  rootId: string;
  workspaceRoot: string;
  authorizedRoot: string;
  entryPath: string;
  baseDirectory: string;
}

interface StaticPreviewSession extends Readonly<StaticPreviewSessionInput> {
  readonly id: string;
  readonly kind: 'static';
  readonly createdAt: number;
  readonly expiresAt: number;
}

class PreviewSessionManager {
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly sessions = new Map<string, StaticPreviewSession>();
  private readonly ttlMs: number;

  constructor(options: PreviewSessionManagerOptions = {}) {
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_PREVIEW_SESSION_TTL_MS);
    this.maxSessions = Math.max(1, Number(options.maxSessions) || DEFAULT_MAX_PREVIEW_SESSIONS);
    this.now = options.now || (() => Date.now());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
  }

  createStatic(input: StaticPreviewSessionInput): StaticPreviewSession {
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

  get(sessionId: unknown): StaticPreviewSession | null {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(session.id);
      return null;
    }
    return session;
  }

  delete(sessionId: unknown): boolean {
    return this.sessions.delete(String(sessionId || ''));
  }

  cleanupExpired(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  dispose(): void {
    this.sessions.clear();
  }
}

export {
  DEFAULT_PREVIEW_SESSION_TTL_MS,
  PreviewSessionManager,
};
