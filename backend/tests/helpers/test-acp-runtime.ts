const { EventEmitter } = require('events');

function unavailable(operation: string): never {
  throw new Error(`Test ACP runtime does not implement ${operation}`);
}

function createTestAcpRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = Object.assign(new EventEmitter(), {
    bindings: new Map(),
    sessions: new Map(),
    turnCompletionEvents: true,
    initialize: async () => {},
    publishRecoveredBindings: () => {},
    bindingEpoch: () => '',
    bindingCheckpoint: () => unavailable('bindingCheckpoint'),
    createSessionIdentity: async () => unavailable('createSessionIdentity'),
    prepareAgent: async () => unavailable('prepareAgent'),
    reconnectAgent: async () => unavailable('reconnectAgent'),
    submitMessage: async () => unavailable('submitMessage'),
    cancel: async () => unavailable('cancel'),
    getSession: () => unavailable('getSession'),
    getSessionForRead: async () => unavailable('getSessionForRead'),
    getTranscriptSessionForRead: async () => unavailable('getTranscriptSessionForRead'),
    getTranscriptEntryForRead: async () => unavailable('getTranscriptEntryForRead'),
    getToolEntryForRead: async () => unavailable('getToolEntryForRead'),
    getSubagentTranscriptSessionForRead: async () => unavailable('getSubagentTranscriptSessionForRead'),
    getSessionRequestOptions: () => ({ cwd: '', additionalDirectories: [], mcpServers: [] }),
    hasBinding: () => false,
    registerBindingCallbacks: () => {},
    runWithForkReservation: async () => unavailable('runWithForkReservation'),
    forkSession: async () => unavailable('forkSession'),
    deleteSession: async () => unavailable('deleteSession'),
    closeSession: async () => unavailable('closeSession'),
    listSessions: async () => unavailable('listSessions'),
    setSessionMode: async () => unavailable('setSessionMode'),
    setSessionConfigOption: async () => unavailable('setSessionConfigOption'),
    setSessionConfigOptions: async () => unavailable('setSessionConfigOptions'),
    respondPermission: async () => unavailable('respondPermission'),
    respondElicitation: async () => unavailable('respondElicitation'),
    authenticate: async () => unavailable('authenticate'),
    logout: async () => unavailable('logout'),
    killTerminal: async () => unavailable('killTerminal'),
    inputTerminal: async () => unavailable('inputTerminal'),
    resizeTerminal: async () => unavailable('resizeTerminal'),
    cancelSubagent: async () => unavailable('cancelSubagent'),
    decidePatch: async () => unavailable('decidePatch'),
    transcriptSettled: () => true,
    unregisterAgent: () => {},
    unregisterAgentAndWait: async () => false,
    dispose: async () => {},
    disconnect: () => {},
    resumeAfterDisposeAbort: () => {},
  }, overrides);
  return runtime;
}

type AgentManagerConstructor = new (
  config: unknown,
  options?: Record<string, unknown>,
) => object;

function createTestAgentManager<T extends AgentManagerConstructor>(
  AgentManager: T,
  config: ConstructorParameters<T>[0],
  options: Record<string, unknown> = {},
): InstanceType<T> {
  return Reflect.construct(
    AgentManager,
    [config, { acpRuntime: createTestAcpRuntime(), ...options }],
  ) as InstanceType<T>;
}

export { createTestAcpRuntime, createTestAgentManager };
