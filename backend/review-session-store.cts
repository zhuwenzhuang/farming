const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
import { atomicWriteJson } from './atomic-json-store.cjs';
import * as storageLayout from './storage-layout.cjs';

const REVIEW_ID_PATTERN = /^review-[a-f0-9]{32}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/;

type ReviewScope = 'tracked' | 'untracked';

interface ReviewRevision {
  createdAt: string;
  number: number;
  previousTree?: string;
  tree: string;
}

interface ReviewSession {
  base: string;
  createdAt: string;
  id: string;
  modifiedWithinDays?: number;
  paths?: string[];
  revisions: ReviewRevision[];
  root: string;
  scope?: ReviewScope;
  updatedAt: string;
}

interface ReviewSessionState {
  sessions: Record<string, ReviewSession>;
}

interface ReviewSessionStoreOptions {
  file?: string;
  writeJson?: (file: string, value: unknown) => void;
}

interface CreateReviewSessionInput {
  base: string;
  createdAt?: string;
  id: string;
  modifiedWithinDays?: number;
  paths?: string[];
  root: string;
  scope?: ReviewScope;
  tree: string;
}

interface AppendReviewRevisionResult {
  added: boolean;
  session: ReviewSession;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validRevision(value: unknown): value is ReviewRevision {
  return isObject(value)
    && typeof value.tree === 'string'
    && OBJECT_ID_PATTERN.test(value.tree)
    && typeof value.number === 'number'
    && Number.isInteger(value.number)
    && value.number > 0
    && typeof value.createdAt === 'string'
    && (value.previousTree === undefined
      || (typeof value.previousTree === 'string' && OBJECT_ID_PATTERN.test(value.previousTree)));
}

function validStoredPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.startsWith('/')
    && !value.includes('\0')
    && value.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..');
}

function validSession(value: unknown): value is ReviewSession {
  return isObject(value)
    && typeof value.id === 'string'
    && REVIEW_ID_PATTERN.test(value.id)
    && typeof value.root === 'string'
    && path.isAbsolute(value.root)
    && typeof value.base === 'string'
    && OBJECT_ID_PATTERN.test(value.base)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && (value.scope === undefined || value.scope === 'tracked' || value.scope === 'untracked')
    && (value.modifiedWithinDays === undefined || (
      typeof value.modifiedWithinDays === 'number'
      && Number.isInteger(value.modifiedWithinDays)
      && value.modifiedWithinDays >= 1
      && value.modifiedWithinDays <= 3650
    ))
    && (value.paths === undefined || (
      Array.isArray(value.paths)
      && value.paths.length <= 256
      && value.paths.every(validStoredPath)
    ))
    && Array.isArray(value.revisions)
    && value.revisions.length > 0
    && value.revisions.every(validRevision);
}

function normalizeState(value: unknown): ReviewSessionState {
  const sessions = isObject(value) && isObject(value.sessions)
    ? value.sessions
    : {};
  return {
    sessions: Object.fromEntries(Object.entries(sessions)
      .filter((entry): entry is [string, ReviewSession] => {
        const [id, session] = entry;
        return REVIEW_ID_PATTERN.test(id) && validSession(session) && session.id === id;
      })),
  };
}

class ReviewSessionStore {
  file: string;
  writeJson: (file: string, value: unknown) => void;
  state: ReviewSessionState | null;

  constructor(configDir: string, options: ReviewSessionStoreOptions = {}) {
    this.file = options.file || storageLayout.reviewSessionsFile(configDir);
    this.writeJson = typeof options.writeJson === 'function'
      ? options.writeJson
      : (file, value) => atomicWriteJson(file, value, { trailingNewline: true });
    this.state = null;
  }

  ensureState(): ReviewSessionState {
    if (this.state) return this.state;
    try {
      this.state = fs.existsSync(this.file)
        ? normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')))
        : { sessions: {} };
    } catch (error: unknown) {
      console.warn(
        'Failed to read Farming review sessions:',
        error instanceof Error ? error.message : error,
      );
      this.state = { sessions: {} };
    }
    return this.state;
  }

  newId(): string {
    return `review-${crypto.randomUUID().replace(/-/g, '')}`;
  }

  get(reviewId: string): ReviewSession | null {
    if (!REVIEW_ID_PATTERN.test(reviewId)) return null;
    const session = this.ensureState().sessions[reviewId];
    return session ? clone(session) : null;
  }

  create({
    id,
    root,
    base,
    tree,
    scope,
    modifiedWithinDays,
    paths,
    createdAt = new Date().toISOString(),
  }: CreateReviewSessionInput): ReviewSession {
    if (!REVIEW_ID_PATTERN.test(id) || !path.isAbsolute(root) || !OBJECT_ID_PATTERN.test(base) || !OBJECT_ID_PATTERN.test(tree)) {
      throw new TypeError('invalid review session');
    }
    const currentState = this.ensureState();
    if (currentState.sessions[id]) throw new TypeError('review session already exists');
    const session = {
      base,
      createdAt,
      id,
      revisions: [{ createdAt, number: 1, tree }],
      root,
      ...(scope === 'tracked' || scope === 'untracked' ? { scope } : {}),
      ...(Number.isInteger(modifiedWithinDays) ? { modifiedWithinDays } : {}),
      ...(Array.isArray(paths) ? { paths: [...paths] } : {}),
      updatedAt: createdAt,
    };
    const nextState = {
      sessions: { ...currentState.sessions, [id]: session },
    };
    this.writeJson(this.file, nextState);
    this.state = nextState;
    return clone(session);
  }

  appendRevision(
    reviewId: string,
    tree: string,
    createdAt = new Date().toISOString(),
  ): AppendReviewRevisionResult {
    if (!OBJECT_ID_PATTERN.test(tree)) throw new TypeError('invalid review revision');
    const currentState = this.ensureState();
    const currentSession = currentState.sessions[reviewId];
    if (!currentSession) throw new TypeError('review session not found');
    const previous = currentSession.revisions[currentSession.revisions.length - 1];
    if (previous.tree === tree) return { added: false, session: clone(currentSession) };
    const nextSession = {
      ...currentSession,
      revisions: [...currentSession.revisions, {
        createdAt,
        number: previous.number + 1,
        previousTree: previous.tree,
        tree,
      }],
      updatedAt: createdAt,
    };
    const nextState = {
      sessions: { ...currentState.sessions, [reviewId]: nextSession },
    };
    this.writeJson(this.file, nextState);
    this.state = nextState;
    return { added: true, session: clone(nextSession) };
  }
}

export {
  OBJECT_ID_PATTERN,
  REVIEW_ID_PATTERN,
  ReviewSessionStore,
};
