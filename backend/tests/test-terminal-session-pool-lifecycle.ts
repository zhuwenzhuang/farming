const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const poolSource = fs.readFileSync(path.join(root, 'src/lib/terminal-session-pool.ts'), 'utf8');
const terminalOutputSource = fs.readFileSync(path.join(root, 'src/lib/terminal-output.ts'), 'utf8');

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
    poolSource.includes('TERMINAL_REPLAY.clearQueuedTransitions(record.replayState)') &&
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
  poolSource.includes('function clearTerminalOpenTargetState(record: SessionRecord)') &&
    poolSource.includes('record.openModifierActive = false') &&
    poolSource.includes('record.lastLinkHoverEvent = null') &&
    poolSource.includes('setTerminalLinkHoverTarget(record, null)'),
  'terminal open-target cleanup should clear both visual hover state and the tracked modifier state'
);

assert(
  poolSource.includes('clearTerminalOpenTargetState(record)\n  clearTerminalSelectionState(record)') &&
    poolSource.includes('const linkHoverBlurHandler = () => {\n    clearTerminalOpenTargetState(record)\n  }'),
  'detach and window blur should clear terminal open-target modifier state'
);

console.log('✓ terminal session pool releases pending writes on destroy');
