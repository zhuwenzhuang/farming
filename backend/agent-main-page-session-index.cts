'use strict';

import type {
  AgentRecord,
  PersistedAgentPrivateMetadata,
} from './agent-manager-record-types.js';
import { canonicalProviderSessionKey, mainPageAgentSessionKey } from './main-page-session.cjs';

type MainPageSessionConfig = {
  getMainPageSessionKeys?(): string[];
  getSettings?(): { mainPageSessionKeys?: unknown };
  rememberAgentSessionRecord?(agent: AgentRecord): string;
  removeMainPageSessionKeys?(keys: string[]): unknown;
  setMainPageSessionKeys?(keys: string[]): string[];
  updateSettings?(patch: { mainPageSessionKeys: string[] }): unknown;
};

type MainPageSessionPersistence = {
  assertRuntimeOwner(agent: AgentRecord): void;
  persist(agent: AgentRecord, patch?: Partial<PersistedAgentPrivateMetadata>): string;
};

type AgentMainPageSessionIndexOptions = {
  config: MainPageSessionConfig | null | undefined;
  persistence: MainPageSessionPersistence;
};

function setAgentRecordId(agent: AgentRecord, recordId: unknown): void {
  const normalized = typeof recordId === 'string' ? recordId.trim() : '';
  if (!normalized) return;
  agent.agentRecordId = normalized;
  agent.persistentSessionId = normalized;
}

class AgentMainPageSessionIndex {
  private readonly options: AgentMainPageSessionIndexOptions;

  constructor(options: AgentMainPageSessionIndexOptions) {
    this.options = options;
  }

  list(): string[] {
    const config = this.options.config;
    const persistedKeys: string[] = (() => {
      if (typeof config?.getMainPageSessionKeys === 'function') {
        return config.getMainPageSessionKeys();
      }
      if (typeof config?.getSettings === 'function') {
        const settings = config.getSettings();
        return Array.isArray(settings.mainPageSessionKeys)
          ? settings.mainPageSessionKeys.filter(
              (key: unknown): key is string => typeof key === 'string',
            )
          : [];
      }
      return [];
    })();
    return persistedKeys
      .map(key => canonicalProviderSessionKey(key))
      .filter(key => Boolean(key));
  }

  remember(agent: AgentRecord): void {
    const config = this.options.config;
    if (!agent || agent.wantsMain || !config) return;
    if (
      !agent.providerSessionProvider
      || !agent.providerSessionId
      || agent.providerSessionTemporary === true
    ) return;
    this.options.persistence.assertRuntimeOwner(agent);

    const sessionKey = mainPageAgentSessionKey(
      agent.providerSessionProvider,
      agent.providerSessionId,
      agent.providerHomeId || '',
    );
    if (!sessionKey) return;
    const currentKeys = this.list();
    if (currentKeys[0] === sessionKey) {
      this.options.persistence.persist(agent, { visibleOnMainPage: true, archived: false });
      return;
    }
    if (typeof config.rememberAgentSessionRecord === 'function') {
      setAgentRecordId(agent, config.rememberAgentSessionRecord(agent));
      return;
    }
    this.set([
      sessionKey,
      ...currentKeys.filter(key => key !== sessionKey),
    ]);
  }

  removeAgents(agents: readonly AgentRecord[]): string[] {
    const config = this.options.config;
    if (!config) return [];

    const keysToRemove = new Set<string>();
    agents.forEach(agent => {
      const providerSessionKey = canonicalProviderSessionKey(agent.providerSessionKey)
        || mainPageAgentSessionKey(
          agent.providerSessionProvider,
          agent.providerSessionId,
          agent.providerHomeId || '',
        );
      if (providerSessionKey) keysToRemove.add(providerSessionKey);
    });
    if (keysToRemove.size === 0) return [];

    const currentKeys = this.list();
    const removedKeys = currentKeys.filter(key => keysToRemove.has(key));
    if (removedKeys.length === 0) return [];
    if (typeof config.removeMainPageSessionKeys === 'function') {
      config.removeMainPageSessionKeys(removedKeys);
    } else {
      this.set(currentKeys.filter(key => !keysToRemove.has(key)));
    }
    return removedKeys;
  }

  private set(keys: string[]): string[] {
    const config = this.options.config;
    if (typeof config?.setMainPageSessionKeys === 'function') {
      return config.setMainPageSessionKeys(keys);
    }
    if (typeof config?.updateSettings === 'function') {
      config.updateSettings({ mainPageSessionKeys: keys });
      return keys;
    }
    return [];
  }
}

export { AgentMainPageSessionIndex };
