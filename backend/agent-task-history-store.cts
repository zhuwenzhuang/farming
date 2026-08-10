'use strict';

type TaskHistoryEntry = Record<string, unknown>;

type AgentTaskHistoryConfig = {
  appendTaskHistory?(entry: TaskHistoryEntry): void;
  getTaskHistory?(): TaskHistoryEntry[];
};

class AgentTaskHistoryStore {
  private entries: TaskHistoryEntry[];
  private readonly config: AgentTaskHistoryConfig | null | undefined;

  constructor(config: AgentTaskHistoryConfig | null | undefined) {
    this.config = config;
    this.entries = typeof config?.getTaskHistory === 'function'
      ? [...config.getTaskHistory()].slice(0, 200)
      : [];
  }

  list(): TaskHistoryEntry[] {
    return [...this.entries];
  }

  append(entry: TaskHistoryEntry): void {
    const previousEntries = this.entries;
    this.entries = [entry, ...this.entries].slice(0, 200);
    try {
      this.config?.appendTaskHistory?.(entry);
    } catch (error) {
      this.entries = previousEntries;
      throw error;
    }
  }
}

export { AgentTaskHistoryStore };
