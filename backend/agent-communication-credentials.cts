import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJsonAsync } from './atomic-json-store.cjs';

export type CommunicationPrincipal =
  | { kind: 'agent'; agentId: string }
  | { kind: 'external'; peerId: string; name: string };

export interface CommunicationGrant {
  id: string;
  /** Internal owner action only; never accepted by the credential issuer. */
  initiatedBy?: 'user';
  principal: CommunicationPrincipal;
  /** External grants always name exact recipient Agents. Local scope is resolved by the runtime. */
  targets: string[];
  expiresAt: number;
}

interface StoredGrant extends CommunicationGrant { digest: string }
const MAX_GRANTS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function validGrant(value: unknown): value is StoredGrant {
  if (!value || typeof value !== 'object') return false;
  const g = value as StoredGrant;
  const p = g.principal;
  return typeof g.id === 'string' && ID.test(g.id)
    && typeof g.digest === 'string' && /^[a-f0-9]{64}$/.test(g.digest)
    && Number.isSafeInteger(g.expiresAt) && g.expiresAt > 0
    && Array.isArray(g.targets) && g.targets.length <= 128
    && g.targets.every(t => typeof t === 'string' && ID.test(t))
    && Boolean(p && ((p.kind === 'agent' && typeof p.agentId === 'string' && ID.test(p.agentId))
      || (p.kind === 'external' && typeof p.peerId === 'string' && ID.test(p.peerId)
        && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 240
        && g.targets.length > 0)));
}

function publicGrant(grant: StoredGrant): CommunicationGrant {
  const { digest: _digest, ...visible } = grant;
  return structuredClone(visible);
}

/** Instance-local credentials. Only the owner administration and runtime launcher may issue grants. */
export class AgentCommunicationCredentials {
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();

  private readonly now: () => number;

  constructor(configDir: string, now = Date.now) {
    this.now = now;
    this.file = path.join(configDir, 'agent-communication-credentials.json');
  }

  private async read(): Promise<StoredGrant[]> {
    let value: unknown;
    try {
      const file = await fs.open(this.file, 'r');
      try {
        if ((await file.stat()).size > MAX_BYTES) throw new Error('Communication credential file exceeds limit');
        value = JSON.parse(await file.readFile('utf8'));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const state = value as { version?: unknown; grants?: unknown } | null;
    if (!state || state.version !== 1 || !Array.isArray(state.grants)
      || state.grants.length > MAX_GRANTS || !state.grants.every(validGrant)
      || new Set(state.grants.map(g => g.id)).size !== state.grants.length
      || new Set(state.grants.map(g => g.digest)).size !== state.grants.length) {
      throw new Error('Invalid communication credential storage');
    }
    return state.grants;
  }

  private mutate<T>(operation: (grants: StoredGrant[]) => { grants: StoredGrant[]; result: T }): Promise<T> {
    const pending = this.tail.then(async () => {
      const next = operation((await this.read()).filter(g => g.expiresAt > this.now()));
      if (!await atomicWriteJsonAsync(this.file, { version: 1, grants: next.grants }, { mode: 0o600 })) {
        throw new Error('Communication credentials were not persisted');
      }
      return next.result;
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  issue(principal: CommunicationPrincipal, targets: string[], expiresAt: number): Promise<{ token: string; grant: CommunicationGrant }> {
    const token = `farming-peer-v1.${randomBytes(32).toString('base64url')}`;
    const grant: StoredGrant = { id: randomUUID(), principal: structuredClone(principal), targets: [...new Set(targets)], expiresAt, digest: digest(token) };
    if (!validGrant(grant) || expiresAt <= this.now() || expiresAt > this.now() + MAX_LIFETIME_MS) {
      return Promise.reject(new Error('Invalid communication grant; require an identity, bounded expiry and explicit external targets'));
    }
    return this.mutate(grants => {
      if (grants.length >= MAX_GRANTS) throw new Error('Communication credential capacity reached; revoke unused credentials');
      return { grants: [...grants, grant], result: { token, grant: publicGrant(grant) } };
    });
  }

  async authenticate(token: string): Promise<CommunicationGrant | null> {
    if (!/^farming-peer-v1\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    await this.tail;
    const hash = digest(token);
    const grant = (await this.read()).find(g => g.digest === hash && g.expiresAt > this.now());
    return grant ? publicGrant(grant) : null;
  }

  async list(): Promise<CommunicationGrant[]> {
    await this.tail;
    return (await this.read()).filter(g => g.expiresAt > this.now()).map(publicGrant);
  }

  revoke(id: string): Promise<boolean> {
    return this.mutate(grants => ({ grants: grants.filter(g => g.id !== id), result: grants.some(g => g.id === id) }));
  }
}
