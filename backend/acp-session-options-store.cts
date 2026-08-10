'use strict';

import type { AcpConfigChange } from './agent-manager-provider-types.js';

type UnknownRecord = Record<string, unknown>;

type AcpSessionOptionsRecord = {
  additionalDirectories: string[];
  configOverrides: AcpConfigChange[];
  mcpServers: UnknownRecord[];
};

function cloneConfigOverrides(value: AcpConfigChange[]): AcpConfigChange[] {
  return value.map(change => ({
    configId: change.configId,
    value: Array.isArray(change.value) ? [...change.value] : change.value,
  }));
}

function cloneOptions(value: AcpSessionOptionsRecord): AcpSessionOptionsRecord {
  return {
    additionalDirectories: [...value.additionalDirectories],
    configOverrides: cloneConfigOverrides(value.configOverrides),
    mcpServers: JSON.parse(JSON.stringify(value.mcpServers)) as UnknownRecord[],
  };
}

class AcpSessionOptionsStore {
  private readonly records = new Map<string, AcpSessionOptionsRecord>();

  get(sessionKey: string): AcpSessionOptionsRecord | undefined {
    const record = this.records.get(sessionKey);
    return record ? cloneOptions(record) : undefined;
  }

  set(sessionKey: string, options: AcpSessionOptionsRecord): void {
    this.records.set(sessionKey, cloneOptions(options));
  }

  has(sessionKey: string): boolean {
    return this.records.has(sessionKey);
  }

  delete(sessionKey: string): boolean {
    return this.records.delete(sessionKey);
  }

  clear(): void {
    this.records.clear();
  }
}

export {
  AcpSessionOptionsStore,
  type AcpSessionOptionsRecord,
};
