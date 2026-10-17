import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonAsync } from '../../../backend/atomic-json-store.cjs';

export interface A2aExtensionState { version: 1; revision: number; enabled: boolean }

export class A2aExtensionService {
  private readonly file: string;
  private loading: Promise<A2aExtensionState> | undefined;
  private state: A2aExtensionState | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(configDir: string) { this.file = path.join(configDir, 'a2a-extension.json'); }

  private async load(): Promise<A2aExtensionState> {
    if (this.state) return this.state;
    if (!this.loading) this.loading = this.read().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async read(): Promise<A2aExtensionState> {
    try {
      const file = await fs.open(this.file, 'r');
      let value: unknown;
      try {
        if ((await file.stat()).size > 4096) throw new Error('Invalid A2A plugin configuration');
        value = JSON.parse(await file.readFile('utf8'));
      } finally { await file.close(); }
      const state = value as Partial<A2aExtensionState> | null;
      if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || typeof state.enabled !== 'boolean') {
        throw new Error('Invalid A2A plugin configuration');
      }
      this.state = { version: 1, revision: Number(state.revision), enabled: state.enabled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, revision: 0, enabled: false };
    }
    return this.state;
  }

  async getState(): Promise<A2aExtensionState> {
    await this.tail;
    return { ...await this.load() };
  }

  save(input: unknown): Promise<A2aExtensionState> {
    const operation = this.tail.then(async () => {
      const value = input as { enabled?: unknown; expectedRevision?: unknown } | null;
      if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.expectedRevision)) {
        throw Object.assign(new Error('Require enabled and expectedRevision'), { status: 400 });
      }
      const current = await this.load();
      if (current.revision !== value.expectedRevision) throw Object.assign(new Error('A2A settings changed; refresh before saving'), { status: 409 });
      if (current.enabled === value.enabled) return { ...current };
      const next: A2aExtensionState = { version: 1, enabled: value.enabled, revision: current.revision + 1 };
      if (!await atomicWriteJsonAsync(this.file, next, { mode: 0o600 })) throw new Error('A2A settings could not be saved');
      this.state = next;
      return { ...next };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async authorize(): Promise<number> {
    const state = await this.getState();
    if (!state.enabled) throw Object.assign(new Error('External A2A access is disabled; enable it in Plugins'), { status: 403 });
    return state.revision;
  }
}
