/// <reference path="../src/types/terminal-replay.d.ts" />

declare const module: { exports: unknown } | undefined;

(function attachTerminalAttachmentCoordinator(global) {
  /** Owns attachment identity and the ordered checkpoint/delta cursor for every browser surface. */
  class TerminalAttachmentCoordinator implements FarmingTerminalAttachmentCoordinatorApi {
    readonly #replay: FarmingTerminalReplayApi;
    readonly #replayState: TerminalReplayState;
    #generation = 0;
    #revision = 0;

    constructor(replay: FarmingTerminalReplayApi) {
      this.#replay = replay;
      this.#replayState = replay.createState();
    }

    get generation() { return this.#generation; }
    get recovering() { return this.#replayState.recovering; }
    get halted() { return this.#replayState.halted; }
    get failureCount() { return this.#replayState.failureCount; }
    get queuedTransitionCount() { return this.#replayState.queuedTransitions.length; }
    get runtimeEpoch() { return this.#replayState.runtimeEpoch; }
    get outputSeq() { return this.#replayState.outputSeq; }
    get stateRevision() { return this.#replayState.stateRevision; }

    beginAttachment() {
      this.#generation += 1;
      return this.currentOperation();
    }

    detach() {
      this.#generation += 1;
      return this.currentOperation();
    }

    isCurrentGeneration(generation: number) {
      return generation === this.#generation;
    }

    invalidateOperation(): TerminalAttachmentOperation {
      this.#revision += 1;
      return this.currentOperation();
    }

    currentOperation(): TerminalAttachmentOperation {
      return { generation: this.#generation, revision: this.#revision };
    }

    isCurrentOperation(operation: TerminalAttachmentOperation) {
      return this.isCurrentGeneration(operation.generation)
        && operation.revision === this.#revision;
    }

    beginCheckpointOperation(generation = this.#generation) {
      if (!this.isCurrentGeneration(generation)) return null;
      this.#revision += 1;
      return this.currentOperation();
    }

    classifyTransition(event: TerminalReplayTransition) {
      return this.#replay.classifyTransition(this.#replayState, event);
    }

    queueTransition(event: TerminalReplayTransition) {
      return this.#replay.queueTransition(this.#replayState, event);
    }

    takeQueuedTransition() {
      return this.#replay.takeQueuedTransition(this.#replayState);
    }

    clearQueuedTransitions() {
      this.#replay.clearQueuedTransitions(this.#replayState);
    }

    evaluateCheckpoint(checkpoint: TerminalReplayCheckpointCandidate) {
      return this.#replay.evaluateCheckpoint(this.#replayState, checkpoint);
    }

    admitCheckpointInstall(operation: TerminalAttachmentOperation, checkpoint: TerminalReplayCheckpoint) {
      if (!this.isCurrentOperation(operation)) return false;
      return this.#replay.evaluateCheckpoint(this.#replayState, checkpoint).action !== 'reject';
    }

    commitCheckpoint(operation: TerminalAttachmentOperation, checkpoint: TerminalReplayCheckpoint) {
      if (!this.admitCheckpointInstall(operation, checkpoint)) return false;
      return this.#replay.commitCheckpoint(this.#replayState, checkpoint);
    }

    commitTransition(event: TerminalReplayTransition) {
      this.#replay.commitTransition(this.#replayState, event);
    }

    beginRecovery(event?: TerminalReplayTransition) {
      this.#replay.beginRecovery(this.#replayState, event);
    }

    resetRecovery(options?: { keepCursor?: boolean }) {
      this.#replay.resetRecovery(this.#replayState, options);
    }

    isReplayTargetPending() {
      return this.#replay.isReplayTargetPending(this.#replayState);
    }

    recordTransportFailure() {
      return this.#replay.recordTransportFailure(this.#replayState);
    }

    recordInvariantFailure(signature: string, message: string) {
      return this.#replay.recordInvariantFailure(this.#replayState, signature, message);
    }

    snapshot(): TerminalAttachmentOrderingSnapshot {
      return {
        generation: this.#generation,
        revision: this.#revision,
        runtimeEpoch: this.#replayState.runtimeEpoch,
        outputSeq: this.#replayState.outputSeq,
        stateRevision: this.#replayState.stateRevision,
        replayTargetEpoch: this.#replayState.replayTargetEpoch,
        replayTargetRevision: this.#replayState.replayTargetRevision,
        queuedTransitions: this.#replayState.queuedTransitions.length,
        queuedBytes: this.#replayState.queuedBytes,
        recovering: this.#replayState.recovering,
        halted: this.#replayState.halted,
        failureCount: this.#replayState.failureCount,
      };
    }

    queuedOutputBatch() {
      const shadow = this.#replay.createState();
      shadow.runtimeEpoch = this.#replayState.runtimeEpoch;
      shadow.outputSeq = this.#replayState.outputSeq;
      shadow.stateRevision = this.#replayState.stateRevision;
      shadow.retiredRuntimeEpochs = new Set(this.#replayState.retiredRuntimeEpochs);
      const candidates: TerminalReplayTransition[] = [];
      for (const event of this.#replayState.queuedTransitions) {
        if (event.kind === 'resize') break;
        if (this.#replay.classifyTransition(shadow, event).action !== 'apply') return null;
        this.#replay.commitTransition(shadow, event);
        candidates.push(event);
      }
      return candidates.length > 0 ? candidates : null;
    }
  }

  global.FarmingTerminalAttachmentCoordinator = TerminalAttachmentCoordinator;
  if (typeof module === 'object' && module?.exports) {
    module.exports = TerminalAttachmentCoordinator;
  }
})(globalThis as typeof globalThis & {
  FarmingTerminalAttachmentCoordinator?: FarmingTerminalAttachmentCoordinatorConstructor;
});
