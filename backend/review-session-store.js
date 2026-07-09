const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

const REVIEW_ID_PATTERN = /^review-[a-f0-9]{32}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryFile, file);
}

function validRevision(value) {
  return value
    && typeof value === 'object'
    && OBJECT_ID_PATTERN.test(value.tree)
    && Number.isInteger(value.number)
    && value.number > 0
    && typeof value.createdAt === 'string'
    && (value.previousTree === undefined || OBJECT_ID_PATTERN.test(value.previousTree));
}

function validSession(value) {
  return value
    && typeof value === 'object'
    && REVIEW_ID_PATTERN.test(value.id)
    && typeof value.root === 'string'
    && path.isAbsolute(value.root)
    && OBJECT_ID_PATTERN.test(value.base)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && (value.scope === undefined || value.scope === 'tracked' || value.scope === 'untracked')
    && (value.modifiedWithinDays === undefined || (Number.isInteger(value.modifiedWithinDays) && value.modifiedWithinDays >= 1 && value.modifiedWithinDays <= 3650))
    && Array.isArray(value.revisions)
    && value.revisions.length > 0
    && value.revisions.every(validRevision);
}

function normalizeState(value) {
  const sessions = value && typeof value === 'object' && value.sessions && typeof value.sessions === 'object'
    ? value.sessions
    : {};
  return {
    sessions: Object.fromEntries(Object.entries(sessions)
      .filter(([id, session]) => REVIEW_ID_PATTERN.test(id) && validSession(session) && session.id === id)),
  };
}

class ReviewSessionStore {
  constructor(configDir, options = {}) {
    this.file = options.file || storageLayout.reviewSessionsFile(configDir);
    this.state = null;
  }

  ensureState() {
    if (this.state) return this.state;
    try {
      this.state = fs.existsSync(this.file)
        ? normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')))
        : { sessions: {} };
    } catch (error) {
      console.warn('Failed to read Farming review sessions:', error && (error.message || error));
      this.state = { sessions: {} };
    }
    return this.state;
  }

  newId() {
    return `review-${crypto.randomUUID().replace(/-/g, '')}`;
  }

  get(reviewId) {
    if (!REVIEW_ID_PATTERN.test(reviewId)) return null;
    const session = this.ensureState().sessions[reviewId];
    return session ? clone(session) : null;
  }

  create({ id, root, base, tree, scope, modifiedWithinDays, createdAt = new Date().toISOString() }) {
    if (!REVIEW_ID_PATTERN.test(id) || !path.isAbsolute(root) || !OBJECT_ID_PATTERN.test(base) || !OBJECT_ID_PATTERN.test(tree)) {
      throw new TypeError('invalid review session');
    }
    const state = this.ensureState();
    if (state.sessions[id]) throw new TypeError('review session already exists');
    const session = {
      base,
      createdAt,
      id,
      revisions: [{ createdAt, number: 1, tree }],
      root,
      ...(scope === 'tracked' || scope === 'untracked' ? { scope } : {}),
      ...(Number.isInteger(modifiedWithinDays) ? { modifiedWithinDays } : {}),
      updatedAt: createdAt,
    };
    state.sessions[id] = session;
    atomicWriteJson(this.file, state);
    return clone(session);
  }

  appendRevision(reviewId, tree, createdAt = new Date().toISOString()) {
    if (!OBJECT_ID_PATTERN.test(tree)) throw new TypeError('invalid review revision');
    const state = this.ensureState();
    const session = state.sessions[reviewId];
    if (!session) throw new TypeError('review session not found');
    const previous = session.revisions[session.revisions.length - 1];
    if (previous.tree === tree) return { added: false, session: clone(session) };
    session.revisions.push({
      createdAt,
      number: previous.number + 1,
      previousTree: previous.tree,
      tree,
    });
    session.updatedAt = createdAt;
    atomicWriteJson(this.file, state);
    return { added: true, session: clone(session) };
  }
}

module.exports = {
  OBJECT_ID_PATTERN,
  REVIEW_ID_PATTERN,
  ReviewSessionStore,
};
