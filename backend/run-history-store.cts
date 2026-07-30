const fs = require('fs');
import { atomicWriteJson } from './atomic-json-store.cjs';
import * as storageLayout from './storage-layout.cjs';

type RunHistoryEntry = Record<string, unknown>;

interface RunHistoryStoreOptions {
  normalizeTaskHistory?: (entries: unknown) => RunHistoryEntry[];
  writeJson?: (filePath: string, value: unknown) => void;
}

class RunHistoryStore {
  private readonly configDir: string;
  private readonly historyDir: string;
  private readonly normalizeTaskHistory: (entries: unknown) => RunHistoryEntry[];
  private readonly runsFile: string;
  private readonly writeJson: (filePath: string, value: unknown) => void;
  private entries: RunHistoryEntry[] | null = null;

  constructor(configDir: string, options: RunHistoryStoreOptions = {}) {
    this.configDir = configDir;
    this.historyDir = storageLayout.historyDir(configDir);
    this.runsFile = storageLayout.runHistoryFile(configDir);
    this.normalizeTaskHistory = typeof options.normalizeTaskHistory === 'function'
      ? options.normalizeTaskHistory
      : entries => (Array.isArray(entries) ? entries.slice(0, 200) : []);
    this.writeJson = typeof options.writeJson === 'function' ? options.writeJson : atomicWriteJson;
  }

  init({ legacyTaskHistory = [] }: { legacyTaskHistory?: unknown } = {}): void {
    fs.mkdirSync(this.historyDir, { recursive: true });
    const current = this.readEntries();
    const nextEntries = current.length > 0
      ? current
      : this.normalizeTaskHistory(legacyTaskHistory);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
  }

  readEntries(): RunHistoryEntry[] {
    try {
      if (!fs.existsSync(this.runsFile)) return [];
      return this.normalizeTaskHistory(JSON.parse(fs.readFileSync(this.runsFile, 'utf8')));
    } catch (error: unknown) {
      console.warn(
        'Failed to read Farming run history:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  ensureEntries(): RunHistoryEntry[] {
    if (!this.entries) this.init();
    return this.entries ?? [];
  }

  writeEntries(entries: RunHistoryEntry[] = this.ensureEntries()): void {
    this.writeJson(this.runsFile, entries);
  }

  getEntries(): RunHistoryEntry[] {
    return this.ensureEntries().slice();
  }

  setEntries(entries: unknown): RunHistoryEntry[] {
    const nextEntries = this.normalizeTaskHistory(entries);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
    return this.getEntries();
  }

  appendEntry(entry: RunHistoryEntry): RunHistoryEntry[] {
    const nextEntries = this.normalizeTaskHistory([entry, ...this.ensureEntries()]);
    this.writeEntries(nextEntries);
    this.entries = nextEntries;
    return this.getEntries();
  }
}

export {
  RunHistoryStore,
};
