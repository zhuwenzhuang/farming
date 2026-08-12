interface WorkspaceFileWatchClient {
  readyState: number;
  send(data: string): void;
}

type WorkspaceFileWatchEvent = Record<string, unknown>;
type WorkspaceFileWatchUnsubscribe = () => void | Promise<void>;

interface WorkspaceFileWatchControllerOptions {
  openState: number;
  resolveRoot(agentId: string): string;
  subscribe(
    root: string,
    paths: readonly string[],
    onEvent: (event: WorkspaceFileWatchEvent) => void,
  ): Promise<WorkspaceFileWatchUnsubscribe>;
  logCleanupError(error: unknown): void;
  watchErrorMessage(error: unknown): string | null;
}

interface WorkspaceFileWatchLease {
  cancelled: boolean;
  cleanupStarted: boolean;
  paths: string[];
  ready: Promise<boolean> | null;
  unsubscribe: WorkspaceFileWatchUnsubscribe | null;
}

type WorkspaceFileWatchLeases = Map<string, WorkspaceFileWatchLease>;

interface WorkspaceFileWatchController<Client extends WorkspaceFileWatchClient = WorkspaceFileWatchClient> {
  watch(client: Client, agentId: string, paths: readonly string[]): Promise<void>;
  unwatch(client: Client, agentId?: string | null): void;
  close(client: Client): void;
}

function createWorkspaceFileWatchController<Client extends WorkspaceFileWatchClient = WorkspaceFileWatchClient>(
  options: WorkspaceFileWatchControllerOptions,
): WorkspaceFileWatchController<Client> {
  // Map membership plus lease identity is authoritative. Unwatch detaches a
  // lease before cleanup so a late subscription can only release itself.
  const leasesByClient = new WeakMap<Client, WorkspaceFileWatchLeases>();

  function isOpen(client: Client): boolean {
    return client.readyState === options.openState;
  }

  function isCurrentLease(
    client: Client,
    agentId: string,
    lease: WorkspaceFileWatchLease,
  ): boolean {
    return !lease.cancelled && leasesByClient.get(client)?.get(agentId) === lease;
  }

  function closeLease(lease: WorkspaceFileWatchLease): void {
    lease.cancelled = true;
    if (!lease.unsubscribe || lease.cleanupStarted) return;
    lease.cleanupStarted = true;
    try {
      void Promise.resolve(lease.unsubscribe()).catch(options.logCleanupError);
    } catch (error: unknown) {
      options.logCleanupError(error);
    }
  }

  function releaseEmptyLeaseMap(
    client: Client,
    leases: WorkspaceFileWatchLeases,
  ): void {
    if (leases.size === 0 && leasesByClient.get(client) === leases) {
      leasesByClient.delete(client);
    }
  }

  function sendWatching(client: Client, agentId: string, paths: readonly string[]): void {
    client.send(JSON.stringify({
      type: 'workspace-file-watch',
      agentId,
      paths,
      watching: true,
    }));
  }

  function sendErrorMessage(client: Client, message: string): void {
    if (!isOpen(client)) return;
    client.send(JSON.stringify({ type: 'error', message }));
  }

  function sendWatchError(client: Client, error: unknown): void {
    if (!isOpen(client)) return;
    const message = options.watchErrorMessage(error) ?? 'failed to watch workspace files';
    client.send(JSON.stringify({ type: 'error', message }));
  }

  function unwatch(
    client: Client,
    agentId: string | null = null,
  ): void {
    const leases = leasesByClient.get(client);
    if (!leases) return;

    const entries: Array<[string, WorkspaceFileWatchLease | undefined]> = agentId
      ? [[agentId, leases.get(agentId)]]
      : Array.from(leases.entries());

    entries.forEach(([watchedAgentId, lease]) => {
      if (!lease) return;
      if (leases.get(watchedAgentId) === lease) leases.delete(watchedAgentId);
      closeLease(lease);
    });
    releaseEmptyLeaseMap(client, leases);
  }

  async function watch(client: Client, agentId: string, paths: readonly string[]): Promise<void> {
    try {
      if (!agentId) {
        sendErrorMessage(client, 'agentId is required');
        return;
      }
      const normalizedPaths = Array.from(new Set(paths)).sort();
      if (normalizedPaths.length === 0) {
        sendErrorMessage(client, 'at least one file path is required');
        return;
      }

      const existing = leasesByClient.get(client)?.get(agentId);
      if (existing && existing.paths.length === normalizedPaths.length
        && existing.paths.every((filePath, index) => filePath === normalizedPaths[index])) {
        const watching = await existing.ready;
        if (watching && isCurrentLease(client, agentId, existing) && isOpen(client)) {
          sendWatching(client, agentId, existing.paths);
        }
        return;
      }
      if (existing) unwatch(client, agentId);

      const root = options.resolveRoot(agentId);
      let leases = leasesByClient.get(client);
      if (!leases) {
        leases = new Map();
        leasesByClient.set(client, leases);
      }
      const lease: WorkspaceFileWatchLease = {
        cancelled: false,
        cleanupStarted: false,
        paths: normalizedPaths,
        ready: null,
        unsubscribe: null,
      };
      lease.ready = (async () => {
        const unsubscribe = await options.subscribe(root, normalizedPaths, (event) => {
          if (!isCurrentLease(client, agentId, lease) || !isOpen(client)) return;
          client.send(JSON.stringify({
            type: 'workspace-file-event',
            event: {
              agentId,
              ...event,
            },
          }));
        });
        lease.unsubscribe = unsubscribe;
        if (!isCurrentLease(client, agentId, lease) || !isOpen(client)) {
          closeLease(lease);
          return false;
        }
        return true;
      })();
      leases.set(agentId, lease);

      try {
        const watching = await lease.ready;
        if (watching && isCurrentLease(client, agentId, lease) && isOpen(client)) {
          sendWatching(client, agentId, lease.paths);
        }
      } catch (error: unknown) {
        if (leases.get(agentId) === lease) leases.delete(agentId);
        closeLease(lease);
        releaseEmptyLeaseMap(client, leases);
        throw error;
      }
    } catch (error: unknown) {
      sendWatchError(client, error);
    }
  }

  return {
    watch,
    unwatch,
    close(client) {
      unwatch(client);
    },
  };
}

export {
  createWorkspaceFileWatchController,
  type WorkspaceFileWatchClient,
  type WorkspaceFileWatchController,
  type WorkspaceFileWatchControllerOptions,
  type WorkspaceFileWatchEvent,
  type WorkspaceFileWatchUnsubscribe,
};
