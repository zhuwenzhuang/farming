import '../../frontend/terminal-attachment-coordinator.js'

const Coordinator = globalThis.FarmingTerminalAttachmentCoordinator
if (!Coordinator) {
  throw new Error('FarmingTerminalAttachmentCoordinator runtime is unavailable')
}

type CanonicalTerminalAttachmentOperation = ReturnType<FarmingTerminalAttachmentCoordinatorApi['currentOperation']>
type CanonicalTerminalAttachmentOrderingSnapshot = ReturnType<FarmingTerminalAttachmentCoordinatorApi['snapshot']>

export type TerminalAttachmentOperation = CanonicalTerminalAttachmentOperation
export type TerminalAttachmentOrderingSnapshot = CanonicalTerminalAttachmentOrderingSnapshot
export type TerminalAttachmentCoordinator = FarmingTerminalAttachmentCoordinatorApi
export const TerminalAttachmentCoordinator: FarmingTerminalAttachmentCoordinatorConstructor = Coordinator
