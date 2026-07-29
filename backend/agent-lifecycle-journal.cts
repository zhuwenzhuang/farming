const MAX_LIFECYCLE_OPERATIONS = 32;
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled']);

interface LifecyclePreviousState extends Record<string, unknown> {
  acpAdditionalDirectories?: string[];
  acpMcpServers?: unknown[];
}

interface LifecycleOperationRequest extends Record<string, unknown> {
  force?: boolean;
  previousRuntimeAgentId?: string;
  previousState?: LifecyclePreviousState;
  signature?: string;
  workspace?: string;
}

interface LifecycleOperation {
  id: string;
  type: string;
  state: string;
  requestKey: string;
  request: LifecycleOperationRequest;
  result: Record<string, unknown> | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error: string;
}

interface LifecycleJournal {
  sequence: number;
  entries: LifecycleOperation[];
}

interface LifecycleSource {
  lifecycleJournal?: unknown;
}

interface RawLifecycleJournal {
  sequence?: unknown;
  entries?: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cloneRecord(value: unknown): LifecycleOperationRequest | null {
  const record = objectRecord(value);
  return record ? JSON.parse(JSON.stringify(record)) as LifecycleOperationRequest : null;
}

function compactLifecycleEntries(entries: LifecycleOperation[]): LifecycleOperation[] {
  const recentIds = new Set(entries.slice(-MAX_LIFECYCLE_OPERATIONS).map(operation => operation.id));
  return entries.filter(operation => (
    recentIds.has(operation.id)
    || operation.requestKey.startsWith('create-request:')
  ));
}

function normalizeOperation(operation: unknown): LifecycleOperation | null {
  const record = objectRecord(operation);
  if (!record) return null;
  const id = String(record.id || '').trim();
  const type = String(record.type || '').trim();
  const state = String(record.state || '').trim();
  if (!id || !type || !state) return null;
  return {
    id,
    type,
    state,
    requestKey: String(record.requestKey || ''),
    request: cloneRecord(record.request) || {},
    result: cloneRecord(record.result),
    startedAt: Number(record.startedAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
    finishedAt: Number(record.finishedAt) || null,
    error: String(record.error || ''),
  };
}

function lifecycleJournal(source: LifecycleSource | null | undefined): LifecycleJournal {
  const raw = objectRecord(source?.lifecycleJournal) as RawLifecycleJournal | null;
  const entries = Array.isArray(raw?.entries)
    ? compactLifecycleEntries(
        raw.entries.map(normalizeOperation).filter(
          (operation): operation is LifecycleOperation => operation !== null,
        ),
      )
    : [];
  return {
    sequence: Math.max(0, Math.floor(Number(raw?.sequence) || 0)),
    entries,
  };
}

function activeLifecycleOperation(source: LifecycleSource | null | undefined): LifecycleOperation | null {
  const journal = lifecycleJournal(source);
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const operation = journal.entries[index];
    if (!TERMINAL_OPERATION_STATES.has(operation.state)) return operation;
  }
  return null;
}

function latestLifecycleOperation(source: LifecycleSource | null | undefined): LifecycleOperation | null {
  const entries = lifecycleJournal(source).entries;
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function beginLifecycleOperation(
  source: LifecycleSource,
  type: unknown,
  requestKey: unknown,
  request: unknown = {},
  now = Date.now(),
): (
  | { operation: LifecycleOperation; joined: boolean; conflict?: undefined }
  | { conflict: LifecycleOperation; operation?: undefined; joined?: false }
) {
  const journal = lifecycleJournal(source);
  const active = activeLifecycleOperation({ lifecycleJournal: journal });
  if (active) {
    if (active.type === type && active.requestKey === String(requestKey || '')) {
      source.lifecycleJournal = journal;
      return { operation: active, joined: true };
    }
    return { conflict: active };
  }

  journal.sequence += 1;
  const operation = {
    id: `aop_${journal.sequence}`,
    type: String(type || ''),
    state: 'pending',
    requestKey: String(requestKey || ''),
    request: cloneRecord(request) || {},
    result: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: '',
  };
  journal.entries.push(operation);
  journal.entries = compactLifecycleEntries(journal.entries);
  source.lifecycleJournal = journal;
  return { operation, joined: false };
}

function transitionLifecycleOperation(
  source: LifecycleSource,
  operationId: string,
  state: unknown,
  error: unknown = '',
  now = Date.now(),
): LifecycleOperation | null {
  const journal = lifecycleJournal(source);
  const operation = journal.entries.find(candidate => candidate.id === operationId);
  if (!operation) return null;
  if (TERMINAL_OPERATION_STATES.has(operation.state)) return operation;
  operation.state = String(state || operation.state);
  operation.error = String(error || '');
  operation.updatedAt = now;
  operation.finishedAt = TERMINAL_OPERATION_STATES.has(operation.state) ? now : null;
  if (
    operation.type === 'create'
    && operation.finishedAt !== null
    && operation.request
    && Object.prototype.hasOwnProperty.call(operation.request, 'previousState')
  ) {
    delete operation.request.previousState;
  }
  source.lifecycleJournal = journal;
  return operation;
}

function setLifecycleOperationResult(
  source: LifecycleSource,
  operationId: string,
  result: unknown,
  now = Date.now(),
): LifecycleOperation | null {
  const journal = lifecycleJournal(source);
  const operation = journal.entries.find(candidate => candidate.id === operationId);
  if (!operation) return null;
  operation.result = cloneRecord(result);
  operation.updatedAt = now;
  source.lifecycleJournal = journal;
  return operation;
}

export {
  MAX_LIFECYCLE_OPERATIONS,
  TERMINAL_OPERATION_STATES,
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  lifecycleJournal,
  setLifecycleOperationResult,
  transitionLifecycleOperation,
};
