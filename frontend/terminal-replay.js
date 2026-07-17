(function attachTerminalReplay(global) {
  const RUNTIME_EPOCH_PATTERN = /^farming-runtime-v1:(\d{20}):/;
  const DEFAULT_MAX_QUEUED_TRANSITIONS = 512;
  const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
  const DEFAULT_RETRY_BASE_MS = 250;
  const DEFAULT_RETRY_MAX_MS = 5000;
  const DEFAULT_MAX_IDENTICAL_INVARIANT_FAILURES = 3;

  function runtimeEpochGeneration(runtimeEpoch) {
    const match = RUNTIME_EPOCH_PATTERN.exec(String(runtimeEpoch || ''));
    if (!match) return null;
    const generation = Number(match[1]);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
  }

  function compareRuntimeEpochs(left, right) {
    if (left === right) return 0;
    const leftGeneration = runtimeEpochGeneration(left);
    const rightGeneration = runtimeEpochGeneration(right);
    if (leftGeneration === null || rightGeneration === null || leftGeneration === rightGeneration) {
      return null;
    }
    return leftGeneration < rightGeneration ? -1 : 1;
  }

  function byteLength(value) {
    const text = String(value || '');
    if (typeof global.TextEncoder === 'function') {
      return new global.TextEncoder().encode(text).byteLength;
    }
    return encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, 'x').length;
  }

  function createState(options = {}) {
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
      invariantFailureSignature: '',
      invariantFailureCount: 0,
      halted: false,
      haltMessage: '',
      maxQueuedTransitions: options.maxQueuedTransitions || DEFAULT_MAX_QUEUED_TRANSITIONS,
      maxQueuedBytes: options.maxQueuedBytes || DEFAULT_MAX_QUEUED_BYTES,
      retryBaseMs: options.retryBaseMs || DEFAULT_RETRY_BASE_MS,
      retryMaxMs: options.retryMaxMs || DEFAULT_RETRY_MAX_MS,
      maxIdenticalInvariantFailures:
        options.maxIdenticalInvariantFailures || DEFAULT_MAX_IDENTICAL_INVARIANT_FAILURES,
    };
  }

  function isTransitionValid(event) {
    return Boolean(event && event.runtimeEpoch)
      && Number.isFinite(event.outputSeq)
      && Number.isFinite(event.stateRevision)
      && (
        event.kind !== 'resize'
        || (Number.isFinite(event.cols) && Number.isFinite(event.rows))
      );
  }

  function isCheckpointValid(checkpoint) {
    return Boolean(checkpoint && checkpoint.runtimeEpoch)
      && Number.isFinite(checkpoint.outputSeq)
      && Number.isFinite(checkpoint.stateRevision)
      && Number.isFinite(checkpoint.cols)
      && Number.isFinite(checkpoint.rows)
      && checkpoint.cols > 0
      && checkpoint.rows > 0;
  }

  function noteReplayTarget(state, event) {
    if (!event || !event.runtimeEpoch || !Number.isFinite(event.stateRevision)) return;
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

  function beginRecovery(state, event) {
    state.recovering = true;
    noteReplayTarget(state, event);
  }

  function isReplayTargetPending(state) {
    if (!state.replayTargetEpoch || !Number.isFinite(state.replayTargetRevision)) return false;
    if (!state.runtimeEpoch || !Number.isFinite(state.stateRevision)) return true;
    if (state.runtimeEpoch === state.replayTargetEpoch) {
      return state.stateRevision < state.replayTargetRevision;
    }
    return compareRuntimeEpochs(state.runtimeEpoch, state.replayTargetEpoch) !== 1;
  }

  function classifyTransition(state, event) {
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
    if (!state.runtimeEpoch || !Number.isFinite(state.outputSeq) || !Number.isFinite(state.stateRevision)) {
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

  function queueTransition(state, event) {
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

  function takeQueuedTransition(state) {
    const event = state.queuedTransitions.shift() || null;
    if (event) state.queuedBytes = Math.max(0, state.queuedBytes - byteLength(event.data));
    return event;
  }

  function clearQueuedTransitions(state) {
    state.queuedTransitions = [];
    state.queuedBytes = 0;
  }

  function checkpointInvariant(signature, message) {
    return { action: 'reject', signature, message };
  }

  function evaluateCheckpoint(state, checkpoint) {
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
      && Number.isFinite(state.stateRevision)
      && checkpoint.stateRevision < state.stateRevision
    ) {
      return checkpointInvariant(
        `older-revision:${checkpoint.runtimeEpoch}:${checkpoint.stateRevision}:${state.stateRevision}`,
        'Terminal replay returned an older screen state',
      );
    }

    if (state.replayTargetEpoch && Number.isFinite(state.replayTargetRevision)) {
      if (checkpoint.runtimeEpoch === state.replayTargetEpoch) {
        if (checkpoint.stateRevision < state.replayTargetRevision) {
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

  function removeCheckpointCoveredTransitions(state, checkpoint) {
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

  function clearFailures(state) {
    state.failureCount = 0;
    state.invariantFailureSignature = '';
    state.invariantFailureCount = 0;
    state.halted = false;
    state.haltMessage = '';
  }

  function commitCheckpoint(state, checkpoint) {
    if (state.runtimeEpoch && state.runtimeEpoch !== checkpoint.runtimeEpoch) {
      state.retiredRuntimeEpochs.add(state.runtimeEpoch);
      while (state.retiredRuntimeEpochs.size > 4) {
        state.retiredRuntimeEpochs.delete(state.retiredRuntimeEpochs.values().next().value);
      }
    }
    state.runtimeEpoch = checkpoint.runtimeEpoch;
    state.outputSeq = checkpoint.outputSeq;
    state.stateRevision = checkpoint.stateRevision;
    removeCheckpointCoveredTransitions(state, checkpoint);
    clearFailures(state);
    state.recovering = isReplayTargetPending(state);
    if (!state.recovering) {
      state.replayTargetEpoch = '';
      state.replayTargetRevision = null;
    }
    return !state.recovering;
  }

  function commitTransition(state, event) {
    state.runtimeEpoch = event.runtimeEpoch;
    state.outputSeq = event.outputSeq;
    state.stateRevision = event.stateRevision;
    if (!isReplayTargetPending(state)) {
      state.replayTargetEpoch = '';
      state.replayTargetRevision = null;
      state.recovering = false;
    }
  }

  function retryDelay(state) {
    const exponent = Math.max(0, state.failureCount - 1);
    return Math.min(state.retryMaxMs, state.retryBaseMs * (2 ** exponent));
  }

  function recordTransportFailure(state) {
    state.failureCount += 1;
    state.recovering = true;
    return { halted: false, delay: retryDelay(state), message: '' };
  }

  function recordInvariantFailure(state, signature, message) {
    state.failureCount += 1;
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

  function resetRecovery(state, options = {}) {
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

  const api = {
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
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : window);
