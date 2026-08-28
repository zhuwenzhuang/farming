const crypto = require('crypto');

const DEFAULT_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PREVIEW_SESSIONS = 128;
const DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS = 32;
const DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS_PER_SCOPE = 8;

type PreviewAccessMode = 'owner' | 'read-only';

interface PreviewSessionManagerOptions {
  maxReadOnlySessions?: number;
  maxReadOnlySessionsPerScope?: number;
  maxSessions?: number;
  now?: () => number;
  randomUUID?: () => string;
  ttlMs?: number;
}

interface StaticPreviewSessionInput {
  accessMode?: PreviewAccessMode;
  rootId: string;
  scopeId?: string;
  workspaceRoot: string;
  authorizedRoot: string;
  entryPath: string;
  baseDirectory: string;
}

interface StaticPreviewSession extends Readonly<StaticPreviewSessionInput> {
  readonly accessMode: PreviewAccessMode;
  readonly id: string;
  readonly kind: 'static';
  readonly scopeId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

class PreviewSessionManager {
  private readonly maxSessions: number;
  private readonly maxReadOnlySessions: number;
  private readonly maxReadOnlySessionsPerScope: number;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly sessions = new Map<string, StaticPreviewSession>();
  private readonly ttlMs: number;

  constructor(options: PreviewSessionManagerOptions = {}) {
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_PREVIEW_SESSION_TTL_MS);
    this.maxSessions = Math.max(1, Number(options.maxSessions) || DEFAULT_MAX_PREVIEW_SESSIONS);
    this.maxReadOnlySessions = Math.max(
      1,
      Number(options.maxReadOnlySessions) || DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS,
    );
    this.maxReadOnlySessionsPerScope = Math.max(
      1,
      Math.min(
        this.maxReadOnlySessions,
        Number(options.maxReadOnlySessionsPerScope)
          || DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS_PER_SCOPE,
      ),
    );
    this.now = options.now || (() => Date.now());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
  }

  createStatic(input: StaticPreviewSessionInput): StaticPreviewSession {
    this.cleanupExpired();
    const accessMode: PreviewAccessMode = input.accessMode === 'read-only' ? 'read-only' : 'owner';
    const scopeId = String(input.scopeId || accessMode);
    if (accessMode === 'read-only') {
      while (this.sessionIds(accessMode, scopeId).length >= this.maxReadOnlySessionsPerScope) {
        this.sessions.delete(this.sessionIds(accessMode, scopeId)[0]!);
      }
      if (this.sessionIds(accessMode).length >= this.maxReadOnlySessions) {
        throw Object.assign(new Error('read-only preview capacity is busy; close an existing preview and retry'), {
          code: 'PREVIEW_CAPACITY',
          statusCode: 503,
        });
      }
    } else {
      while (this.sessionIds(accessMode).length >= this.maxSessions) {
        const oldestId = this.sessionIds(accessMode)[0];
        if (!oldestId) break;
        this.sessions.delete(oldestId);
      }
    }

    const now = this.now();
    const session = Object.freeze({
      id: this.randomUUID(),
      kind: 'static',
      accessMode,
      scopeId,
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

  get(
    sessionId: unknown,
    authority: { accessMode?: PreviewAccessMode } = {},
  ): StaticPreviewSession | null {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) return null;
    const accessMode: PreviewAccessMode = authority.accessMode === 'read-only' ? 'read-only' : 'owner';
    if (session.accessMode !== accessMode) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(session.id);
      return null;
    }
    return session;
  }

  delete(
    sessionId: unknown,
    authority: { accessMode?: PreviewAccessMode; scopeId?: string } = {},
  ): boolean {
    const id = String(sessionId || '');
    const session = this.sessions.get(id);
    if (!session) return false;
    const accessMode: PreviewAccessMode = authority.accessMode === 'read-only' ? 'read-only' : 'owner';
    const scopeId = String(authority.scopeId || accessMode);
    if (session.accessMode !== accessMode || session.scopeId !== scopeId) return false;
    return this.sessions.delete(id);
  }

  private sessionIds(accessMode: PreviewAccessMode, scopeId?: string): string[] {
    const ids: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.accessMode !== accessMode) continue;
      if (scopeId !== undefined && session.scopeId !== scopeId) continue;
      ids.push(sessionId);
    }
    return ids;
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
  DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS,
  DEFAULT_MAX_READ_ONLY_PREVIEW_SESSIONS_PER_SCOPE,
  DEFAULT_PREVIEW_SESSION_TTL_MS,
  PreviewSessionManager,
};
