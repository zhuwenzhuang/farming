interface WorkspaceFileWatchClient {
  readyState: number;
  send(data: string): void;
}

type WorkspaceFileWatchEvent = Record<string, unknown>;
interface WorkspaceFileWatchSubscription {
  update(paths: readonly string[]): Promise<void>;
  close(): void | Promise<void>;
}

interface WorkspaceFileWatchControllerOptions {
  openState: number;
  resolveRoot(agentId: string): string;
  subscribe(
    root: string,
    paths: readonly string[],
    onEvent: (event: WorkspaceFileWatchEvent) => void,
  ): Promise<WorkspaceFileWatchSubscription>;
  logCleanupError(error: unknown): void;
  watchErrorMessage(error: unknown): string | null;
}

interface WorkspaceFileWatchLease {
  appliedPaths: string[];
  cancelled: boolean;
  cleanupStarted: boolean;
  desiredPaths: string[];
  ready: Promise<WorkspaceFileWatchSubscription | null>;
  subscription: WorkspaceFileWatchSubscription | null;
  updateQueue: Promise<void>;
}

type WorkspaceFileWatchLeases = Map<string, WorkspaceFileWatchLease>;

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((filePath, index) => filePath === right[index]);
}

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
    if (!lease.subscription || lease.cleanupStarted) return;
    lease.cleanupStarted = true;
    try {
      void Promise.resolve(lease.subscription.close()).catch(options.logCleanupError);
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
      if (existing) {
        if (!samePaths(existing.desiredPaths, normalizedPaths)) {
          existing.desiredPaths = normalizedPaths;
        }
        const requestedPaths = existing.desiredPaths;
        const update = existing.updateQueue.then(async () => {
          const subscription = await existing.ready;
          if (!subscription || !isCurrentLease(client, agentId, existing)) return;
          if (existing.desiredPaths !== requestedPaths) return;
          if (!samePaths(existing.appliedPaths, requestedPaths)) {
            await subscription.update(requestedPaths);
            existing.appliedPaths = requestedPaths;
          }
          if (existing.desiredPaths === requestedPaths && isCurrentLease(client, agentId, existing) && isOpen(client)) {
            sendWatching(client, agentId, existing.appliedPaths);
          }
        });
        existing.updateQueue = update.catch(() => {});
        await update;
        return;
      }

      const root = options.resolveRoot(agentId);
      let leases = leasesByClient.get(client);
      if (!leases) {
        leases = new Map();
        leasesByClient.set(client, leases);
      }
      const lease: WorkspaceFileWatchLease = {
        appliedPaths: [],
        cancelled: false,
        cleanupStarted: false,
        desiredPaths: normalizedPaths,
        ready: Promise.resolve(null),
        subscription: null,
        updateQueue: Promise.resolve(),
      };
      lease.ready = (async () => {
        const subscription = await options.subscribe(root, normalizedPaths, (event) => {
          if (!isCurrentLease(client, agentId, lease) || !isOpen(client)) return;
          client.send(JSON.stringify({
            type: 'workspace-file-event',
            event: {
              agentId,
              ...event,
            },
          }));
        });
        lease.subscription = subscription;
        lease.appliedPaths = normalizedPaths;
        if (!isCurrentLease(client, agentId, lease) || !isOpen(client)) {
          closeLease(lease);
          return null;
        }
        return subscription;
      })();
      leases.set(agentId, lease);

      try {
        const subscription = await lease.ready;
        if (
          subscription
          && lease.desiredPaths === lease.appliedPaths
          && isCurrentLease(client, agentId, lease)
          && isOpen(client)
        ) {
          sendWatching(client, agentId, lease.appliedPaths);
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
  type WorkspaceFileWatchSubscription,
};
