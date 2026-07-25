const MAX_LIFECYCLE_OPERATIONS = 32;
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled']);

function compactLifecycleEntries(entries) {
  const recentIds = new Set(entries.slice(-MAX_LIFECYCLE_OPERATIONS).map(operation => operation.id));
  return entries.filter(operation => (
    recentIds.has(operation.id)
    || operation.requestKey.startsWith('create-request:')
  ));
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== 'object') return null;
  const id = String(operation.id || '').trim();
  const type = String(operation.type || '').trim();
  const state = String(operation.state || '').trim();
  if (!id || !type || !state) return null;
  return {
    id,
    type,
    state,
    requestKey: String(operation.requestKey || ''),
    request: operation.request && typeof operation.request === 'object'
      ? JSON.parse(JSON.stringify(operation.request))
      : {},
    result: operation.result && typeof operation.result === 'object'
      ? JSON.parse(JSON.stringify(operation.result))
      : null,
    startedAt: Number(operation.startedAt) || 0,
    updatedAt: Number(operation.updatedAt) || 0,
    finishedAt: Number(operation.finishedAt) || null,
    error: String(operation.error || ''),
  };
}

function lifecycleJournal(source) {
  const raw = source?.lifecycleJournal;
  const entries = Array.isArray(raw?.entries)
    ? compactLifecycleEntries(raw.entries.map(normalizeOperation).filter(Boolean))
    : [];
  return {
    sequence: Math.max(0, Math.floor(Number(raw?.sequence) || 0)),
    entries,
  };
}

function activeLifecycleOperation(source) {
  const journal = lifecycleJournal(source);
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const operation = journal.entries[index];
    if (!TERMINAL_OPERATION_STATES.has(operation.state)) return operation;
  }
  return null;
}

function latestLifecycleOperation(source) {
  const entries = lifecycleJournal(source).entries;
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function beginLifecycleOperation(source, type, requestKey, request = {}, now = Date.now()) {
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
    request: request && typeof request === 'object' ? JSON.parse(JSON.stringify(request)) : {},
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

function transitionLifecycleOperation(source, operationId, state, error = '', now = Date.now()) {
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

function setLifecycleOperationResult(source, operationId, result, now = Date.now()) {
  const journal = lifecycleJournal(source);
  const operation = journal.entries.find(candidate => candidate.id === operationId);
  if (!operation) return null;
  operation.result = result && typeof result === 'object'
    ? JSON.parse(JSON.stringify(result))
    : null;
  operation.updatedAt = now;
  source.lifecycleJournal = journal;
  return operation;
}

module.exports = {
  MAX_LIFECYCLE_OPERATIONS,
  TERMINAL_OPERATION_STATES,
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  lifecycleJournal,
  setLifecycleOperationResult,
  transitionLifecycleOperation,
};
