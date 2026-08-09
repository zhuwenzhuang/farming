type TerminalReplayTransition = {
  kind?: 'output' | 'resize' | 'clear'
  data?: string
  runtimeEpoch?: string
  outputSeq?: number | null
  stateRevision?: number | null
  cols?: number
  rows?: number
}

type ValidTerminalReplayTransition = TerminalReplayTransition & {
  runtimeEpoch: string
  outputSeq: number
  stateRevision: number
}

type TerminalReplayCheckpoint = {
  runtimeEpoch: string
  outputSeq: number
  stateRevision: number
  cols: number
  rows: number
}

type TerminalReplayCheckpointCandidate = {
  runtimeEpoch?: string
  outputSeq?: number | null
  stateRevision?: number | null
  cols?: number | null
  rows?: number | null
}

type TerminalReplayState = {
  runtimeEpoch: string
  outputSeq: number | null
  stateRevision: number | null
  replayTargetEpoch: string
  replayTargetRevision: number | null
  recovering: boolean
  queuedTransitions: ValidTerminalReplayTransition[]
  queuedBytes: number
  retiredRuntimeEpochs: Set<string>
  failureCount: number
  transportFailureCount: number
  invariantFailureSignature: string
  invariantFailureCount: number
  halted: boolean
  haltMessage: string
  maxQueuedTransitions: number
  maxQueuedBytes: number
  retryBaseMs: number
  retryMaxMs: number
  maxTransportFailures: number
  maxIdenticalInvariantFailures: number
}

type TerminalReplayDecision = {
  action: 'apply' | 'drop' | 'recover' | 'current' | 'install' | 'reject'
  reason?: string
  signature?: string
  message?: string
}

type TerminalReplayFailure = {
  halted: boolean
  delay: number
  message: string
}

type FarmingTerminalReplayApi = {
  createState: (options?: Partial<Pick<TerminalReplayState,
    'maxQueuedTransitions' | 'maxQueuedBytes' | 'retryBaseMs' | 'retryMaxMs' | 'maxTransportFailures' | 'maxIdenticalInvariantFailures'
  >>) => TerminalReplayState
  compareRuntimeEpochs: (left: string, right: string) => -1 | 0 | 1 | null
  beginRecovery: (state: TerminalReplayState, event?: TerminalReplayTransition) => void
  isReplayTargetPending: (state: TerminalReplayState) => boolean
  classifyTransition: (state: TerminalReplayState, event: TerminalReplayTransition) => TerminalReplayDecision
  queueTransition: (state: TerminalReplayState, event: TerminalReplayTransition) => { queued: boolean; overflow: boolean }
  takeQueuedTransition: (state: TerminalReplayState) => ValidTerminalReplayTransition | null
  clearQueuedTransitions: (state: TerminalReplayState) => void
  evaluateCheckpoint: (state: TerminalReplayState, checkpoint: TerminalReplayCheckpointCandidate) => TerminalReplayDecision
  commitCheckpoint: (state: TerminalReplayState, checkpoint: TerminalReplayCheckpoint) => boolean
  commitTransition: (state: TerminalReplayState, event: TerminalReplayTransition) => void
  recordTransportFailure: (state: TerminalReplayState) => TerminalReplayFailure
  recordInvariantFailure: (state: TerminalReplayState, signature: string, message: string) => TerminalReplayFailure
  resetRecovery: (state: TerminalReplayState, options?: { keepCursor?: boolean }) => void
}

declare var FarmingTerminalReplay: FarmingTerminalReplayApi

type TerminalAttachmentOperation = {
  generation: number
  revision: number
}

type TerminalAttachmentOrderingSnapshot = {
  generation: number
  revision: number
  runtimeEpoch: string
  outputSeq: number | null
  stateRevision: number | null
  replayTargetEpoch: string
  replayTargetRevision: number | null
  queuedTransitions: number
  queuedBytes: number
  recovering: boolean
  halted: boolean
  failureCount: number
}

interface FarmingTerminalAttachmentCoordinatorApi {
  readonly failureCount: number
  readonly generation: number
  readonly halted: boolean
  readonly outputSeq: number | null
  readonly queuedTransitionCount: number
  readonly recovering: boolean
  readonly runtimeEpoch: string
  readonly stateRevision: number | null
  admitCheckpointInstall(operation: TerminalAttachmentOperation, checkpoint: TerminalReplayCheckpoint): boolean
  beginAttachment(): TerminalAttachmentOperation
  beginCheckpointOperation(generation?: number): TerminalAttachmentOperation | null
  beginRecovery(event?: TerminalReplayTransition): void
  classifyTransition(event: TerminalReplayTransition): TerminalReplayDecision
  clearQueuedTransitions(): void
  commitCheckpoint(operation: TerminalAttachmentOperation, checkpoint: TerminalReplayCheckpoint): boolean
  commitTransition(event: TerminalReplayTransition): void
  currentOperation(): TerminalAttachmentOperation
  detach(): TerminalAttachmentOperation
  evaluateCheckpoint(checkpoint: TerminalReplayCheckpointCandidate): TerminalReplayDecision
  invalidateOperation(): TerminalAttachmentOperation
  isCurrentGeneration(generation: number): boolean
  isCurrentOperation(operation: TerminalAttachmentOperation): boolean
  isReplayTargetPending(): boolean
  queuedOutputBatch(): TerminalReplayTransition[] | null
  queueTransition(event: TerminalReplayTransition): { queued: boolean; overflow: boolean }
  recordInvariantFailure(signature: string, message: string): TerminalReplayFailure
  recordTransportFailure(): TerminalReplayFailure
  resetRecovery(options?: { keepCursor?: boolean }): void
  snapshot(): TerminalAttachmentOrderingSnapshot
  takeQueuedTransition(): ValidTerminalReplayTransition | null
}

interface FarmingTerminalAttachmentCoordinatorConstructor {
  new(replay: FarmingTerminalReplayApi): FarmingTerminalAttachmentCoordinatorApi
}

declare var FarmingTerminalAttachmentCoordinator: FarmingTerminalAttachmentCoordinatorConstructor

interface Window {
  FarmingTerminalReplay?: FarmingTerminalReplayApi
  FarmingTerminalAttachmentCoordinator?: FarmingTerminalAttachmentCoordinatorConstructor
}
