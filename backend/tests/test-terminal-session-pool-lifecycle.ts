const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const poolSource = fs.readFileSync(path.join(root, 'src/lib/terminal-session-pool.ts'), 'utf8');
const terminalOutputSource = fs.readFileSync(path.join(root, 'src/lib/terminal-output.ts'), 'utf8');
const linkInteractionSource = fs.readFileSync(
  path.join(root, 'src/lib/terminal-link-interaction.ts'),
  'utf8',
);
const terminalDiagnosticsSource = fs.readFileSync(
  path.join(root, 'src/lib/terminal-session-diagnostics.ts'),
  'utf8',
);

assert(
  poolSource.includes('terminalWriteResolvers: Set<(cancelled?: boolean) => boolean>') &&
    terminalOutputSource.includes('record.terminalWriteResolvers.add(done)') &&
    terminalOutputSource.includes('record.terminalWriteResolvers.delete(done)'),
  'terminal write queue should track pending write callbacks so lifecycle cleanup can release them'
);

assert(
  terminalOutputSource.includes('export function flushPendingTerminalWrites(record: TerminalOutputRecord)') &&
    terminalOutputSource.includes('const resolvers = Array.from(record.terminalWriteResolvers)') &&
    terminalOutputSource.includes('resolvers.forEach(resolve => resolve(true))'),
  'terminal session pool should expose a single cleanup path for pending terminal writes'
);

assert(
  terminalOutputSource.includes('function completeTerminalWrite(done: () => boolean, callback?: () => void)') &&
    terminalOutputSource.includes('if (done()) {\n    callback?.()\n  }') &&
    terminalOutputSource.includes('if (cancelled) {\n          onCancel?.()\n        }'),
  'terminal write completion should call user callbacks exactly once, including cancellation during destroy'
);

assert(
  terminalOutputSource.includes('options: { beforeReplace?: () => boolean } = {}') &&
    terminalOutputSource.indexOf('if (options.beforeReplace && !options.beforeReplace())') <
      terminalOutputSource.indexOf('record.terminal.reset()') &&
    poolSource.includes('record.attachment.admitCheckpointInstall(operation, checkpoint)') &&
    poolSource.indexOf('record.attachment.admitCheckpointInstall(operation, checkpoint)') <
      poolSource.indexOf('record.resizeEffects.applyAuthoritativeDimensions(state.cols!, state.rows!)'),
  'checkpoint replacement should revalidate ordering inside the write queue before resize or reset'
);

assert(
  poolSource.includes("import { TerminalSessionRegistry } from '@/lib/terminal-session-registry'") &&
    poolSource.includes('const sessions = new TerminalSessionRegistry<string, SessionRecord>()') &&
    poolSource.includes('return sessions.getOrCreate(') &&
    poolSource.includes('const current = sessions.take(agentId)'),
  'terminal session pool should delegate bootstrap admission and destroy ownership to its exact-key registry'
);

assert(
  poolSource.includes('new TerminalSessionDiagnosticsProjection({') &&
    poolSource.includes('get: agentId => sessions.get(agentId)') &&
    poolSource.includes('values: () => sessions.values()') &&
    poolSource.includes('...terminalSessionDiagnostics.testBridge()') &&
    !poolSource.includes('terminalSessionDiagnostics.register(record)') &&
    !poolSource.includes('terminalSessionDiagnostics.unregister(record)') &&
    !poolSource.includes('const attachmentDiagnostics = current.attachment.snapshot()') &&
    !terminalDiagnosticsSource.includes('new Map<') &&
    terminalDiagnosticsSource.includes('readonly #ports: TerminalSessionDiagnosticsPorts') &&
    terminalDiagnosticsSource.includes('const current = this.#ports.get(agentId)') &&
    terminalDiagnosticsSource.includes('current instanceof Promise') &&
    terminalDiagnosticsSource.includes('getBufferDiagnostics: agentId => this.snapshot(agentId)') &&
    terminalDiagnosticsSource.includes('getHostDiagnostics: () => this.hostSnapshots(root)') &&
    terminalDiagnosticsSource.includes('const attachment = current.attachment.snapshot()') &&
    terminalDiagnosticsSource.includes('const resize = current.resizeEffects.diagnostics()'),
  'terminal diagnostics should own its bridge and lazy projection while reading exact identity from the canonical registry'
);

assert(
  poolSource.indexOf('record.disposed = true') <
    poolSource.indexOf('clearPendingTerminalOutput(record)') &&
    poolSource.indexOf('clearPendingTerminalOutput(record)') <
    poolSource.indexOf('flushPendingTerminalWrites(record)') &&
    poolSource.indexOf('flushPendingTerminalWrites(record)') <
    poolSource.indexOf('record.unsubscribeOutput?.()'),
  'destroyTerminalSession should clear pending terminal output and release pending writes before disposing subscriptions and terminal resources'
);

assert(
  poolSource.includes('function clearPendingTerminalOutput(record: SessionRecord)') &&
    poolSource.includes('record.attachment.clearQueuedTransitions()') &&
    poolSource.includes('record.bootstrappingSnapshot = false') &&
    poolSource.includes('record.pendingSnapshotReplay = false'),
  'destroyTerminalSession should drop pending bootstrap/replay output for disposed terminal sessions'
);

assert(
  poolSource.includes('const unsubscribeOutput = options.onSessionOutput(agentId, (') &&
    poolSource.includes('stateRevision,') &&
    poolSource.includes('if (record.disposed) return\n    handleTerminalStreamOutput('),
  'terminal session output subscription should ignore output after the session is disposed'
);

assert(
  linkInteractionSource.includes('#clearHoverState() {') &&
    linkInteractionSource.includes('this.#openModifierActive = false') &&
    linkInteractionSource.includes('this.#lastHoverEvent = null') &&
    linkInteractionSource.includes('this.#setHoverTarget(null)'),
  'terminal open-target cleanup should clear both visual hover state and the tracked modifier state'
);

assert(
  poolSource.includes('record.linkInteraction.reset()\n  clearTerminalSelectionState(record)') &&
    linkInteractionSource.includes('#handleWindowBlur = () => {\n    this.#clearHoverState()\n  }') &&
    linkInteractionSource.includes("this.#listen(this.#ports.windowTarget, 'blur', this.#handleWindowBlur as EventListener, false)"),
  'detach and window blur should clear terminal open-target modifier state'
);

assert(
  poolSource.includes('  repairTerminalAfterAttach(record)\n  applyTerminalAttachmentOptions(record, options)') &&
    poolSource.includes('function repairTerminalAfterAttach(record: SessionRecord) {\n  resetTransientTerminalUi(record)') &&
    poolSource.includes('function resetTransientTerminalUi(record: SessionRecord) {\n  hideTerminalContextMenu(record)\n  record.linkInteraction.reset()') &&
    poolSource.includes('if (record.attachedMount === options.mountEl && isTerminalSessionAttached(record)) {') &&
    poolSource.includes('    applyTerminalAttachmentOptions(record, options)\n    return\n  }') &&
    poolSource.includes('const revisionInvalidated = record.linkInteraction.adoptHandlersRevision(committedRevision)') &&
    poolSource.includes('if (!revisionInvalidated && linkHandlersReplaced) record.linkInteraction.notifyHandlersChanged()') &&
    !poolSource.includes('    resetTransientTerminalUi(record)\n    applyTerminalAttachmentOptions(record, options)\n    return\n  }'),
  'a different-mount attach should reset link interaction fences before installing new handlers, while a same-mount refresh only replaces handlers'
);

console.log('✓ terminal session pool releases pending writes on destroy');
