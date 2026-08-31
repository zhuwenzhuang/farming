import type {
  LanguageServerRequestMessage,
  WorkspaceCancelMessage,
  WorkspaceRequest,
  WorkspaceRequestMessage,
} from '../shared/browser-protocol.js';
import type { PerformanceTrace, PerformanceOperation } from '../shared/interaction-performance.js';

interface WorkspaceRequestClient {
  accessMode?: 'owner' | 'read-only' | 'none';
  bufferedAmount?: number;
  previewScopeId?: string;
  readyState: number;
  send(data: string): void;
}

interface WorkspaceRequestPorts {
  observeRequest?(operation: PerformanceOperation, requestId: string, kind: string): PerformanceTrace;
  openState: number;
  maxMessageBytes: number;
  executeWorkspace(
    request: WorkspaceRequest,
    accessMode: WorkspaceRequestClient['accessMode'],
    signal: AbortSignal,
    previewScopeId?: string,
  ): Promise<unknown>;
  executeLanguageServer(request: LanguageServerRequestMessage['request'], signal: AbortSignal): Promise<{
    result: unknown;
    supported?: boolean;
  }>;
  error(error: unknown): {
    code: string;
    message: string;
    status?: number;
    details?: unknown;
    uncertain?: boolean;
  };
}

type RequestLane = 'interactive' | 'background';

interface ScheduledRequest {
  trace?: PerformanceTrace;
  cancelled: boolean;
  controller: AbortController;
  lane: RequestLane;
  requestId: string;
  responseType: 'workspace-result' | 'language-server-result';
  started: boolean;
  run(): Promise<void>;
}

interface ClientSchedule {
  background: ScheduledRequest[];
  backgroundRunning: number;
  interactive: ScheduledRequest[];
  interactiveRunning: number;
  requests: Map<string, ScheduledRequest>;
}

const INTERACTIVE_LIMIT = 4;
const BACKGROUND_LIMIT = 2;
const GLOBAL_INTERACTIVE_LIMIT = 24;
const GLOBAL_BACKGROUND_LIMIT = 12;
const MAX_QUEUED_REQUESTS = 64;
const BACKPRESSURE_BYTES = 512 * 1024;

function workspaceRequestLane(request: WorkspaceRequest): RequestLane {
  switch (request.operation) {
    case 'search':
      // Global entry lookup is a current navigation intent, not background inventory.
      return request.scope === 'entries' ? 'interactive' : 'background';
    case 'tree':
    case 'read-file':
    case 'save-file':
    case 'move-entry':
    case 'create-entry':
    case 'rename-entry':
    case 'delete-entry':
    case 'switch-branch':
      return 'interactive';
    default:
      return 'background';
  }
}

function createWebSocketWorkspaceRequestHandlers<Client extends WorkspaceRequestClient>(
  ports: WorkspaceRequestPorts,
) {
  const schedules = new WeakMap<Client, ClientSchedule>();
  const activeClients = new Set<Client>();
  let globalInteractiveRunning = 0;
  let globalBackgroundRunning = 0;

  function scheduleFor(client: Client): ClientSchedule {
    let schedule = schedules.get(client);
    if (!schedule) {
      schedule = {
        background: [],
        backgroundRunning: 0,
        interactive: [],
        interactiveRunning: 0,
        requests: new Map(),
      };
      schedules.set(client, schedule);
      activeClients.add(client);
    }
    return schedule;
  }

  function send(client: Client, message: Record<string, unknown>): boolean {
    if (client.readyState !== ports.openState) return false;
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body, 'utf8') > ports.maxMessageBytes) {
      client.send(JSON.stringify({
        type: message.type,
        requestId: message.requestId,
        ok: false,
        error: {
          code: 'TOO_LARGE',
          message: 'Workspace result exceeds the inline WebSocket limit',
          status: 413,
        },
      }));
      return false;
    }
    client.send(body);
    return true;
  }

  function finish(client: Client, request: ScheduledRequest): void {
    if (request.started) {
      request.started = false;
      if (request.lane === 'interactive') globalInteractiveRunning -= 1;
      else globalBackgroundRunning -= 1;
    }
    const schedule = schedules.get(client);
    if (schedule) {
      if (schedule.requests.get(request.requestId) === request) schedule.requests.delete(request.requestId);
      if (request.lane === 'interactive') schedule.interactiveRunning -= 1;
      else schedule.backgroundRunning -= 1;
    }
    drainAll();
  }

  function start(client: Client, schedule: ClientSchedule, request: ScheduledRequest): void {
    if (request.cancelled) return;
    request.started = true;
    request.trace?.mark('dispatch');
    request.trace?.metric({ socketBytes: client.bufferedAmount || 0, pendingRequests: schedule.requests.size,
      interactiveRunning: globalInteractiveRunning, backgroundRunning: globalBackgroundRunning });
    if (request.lane === 'interactive') {
      schedule.interactiveRunning += 1;
      globalInteractiveRunning += 1;
    } else {
      schedule.backgroundRunning += 1;
      globalBackgroundRunning += 1;
    }
    void request.run().finally(() => finish(client, request));
  }

  function drain(client: Client, schedule = schedules.get(client)): void {
    if (!schedule) return;
    while (
      schedule.interactiveRunning < INTERACTIVE_LIMIT
      && globalInteractiveRunning < GLOBAL_INTERACTIVE_LIMIT
      && schedule.interactive.length > 0
    ) {
      const request = schedule.interactive.shift()!;
      if (request.cancelled) continue;
      start(client, schedule, request);
    }
    while (
      schedule.backgroundRunning < BACKGROUND_LIMIT
      && globalBackgroundRunning < GLOBAL_BACKGROUND_LIMIT
      && schedule.background.length > 0
    ) {
      const request = schedule.background.shift()!;
      if (request.cancelled) continue;
      start(client, schedule, request);
    }
  }

  function drainAll(): void {
    for (const client of activeClients) drain(client);
  }

  function enqueue(client: Client, request: ScheduledRequest): void {
    const schedule = scheduleFor(client);
    const previous = schedule.requests.get(request.requestId);
    if (previous) {
      request.trace?.end('failed');
      send(client, {
        type: request.responseType,
        requestId: request.requestId,
        ok: false,
        error: { code: 'CONFLICT', message: 'Workspace request ID is already in use', status: 409 },
      });
      return;
    }
    const queued = schedule.interactive.length + schedule.background.length;
    const backpressured = request.lane === 'background'
      && Number(client.bufferedAmount || 0) >= BACKPRESSURE_BYTES;
    if (queued >= MAX_QUEUED_REQUESTS || backpressured) {
      request.trace?.end('failed');
      send(client, {
        type: request.responseType,
        requestId: request.requestId,
        ok: false,
        error: { code: 'BUSY', message: 'Workspace request queue is busy', status: 503 },
      });
      return;
    }
    schedule.requests.set(request.requestId, request);
    schedule[request.lane].push(request);
    drain(client, schedule);
  }

  function workspaceRequest(client: Client, message: WorkspaceRequestMessage): void {
    const controller = new AbortController();
    const scheduled: ScheduledRequest = {
      trace: ports.observeRequest?.('workspace.request', message.requestId, message.request.operation),
      cancelled: false,
      controller,
      lane: workspaceRequestLane(message.request),
      requestId: message.requestId,
      responseType: 'workspace-result',
      started: false,
      async run() {
        try {
          const result = await ports.executeWorkspace(
            message.request,
            client.accessMode,
            controller.signal,
            client.previewScopeId,
          );
          if (scheduled.cancelled || controller.signal.aborted) return;
          scheduled.trace?.mark('service');
          const sent = send(client, { type: 'workspace-result', requestId: message.requestId, ok: true, result });
          scheduled.trace?.mark('sent'); scheduled.trace?.end(sent ? 'completed' : 'failed');
        } catch (error: unknown) {
          if (scheduled.cancelled || controller.signal.aborted) return;
          scheduled.trace?.end('failed');
          send(client, { type: 'workspace-result', requestId: message.requestId, ok: false, error: ports.error(error) });
        }
      },
    };
    enqueue(client, scheduled);
  }

  function languageServerRequest(client: Client, message: LanguageServerRequestMessage): void {
    const controller = new AbortController();
    const scheduled: ScheduledRequest = {
      trace: ports.observeRequest?.('language-server.request', message.requestId, message.request.operation),
      cancelled: false,
      controller,
      lane: message.request.operation === 'capability' || message.request.priority === 'background'
        ? 'background'
        : 'interactive',
      requestId: message.requestId,
      responseType: 'language-server-result',
      started: false,
      async run() {
        try {
          const response = await ports.executeLanguageServer(message.request, controller.signal);
          if (scheduled.cancelled || controller.signal.aborted) return;
          scheduled.trace?.mark('service');
          const sent = send(client, {
            type: 'language-server-result',
            requestId: message.requestId,
            ok: true,
            result: response.result,
            supported: response.supported !== false,
          });
          scheduled.trace?.mark('sent'); scheduled.trace?.end(sent ? 'completed' : 'failed');
        } catch (error: unknown) {
          if (scheduled.cancelled || controller.signal.aborted) return;
          scheduled.trace?.end('failed');
          send(client, { type: 'language-server-result', requestId: message.requestId, ok: false, error: ports.error(error) });
        }
      },
    };
    enqueue(client, scheduled);
  }

  function cancel(client: Client, message: WorkspaceCancelMessage): void {
    const request = schedules.get(client)?.requests.get(message.requestId);
    if (!request) return;
    request.cancelled = true;
    request.trace?.end('cancelled');
    request.controller.abort();
    schedules.get(client)?.requests.delete(message.requestId);
  }

  function close(client: Client): void {
    const schedule = schedules.get(client);
    if (!schedule) return;
    for (const request of schedule.requests.values()) {
      request.cancelled = true;
      request.trace?.end('cancelled');
      request.controller.abort();
    }
    schedule.requests.clear();
    schedule.interactive.length = 0;
    schedule.background.length = 0;
    schedules.delete(client);
    activeClients.delete(client);
  }

  return { workspaceRequest, languageServerRequest, cancel, close };
}

export {
  createWebSocketWorkspaceRequestHandlers,
  type WorkspaceRequestClient,
  type WorkspaceRequestPorts,
};
