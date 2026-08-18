const express = require('express');

interface ExpressRequest {
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  setHeader(name: string, value: string): void;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
}

interface AvailableAgent {
  capabilities?: {
    supportsChat?: boolean;
  };
  category?: string;
  command?: string;
  description?: string;
  name?: string;
}

interface AgentHome {
  acpRuntime: unknown;
  id: string;
  newAgentDefaults: unknown;
  order: number;
  path: string;
}

interface AgentExtensionHomeInventorySnapshot {
  configuration: object;
  extensions: readonly object[];
}

interface RequestedProviderHome {
  error: string;
  home: { path: string } | null;
  status: number;
}

interface AgentExtensionRouterPort {
  agentExtensionInventory: {
    get(provider: string, homePath: string): Promise<AgentExtensionHomeInventorySnapshot>;
    retain(homes: Array<{ provider: string; path: string }>): Promise<void>;
  };
  configuredProviders(): readonly string[];
  getAgentLaunchProfile(provider: string): Record<string, unknown>;
  getAgentHomes(provider: string): readonly AgentHome[];
  getAvailableAgents(): readonly AvailableAgent[];
  getMainAgentSkillsCatalog(): unknown;
  getProviderAcpExecutablePolicy(provider: string): string;
  providerSupportsChat(provider: string): boolean;
  requestedProviderHome(provider: string, rawHomeId: unknown): RequestedProviderHome;
  rootIdForPath(homePath: string): string;
  slashCommandDiscoveryCache: {
    get(request: {
      provider: string;
      providerHomePath: string;
      workspace: string;
    }): Promise<unknown>;
  };
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function defaultAgentHome(): AgentHome {
  return {
    id: 'default',
    path: '',
    order: Number.MAX_SAFE_INTEGER,
    acpRuntime: { mode: 'managed', executable: '' },
    newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
  };
}

function createAgentExtensionRouter(service: AgentExtensionRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/skills', (_req, res) => {
    res.json({ skills: service.getMainAgentSkillsCatalog() });
  });

  router.get('/agent-extensions', async (_req, res) => {
    try {
      const availableAgents = service.getAvailableAgents()
        .filter(agent => agent.category === 'coding');
      const availableByProvider = new Map(availableAgents.map(agent => [
        String(agent.name || agent.command || '').trim().toLowerCase(),
        agent,
      ]));
      const retainedHomes: Array<{ provider: string; path: string }> = [];
      const agents = await Promise.all(service.configuredProviders().map(async provider => {
        const agent = availableByProvider.get(provider);
        const launchProfile = service.getAgentLaunchProfile(provider);
        const configuredHomes = service.getAgentHomes(provider);
        const homes = configuredHomes.length > 0 ? configuredHomes : [defaultAgentHome()];
        return {
          id: provider,
          name: agent?.name || provider,
          description: agent?.description || '',
          available: Boolean(agent),
          discoverySupported: true,
          acpExecutablePolicy: service.getProviderAcpExecutablePolicy(provider),
          launchDefaults: {
            homeId: typeof launchProfile.homeId === 'string' ? launchProfile.homeId : 'default',
            runtimeMode: launchProfile.runtimeMode === 'chat' ? 'chat' : 'terminal',
          },
          supportsChat: service.providerSupportsChat(provider),
          homes: await Promise.all(homes.map(async home => {
            if (home.path) retainedHomes.push({ provider, path: home.path });
            const inventory = await service.agentExtensionInventory.get(provider, home.path);
            return {
              id: home.id,
              path: home.path,
              order: home.order,
              acpRuntime: home.acpRuntime,
              newAgentDefaults: home.newAgentDefaults,
              configuration: {
                rootId: service.rootIdForPath(home.path),
                ...inventory.configuration,
              },
              extensions: inventory.extensions.map(extension => ({
                ...extension,
                rootId: service.rootIdForPath(home.path),
              })),
            };
          })),
        };
      }));
      await service.agentExtensionInventory.retain(retainedHomes);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ agents });
    } catch (caught) {
      const error = caughtError(caught);
      console.error('Failed to read Agent extension inventory:', error);
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ error: error.message || 'Failed to read Agent extensions' });
    }
  });

  router.get('/slash-commands', async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
    const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
    const requested = service.requestedProviderHome(provider, req.query.homeId);
    if (!requested.home) {
      res.status(requested.status).json({ error: requested.error });
      return;
    }
    try {
      const commands = await service.slashCommandDiscoveryCache.get({
        provider,
        providerHomePath: requested.home.path,
        workspace,
      });
      res.json({ commands });
    } catch (caught) {
      const error = caughtError(caught);
      console.error('Failed to discover slash commands:', error);
      res.status(500).json({ error: error.message || 'Failed to discover slash commands' });
    }
  });

  return router;
}

export {
  createAgentExtensionRouter,
  type AgentExtensionRouterPort,
};
