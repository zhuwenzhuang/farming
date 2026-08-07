declare const module: { exports: Record<string, unknown> } | undefined;

(function attachTerminalReplay(global) {
  type TerminalReplayTransition = {
    kind?: 'output' | 'resize' | 'clear';
    data?: string;
    runtimeEpoch?: string;
    outputSeq?: number | null;
    stateRevision?: number | null;
    cols?: number;
    rows?: number;
  };

  type ValidTerminalReplayTransition = TerminalReplayTransition & {
    runtimeEpoch: string;
    outputSeq: number;
    stateRevision: number;
  };

  type TerminalReplayCheckpoint = {
    runtimeEpoch: string;
    outputSeq: number;
    stateRevision: number;
    cols: number;
    rows: number;
  };

  type TerminalReplayOptions = Partial<Pick<TerminalReplayState,
    | 'maxQueuedTransitions'
    | 'maxQueuedBytes'
    | 'retryBaseMs'
    | 'retryMaxMs'
    | 'maxTransportFailures'
    | 'maxIdenticalInvariantFailures'
  >>;

  type TerminalReplayState = {
    runtimeEpoch: string;
    outputSeq: number | null;
    stateRevision: number | null;
    replayTargetEpoch: string;
    replayTargetRevision: number | null;
    recovering: boolean;
    queuedTransitions: ValidTerminalReplayTransition[];
    queuedBytes: number;
    retiredRuntimeEpochs: Set<string>;
    failureCount: number;
    transportFailureCount: number;
    invariantFailureSignature: string;
    invariantFailureCount: number;
    halted: boolean;
    haltMessage: string;
    maxQueuedTransitions: number;
    maxQueuedBytes: number;
    retryBaseMs: number;
    retryMaxMs: number;
    maxTransportFailures: number;
    maxIdenticalInvariantFailures: number;
  };

  type TerminalReplayDecision = {
    action: 'apply' | 'drop' | 'recover' | 'current' | 'install' | 'reject';
    reason?: string;
    signature?: string;
    message?: string;
  };

  type TerminalReplayFailure = {
    halted: boolean;
    delay: number;
    message: string;
  };

  type TerminalReplayApi = {
    createState: (options?: TerminalReplayOptions) => TerminalReplayState;
    compareRuntimeEpochs: typeof compareRuntimeEpochs;
    beginRecovery: typeof beginRecovery;
    isReplayTargetPending: typeof isReplayTargetPending;
    classifyTransition: typeof classifyTransition;
    queueTransition: typeof queueTransition;
    takeQueuedTransition: typeof takeQueuedTransition;
    clearQueuedTransitions: typeof clearQueuedTransitions;
    evaluateCheckpoint: typeof evaluateCheckpoint;
    commitCheckpoint: typeof commitCheckpoint;
    commitTransition: typeof commitTransition;
    recordTransportFailure: typeof recordTransportFailure;
    recordInvariantFailure: typeof recordInvariantFailure;
    resetRecovery: typeof resetRecovery;
  };

  const RUNTIME_EPOCH_PATTERN = /^farming-runtime-v1:(\d{20}):/;
  const DEFAULT_MAX_QUEUED_TRANSITIONS = 512;
  const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
  const DEFAULT_RETRY_BASE_MS = 250;
  const DEFAULT_RETRY_MAX_MS = 5000;
  const DEFAULT_MAX_TRANSPORT_FAILURES = 3;
  const DEFAULT_MAX_IDENTICAL_INVARIANT_FAILURES = 3;

  function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function runtimeEpochGeneration(runtimeEpoch: unknown): number | null {
    const match = RUNTIME_EPOCH_PATTERN.exec(String(runtimeEpoch || ''));
    if (!match) return null;
    const generation = Number(match[1]);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
  }

  function compareRuntimeEpochs(left: string, right: string): -1 | 0 | 1 | null {
    if (left === right) return 0;
    const leftGeneration = runtimeEpochGeneration(left);
    const rightGeneration = runtimeEpochGeneration(right);
    if (leftGeneration === null || rightGeneration === null || leftGeneration === rightGeneration) {
      return null;
    }
    return leftGeneration < rightGeneration ? -1 : 1;
  }

  function byteLength(value: unknown): number {
    const text = String(value || '');
    if (typeof global.TextEncoder === 'function') {
      return new global.TextEncoder().encode(text).byteLength;
    }
    return encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, 'x').length;
  }

  function createState(options: TerminalReplayOptions = {}): TerminalReplayState {
    return {
      runtimeEpoch: '',
      outputSeq: null,
      stateRevision: null,
      replayTargetEpoch: '',
      replayTargetRevision: null,
      recovering: false,
      queuedTransitions: [],
      queuedBytes: 0,
      retiredRuntimeEpochs: new Set(),
      failureCount: 0,
      transportFailureCount: 0,
      invariantFailureSignature: '',
      invariantFailureCount: 0,
      halted: false,
      haltMessage: '',
      maxQueuedTransitions: options.maxQueuedTransitions || DEFAULT_MAX_QUEUED_TRANSITIONS,
      maxQueuedBytes: options.maxQueuedBytes || DEFAULT_MAX_QUEUED_BYTES,
      retryBaseMs: options.retryBaseMs || DEFAULT_RETRY_BASE_MS,
      retryMaxMs: options.retryMaxMs || DEFAULT_RETRY_MAX_MS,
      maxTransportFailures: options.maxTransportFailures || DEFAULT_MAX_TRANSPORT_FAILURES,
      maxIdenticalInvariantFailures:
        options.maxIdenticalInvariantFailures || DEFAULT_MAX_IDENTICAL_INVARIANT_FAILURES,
    };
  }

  function isTransitionValid(event: TerminalReplayTransition | null | undefined): event is ValidTerminalReplayTransition {
    return event !== null
      && event !== undefined
      && Boolean(event.runtimeEpoch)
      && isFiniteNumber(event.outputSeq)
      && isFiniteNumber(event.stateRevision)
      && (
        event.kind !== 'resize'
        || (isFiniteNumber(event.cols) && isFiniteNumber(event.rows))
      );
  }

  function isCheckpointValid(checkpoint: TerminalReplayCheckpoint | null | undefined): checkpoint is TerminalReplayCheckpoint {
    return checkpoint !== null
      && checkpoint !== undefined
      && Boolean(checkpoint.runtimeEpoch)
      && isFiniteNumber(checkpoint.outputSeq)
      && isFiniteNumber(checkpoint.stateRevision)
      && isFiniteNumber(checkpoint.cols)
      && isFiniteNumber(checkpoint.rows)
      && checkpoint.cols > 0
      && checkpoint.rows > 0;
  }

  function noteReplayTarget(state: TerminalReplayState, event?: TerminalReplayTransition): void {
    if (!event || !event.runtimeEpoch || !isFiniteNumber(event.stateRevision)) return;
    if (!state.replayTargetEpoch) {
      state.replayTargetEpoch = event.runtimeEpoch;
      state.replayTargetRevision = event.stateRevision;
      return;
    }
    if (event.runtimeEpoch === state.replayTargetEpoch) {
      state.replayTargetRevision = Math.max(state.replayTargetRevision || 0, event.stateRevision);
      return;
    }
    const relation = compareRuntimeEpochs(event.runtimeEpoch, state.replayTargetEpoch);
    if (relation === 1) {
      state.replayTargetEpoch = event.runtimeEpoch;
      state.replayTargetRevision = event.stateRevision;
    }
  }

  function beginRecovery(state: TerminalReplayState, event?: TerminalReplayTransition): void {
    state.recovering = true;
    noteReplayTarget(state, event);
  }

  function isReplayTargetPending(state: TerminalReplayState): boolean {
    if (!state.replayTargetEpoch || !isFiniteNumber(state.replayTargetRevision)) return false;
    if (!state.runtimeEpoch || !isFiniteNumber(state.stateRevision)) return true;
    if (state.runtimeEpoch === state.replayTargetEpoch) {
      return state.stateRevision < state.replayTargetRevision;
    }
    return compareRuntimeEpochs(state.runtimeEpoch, state.replayTargetEpoch) !== 1;
  }

  function classifyTransition(state: TerminalReplayState, event: TerminalReplayTransition): TerminalReplayDecision {
    if (!isTransitionValid(event)) {
      beginRecovery(state, event);
      return { action: 'recover', reason: 'invalid-transition' };
    }
    if (state.retiredRuntimeEpochs.has(event.runtimeEpoch)) {
      return { action: 'drop', reason: 'retired-epoch' };
    }
    if (state.runtimeEpoch && event.runtimeEpoch !== state.runtimeEpoch) {
      const relation = compareRuntimeEpochs(event.runtimeEpoch, state.runtimeEpoch);
      if (relation === -1) return { action: 'drop', reason: 'older-epoch' };
      beginRecovery(state, event);
      return { action: 'recover', reason: 'epoch-change' };
    }
    if (!state.runtimeEpoch || !isFiniteNumber(state.outputSeq) || !isFiniteNumber(state.stateRevision)) {
      beginRecovery(state, event);
      return { action: 'recover', reason: 'missing-cursor' };
    }
    if (event.stateRevision <= state.stateRevision) {
      return { action: 'drop', reason: 'duplicate' };
    }

    const outputAdvance = event.kind === 'output' ? 1 : 0;
    if (
      event.stateRevision !== state.stateRevision + 1
      || event.outputSeq !== state.outputSeq + outputAdvance
    ) {
      beginRecovery(state, event);
      return { action: 'recover', reason: 'sequence-gap' };
    }
    return { action: 'apply' };
  }

  function queueTransition(state: TerminalReplayState, event: TerminalReplayTransition): { queued: boolean; overflow: boolean } {
    if (!isTransitionValid(event)) {
      beginRecovery(state, event);
      return { queued: false, overflow: false };
    }
    noteReplayTarget(state, event);
    const bytes = byteLength(event.data);
    if (
      state.queuedTransitions.length >= state.maxQueuedTransitions
      || state.queuedBytes + bytes > state.maxQueuedBytes
    ) {
      state.queuedTransitions = [];
      state.queuedBytes = 0;
      state.recovering = true;
      return { queued: false, overflow: true };
    }
    state.queuedTransitions.push(event);
    state.queuedBytes += bytes;
    return { queued: true, overflow: false };
  }

  function takeQueuedTransition(state: TerminalReplayState): ValidTerminalReplayTransition | null {
    const event = state.queuedTransitions.shift() || null;
    if (event) state.queuedBytes = Math.max(0, state.queuedBytes - byteLength(event.data));
    return event;
  }

  function clearQueuedTransitions(state: TerminalReplayState): void {
    state.queuedTransitions = [];
    state.queuedBytes = 0;
  }

  function checkpointInvariant(signature: string, message: string): TerminalReplayDecision {
    return { action: 'reject', signature, message };
  }

  function queuedTransitionsCoverTarget(state: TerminalReplayState, checkpoint: TerminalReplayCheckpoint): boolean {
    if (
      checkpoint.runtimeEpoch !== state.replayTargetEpoch
      || !isFiniteNumber(state.replayTargetRevision)
    ) return false;

    let outputSeq = checkpoint.outputSeq;
    let stateRevision = checkpoint.stateRevision;
    for (const event of state.queuedTransitions) {
      if (!isTransitionValid(event) || event.runtimeEpoch !== checkpoint.runtimeEpoch) return false;
      if (event.stateRevision <= stateRevision) continue;
      const outputAdvance = event.kind === 'output' ? 1 : 0;
      if (
        event.stateRevision !== stateRevision + 1
        || event.outputSeq !== outputSeq + outputAdvance
      ) return false;
      outputSeq = event.outputSeq;
      stateRevision = event.stateRevision;
      if (stateRevision >= state.replayTargetRevision) return true;
    }
    return false;
  }

  function evaluateCheckpoint(state: TerminalReplayState, checkpoint: TerminalReplayCheckpoint): TerminalReplayDecision {
    if (!isCheckpointValid(checkpoint)) {
      return checkpointInvariant('invalid-checkpoint', 'Terminal replay returned an invalid screen state');
    }
    if (state.runtimeEpoch && checkpoint.runtimeEpoch !== state.runtimeEpoch) {
      const relation = compareRuntimeEpochs(checkpoint.runtimeEpoch, state.runtimeEpoch);
      if (relation === -1 || state.retiredRuntimeEpochs.has(checkpoint.runtimeEpoch)) {
        return checkpointInvariant(
          `older-epoch:${checkpoint.runtimeEpoch}:${state.runtimeEpoch}`,
          'Terminal replay returned an older runtime epoch',
        );
      }
    } else if (
      checkpoint.runtimeEpoch === state.runtimeEpoch
      && isFiniteNumber(state.stateRevision)
      && checkpoint.stateRevision < state.stateRevision
    ) {
      return checkpointInvariant(
        `older-revision:${checkpoint.runtimeEpoch}:${checkpoint.stateRevision}:${state.stateRevision}`,
        'Terminal replay returned an older screen state',
      );
    }

    if (state.replayTargetEpoch && isFiniteNumber(state.replayTargetRevision)) {
      if (checkpoint.runtimeEpoch === state.replayTargetEpoch) {
        if (
          checkpoint.stateRevision < state.replayTargetRevision
          && !queuedTransitionsCoverTarget(state, checkpoint)
        ) {
          return checkpointInvariant(
            `behind-target:${checkpoint.runtimeEpoch}:${checkpoint.stateRevision}:${state.replayTargetRevision}`,
            'Terminal replay did not reach the latest observed screen state',
          );
        }
      } else if (compareRuntimeEpochs(checkpoint.runtimeEpoch, state.replayTargetEpoch) !== 1) {
        return checkpointInvariant(
          `wrong-target-epoch:${checkpoint.runtimeEpoch}:${state.replayTargetEpoch}`,
          'Terminal replay returned a different runtime epoch',
        );
      }
    }

    const current = checkpoint.runtimeEpoch === state.runtimeEpoch
      && checkpoint.outputSeq === state.outputSeq
      && checkpoint.stateRevision === state.stateRevision;
    return { action: current ? 'current' : 'install' };
  }

  function removeCheckpointCoveredTransitions(state: TerminalReplayState, checkpoint: TerminalReplayCheckpoint): void {
    state.queuedTransitions = state.queuedTransitions.filter((event) => {
      if (!isTransitionValid(event)) return false;
      if (state.retiredRuntimeEpochs.has(event.runtimeEpoch)) return false;
      if (event.runtimeEpoch === checkpoint.runtimeEpoch) {
        return event.stateRevision > checkpoint.stateRevision;
      }
      return compareRuntimeEpochs(event.runtimeEpoch, checkpoint.runtimeEpoch) !== -1;
    });
    state.queuedBytes = state.queuedTransitions.reduce(
      (total, event) => total + byteLength(event.data),
      0,
    );
  }

  function clearFailures(state: TerminalReplayState): void {
    state.failureCount = 0;
    state.transportFailureCount = 0;
    state.invariantFailureSignature = '';
    state.invariantFailureCount = 0;
    state.halted = false;
    state.haltMessage = '';
  }

  function commitCheckpoint(state: TerminalReplayState, checkpoint: TerminalReplayCheckpoint): boolean {
    if (state.runtimeEpoch && state.runtimeEpoch !== checkpoint.runtimeEpoch) {
      state.retiredRuntimeEpochs.add(state.runtimeEpoch);
      while (state.retiredRuntimeEpochs.size > 4) {
        const oldestRuntimeEpoch = state.retiredRuntimeEpochs.values().next().value;
        if (oldestRuntimeEpoch !== undefined) state.retiredRuntimeEpochs.delete(oldestRuntimeEpoch);
      }
    }
    state.runtimeEpoch = checkpoint.runtimeEpoch;
    state.outputSeq = checkpoint.outputSeq;
    state.stateRevision = checkpoint.stateRevision;
    removeCheckpointCoveredTransitions(state, checkpoint);
    clearFailures(state);
    state.recovering = isReplayTargetPending(state);
    if (state.recovering && queuedTransitionsCoverTarget(state, checkpoint)) {
      state.recovering = false;
    }
    if (!state.recovering) {
      state.replayTargetEpoch = '';
      state.replayTargetRevision = null;
    }
    return !state.recovering;
  }

  function commitTransition(state: TerminalReplayState, event: TerminalReplayTransition): void {
    if (!isTransitionValid(event)) {
      beginRecovery(state, event);
      return;
    }
    state.runtimeEpoch = event.runtimeEpoch;
    state.outputSeq = event.outputSeq;
    state.stateRevision = event.stateRevision;
    if (!isReplayTargetPending(state)) {
      state.replayTargetEpoch = '';
      state.replayTargetRevision = null;
      state.recovering = false;
    }
  }

  function retryDelay(state: TerminalReplayState): number {
    const exponent = Math.max(0, state.failureCount - 1);
    return Math.min(state.retryMaxMs, state.retryBaseMs * (2 ** exponent));
  }

  function recordTransportFailure(state: TerminalReplayState): TerminalReplayFailure {
    state.failureCount += 1;
    state.transportFailureCount += 1;
    state.recovering = true;
    if (state.transportFailureCount >= state.maxTransportFailures) {
      state.halted = true;
      state.haltMessage = 'Terminal state could not be loaded after repeated connection failures';
    }
    return {
      halted: state.halted,
      delay: state.halted ? 0 : retryDelay(state),
      message: state.haltMessage,
    };
  }

  function recordInvariantFailure(state: TerminalReplayState, signature: string, message: string): TerminalReplayFailure {
    state.failureCount += 1;
    state.transportFailureCount = 0;
    state.recovering = true;
    if (state.invariantFailureSignature === signature) {
      state.invariantFailureCount += 1;
    } else {
      state.invariantFailureSignature = signature;
      state.invariantFailureCount = 1;
    }
    if (state.invariantFailureCount >= state.maxIdenticalInvariantFailures) {
      state.halted = true;
      state.haltMessage = message || 'Terminal replay could not prove a current screen state';
    }
    return {
      halted: state.halted,
      delay: state.halted ? 0 : retryDelay(state),
      message: state.haltMessage,
    };
  }

  function resetRecovery(state: TerminalReplayState, options: { keepCursor?: boolean } = {}): void {
    clearQueuedTransitions(state);
    state.replayTargetEpoch = '';
    state.replayTargetRevision = null;
    state.recovering = false;
    clearFailures(state);
    if (options.keepCursor === false) {
      state.runtimeEpoch = '';
      state.outputSeq = null;
      state.stateRevision = null;
      state.retiredRuntimeEpochs.clear();
    }
  }

  const api: TerminalReplayApi = {
    createState,
    compareRuntimeEpochs,
    beginRecovery,
    isReplayTargetPending,
    classifyTransition,
    queueTransition,
    takeQueuedTransition,
    clearQueuedTransitions,
    evaluateCheckpoint,
    commitCheckpoint,
    commitTransition,
    recordTransportFailure,
    recordInvariantFailure,
    resetRecovery,
  };

  global.FarmingTerminalReplay = api;
  // CommonJS injects `module` lexically; browsers reach only the global assignment above.
  if (typeof module === 'object' && module?.exports) {
    module.exports = api as unknown as Record<string, unknown>;
  }
})(globalThis as typeof globalThis & {
  FarmingTerminalReplay?: unknown;
});
