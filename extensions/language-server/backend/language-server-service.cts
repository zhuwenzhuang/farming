import type { ManagedLanguageServerManager } from './managed-language-server-manager.cjs';
import type { VsCodeBridgeClient } from './vscode-bridge-client.cjs';

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

class LanguageServerService {
  private readonly managed: ManagedLanguageServerManager;
  private readonly bridge: VsCodeBridgeClient;

  constructor(
    managed: ManagedLanguageServerManager,
    bridge: VsCodeBridgeClient,
  ) {
    this.managed = managed;
    this.bridge = bridge;
  }

  async capability(_options: { force?: boolean } = {}): Promise<ReturnType<ManagedLanguageServerManager['capability']>> {
    return this.managed.capability();
  }

  async request(body: unknown): Promise<unknown> {
    try {
      return await this.managed.request(body);
    } catch (managedError) {
      const code = String(recordValue(managedError).code || '');
      if (![
        'LANGUAGE_SERVER_NOT_CONFIGURED',
        'LANGUAGE_SERVER_RUNTIME_UNAVAILABLE',
        'LANGUAGE_SERVER_JAVA_UNAVAILABLE',
        'LANGUAGE_SERVER_HIERARCHY_ITEM_EXPIRED',
      ].includes(code)) {
        throw managedError;
      }
      try {
        return await this.bridge.request(body);
      } catch {
        throw managedError;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.managed.dispose();
  }
}

export { LanguageServerService };
