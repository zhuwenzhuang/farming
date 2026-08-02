import type { ManagedLanguageServerManager } from './managed-language-server-manager.cjs';

class LanguageServerService {
  private readonly managed: ManagedLanguageServerManager;

  constructor(managed: ManagedLanguageServerManager) {
    this.managed = managed;
  }

  async capability(_options: { force?: boolean } = {}): Promise<ReturnType<ManagedLanguageServerManager['capability']>> {
    return this.managed.capability();
  }

  async request(body: unknown): Promise<unknown> {
    return this.managed.request(body);
  }

  async dispose(): Promise<void> {
    await this.managed.dispose();
  }
}

export { LanguageServerService };
