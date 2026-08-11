import * as path from 'path';
import {
  discoverAgentExtensions,
} from './agent-extension-discovery.cjs';
import type { AgentExtensionItem } from './agent-extension-discovery.cjs';
import {
  PROVIDER_CONFIGURATION_FILES,
  readProviderHomeConfiguration,
} from './provider-home-configuration.cjs';
import { AuthoritativeInventoryCache } from './authoritative-inventory-cache.cjs';

type ProviderHomeConfiguration = ReturnType<typeof readProviderHomeConfiguration>;

interface AgentExtensionHomeInventory {
  configuration: ProviderHomeConfiguration;
  extensions: AgentExtensionItem[];
}

interface AgentExtensionInventoryOptions {
  cacheFile: string;
  discoverExtensions?: typeof discoverAgentExtensions;
  readConfiguration?: typeof readProviderHomeConfiguration;
}

function extensionWatchPaths(provider: string, homePath: string): string[] {
  const configurationFiles = PROVIDER_CONFIGURATION_FILES[provider] || [];
  return [
    path.join(homePath, 'skills'),
    path.join(homePath, 'commands'),
    path.join(homePath, 'plugins'),
    path.join(homePath, 'hooks.json'),
    path.join(homePath, 'mcp.json'),
    ...configurationFiles.map(fileName => path.join(homePath, fileName)),
  ];
}

function inventoryKey(provider: string, homePath: string): string {
  return JSON.stringify({
    version: 3,
    provider,
    homePath: path.resolve(homePath),
  });
}

class AgentExtensionInventory {
  private readonly cache: AuthoritativeInventoryCache<AgentExtensionHomeInventory>;
  private readonly discoverExtensions: typeof discoverAgentExtensions;
  private readonly readConfiguration: typeof readProviderHomeConfiguration;

  constructor(options: AgentExtensionInventoryOptions) {
    this.discoverExtensions = options.discoverExtensions || discoverAgentExtensions;
    this.readConfiguration = options.readConfiguration || readProviderHomeConfiguration;
    this.cache = new AuthoritativeInventoryCache<AgentExtensionHomeInventory>({
      fingerprintOptions: { maxDepth: 12, maxEntries: 20_000 },
      refreshDebounceMs: 150,
      snapshotFile: options.cacheFile,
    });
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  close(): Promise<void> {
    return this.cache.close();
  }

  get(provider: string, homePath: string): Promise<AgentExtensionHomeInventory> {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const rawHomePath = String(homePath || '').trim();
    if (!rawHomePath) {
      return Promise.resolve({
        configuration: this.readConfiguration(normalizedProvider, ''),
        extensions: [],
      });
    }
    const normalizedHomePath = path.resolve(rawHomePath);
    const key = inventoryKey(normalizedProvider, normalizedHomePath);
    return this.cache.get(key, {
      watchPaths: extensionWatchPaths(normalizedProvider, normalizedHomePath),
      load: () => ({
        configuration: this.readConfiguration(normalizedProvider, normalizedHomePath),
        extensions: this.discoverExtensions({
          provider: normalizedProvider,
          providerHomePath: normalizedHomePath,
        }),
      }),
      validate: (value: unknown): value is AgentExtensionHomeInventory => Boolean(
        value
        && typeof value === 'object'
        && Array.isArray((value as AgentExtensionHomeInventory).extensions)
        && (value as AgentExtensionHomeInventory).configuration
        && typeof (value as AgentExtensionHomeInventory).configuration === 'object'
      ),
    });
  }

  retain(homes: Array<{ provider: string; path: string }>): Promise<void> {
    return this.cache.retain(new Set(homes.flatMap(home => {
      const homePath = String(home.path || '').trim();
      return homePath ? [inventoryKey(
        String(home.provider || '').trim().toLowerCase(),
        path.resolve(homePath),
      )] : [];
    })));
  }
}

export {
  AgentExtensionInventory,
  extensionWatchPaths,
};
export type {
  AgentExtensionHomeInventory,
  AgentExtensionInventoryOptions,
};
