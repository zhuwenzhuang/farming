import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJsonAsync } from './atomic-json-store.cjs';
import { MAX_READ_ONLY_SHARE_HOURS } from '../shared/read-only-share-duration.js';

interface ReadOnlyShare {
  token: string;
  targetQuery: string;
  expiresAt: number;
}

interface ReadOnlyShareOptions {
  maxLinks?: number;
  writeJson?: typeof atomicWriteJsonAsync;
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_LINKS = 1000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function validShare(value: unknown): value is ReadOnlyShare {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === 'string' && record.token.length > 0 && record.token.length <= 1024
    && typeof record.targetQuery === 'string' && record.targetQuery.length <= 24_000
    && typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt);
}

function keyFor(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

class ReadOnlyShareStore {
  private readonly file: string;
  private readonly maxLinks: number;
  private readonly writeJson: typeof atomicWriteJsonAsync;
  private records: Map<string, ReadOnlyShare> | null = null;
  private loading: Promise<Map<string, ReadOnlyShare>> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(configDir: string, options: ReadOnlyShareOptions = {}) {
    this.file = path.join(configDir, 'read-only-shares.json');
    this.maxLinks = Math.min(MAX_LINKS, Math.max(1, options.maxLinks || MAX_LINKS));
    this.writeJson = options.writeJson || atomicWriteJsonAsync;
  }

  private async load(): Promise<Map<string, ReadOnlyShare>> {
    if (this.records) return this.records;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let contents: string;
      try {
        if ((await fs.stat(this.file)).size > MAX_FILE_BYTES) throw new Error('Read-only share storage is too large');
        contents = await fs.readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.records = new Map();
        return this.records;
      }
      const value: unknown = JSON.parse(contents);
      if (!value || typeof value !== 'object') throw new Error('Invalid read-only share storage');
      const state = value as { version?: unknown; links?: unknown };
      if (state.version !== 1 || !state.links || typeof state.links !== 'object' || Array.isArray(state.links)) {
        throw new Error('Invalid read-only share storage');
      }
      const entries = Object.entries(state.links);
      if (entries.length > MAX_LINKS || entries.some(([key, share]) => !/^[a-f0-9]{64}$/.test(key) || !validShare(share))) {
        throw new Error('Invalid read-only share storage');
      }
      this.records = new Map(entries as Array<[string, ReadOnlyShare]>);
      return this.records;
    })();
    try { return await this.loading; }
    finally { this.loading = null; }
  }

  create(token: string, options: { targetQuery: string; expiresAt: number; now?: number }): Promise<{ code: string }> {
    const operation = this.writing.then(async () => {
      const now = options.now ?? Date.now();
      const share = { token, targetQuery: options.targetQuery, expiresAt: Math.min(options.expiresAt, now + MAX_READ_ONLY_SHARE_HOURS * 60 * 60 * 1000) };
      if (!validShare(share) || share.expiresAt <= now) throw new Error('Invalid read-only share');
      const records = new Map([...(await this.load())].filter(([, value]) => value.expiresAt > now));
      if (records.size >= this.maxLinks) {
        throw Object.assign(new Error('Read-only share capacity reached. Wait for existing links to expire.'), { status: 503 });
      }
      let code = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        code = randomBytes(16).toString('base64url');
        if (!records.has(keyFor(code))) break;
        code = '';
      }
      if (!code) throw new Error('Unable to allocate read-only share code');
      records.set(keyFor(code), share);
      if (!await this.writeJson(this.file, { version: 1, links: Object.fromEntries(records) }, { mode: 0o600 })) {
        throw new Error('Read-only share was not persisted');
      }
      this.records = records;
      return { code };
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  async resolve(code: string, now = Date.now()): Promise<ReadOnlyShare | null> {
    if (!CODE_PATTERN.test(code)) return null;
    const share = (await this.load()).get(keyFor(code));
    return share && share.expiresAt > now ? { ...share } : null;
  }
}

export { ReadOnlyShareStore, type ReadOnlyShare };
