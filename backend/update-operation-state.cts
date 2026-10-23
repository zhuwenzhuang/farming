// Update ownership decisions and publication share the exact-process file claim.
const fs = require('fs') as typeof import('fs');
import {
  acquireProcessFileLock as acquireUpdateStateLock,
  releaseProcessFileLock as releaseUpdateStateLock,
  processFileLockDir as updateStateLockDir,
  recoverPendingLockRelease, tryReclaimDeadClaim, writeJsonAtomic, lockFailure,
  UPDATE_STATE_LOCK_TIMEOUT_MS, UPDATE_STATE_LOCK_ERROR_CODE,
  type ProcessFileLockClaim as UpdateStateLockClaim,
  type ProcessFileLockOptions as UpdateStateCommitOptions,
  type ReclaimOutcome,
} from './process-owned-file-lock.cjs';

interface ExpectedUpdateOperation {
  format?: string;
  operationId: string;
  phase?: string;
}

function readUpdateOperationOwnership(
  stateFile: string,
): { format: string; operationId: string; phase: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    if (typeof value.operationId !== 'string' || !value.operationId) return null;
    return {
      format: String(value.format || ''),
      operationId: value.operationId,
      phase: String(value.phase || ''),
    };
  } catch {
    return null;
  }
}

// Publishes new update state under the exclusive claim. When `expected` is
// given, the publish happens only while that exact operation still owns the
// state file; ownership observation and publication form one atomic
// decision. Returns false when the operation was superseded.
function commitUpdateOperationState(
  stateFile: string,
  expected: ExpectedUpdateOperation | null,
  state: Record<string, unknown>,
  options: UpdateStateCommitOptions = {},
): boolean {
  recoverPendingLockRelease(stateFile, options);
  const claim = acquireUpdateStateLock(stateFile, options);
  let writeError: unknown = null;
  let written = false;
  try {
    let owns = true;
    if (expected !== null) {
      const ownership = readUpdateOperationOwnership(stateFile);
      owns = ownership !== null
        && ownership.operationId === expected.operationId
        && (expected.format === undefined || ownership.format === expected.format)
        && (expected.phase === undefined || ownership.phase === expected.phase);
    }
    if (owns) {
      writeJsonAtomic(stateFile, state);
      written = true;
    }
  } catch (error) {
    writeError = error;
  }
  const released = releaseUpdateStateLock(stateFile, claim, options);
  // Release uncertainty dominates every commit outcome — written, skipped by
  // a failed ownership condition, or failed by a write error — because a
  // live claim left behind blocks every later writer. The primary error is
  // preserved alongside the release failure.
  if (!released) {
    const releaseError = lockFailure(
      `Update state lock claim for ${stateFile} could not be proven released after the commit attempt; `
      + 'recover this update operation before continuing',
    );
    if (writeError) {
      throw new AggregateError(
        [writeError, releaseError],
        'Update state commit failed and its lock claim was not released',
      );
    }
    throw releaseError;
  }
  if (writeError) throw writeError;
  return written;
}

// Removes update state under the same exclusive claim so removal cannot race
// a concurrent commit or publish.
function removeUpdateOperationState(
  stateFile: string,
  options: UpdateStateCommitOptions = {},
): boolean {
  recoverPendingLockRelease(stateFile, options);
  const claim = acquireUpdateStateLock(stateFile, options);
  let removeError: unknown = null;
  try {
    fs.rmSync(stateFile, { force: true });
  } catch (error) {
    removeError = error;
  }
  const released = releaseUpdateStateLock(stateFile, claim, options);
  // Release uncertainty dominates the remove outcome as well.
  if (!released) {
    const releaseError = lockFailure(
      `Update state lock claim for ${stateFile} could not be proven released after the remove attempt; `
      + 'recover this update operation before continuing',
    );
    if (removeError) {
      throw new AggregateError(
        [removeError, releaseError],
        'Update state removal failed and its lock claim was not released',
      );
    }
    throw releaseError;
  }
  if (removeError) throw removeError;
  return true;
}

export {
  acquireUpdateStateLock,
  commitUpdateOperationState,
  readUpdateOperationOwnership,
  releaseUpdateStateLock,
  removeUpdateOperationState,
  tryReclaimDeadClaim,
  updateStateLockDir,
  writeJsonAtomic,
  UPDATE_STATE_LOCK_TIMEOUT_MS,
};
export { UPDATE_STATE_LOCK_ERROR_CODE };
export type {
  ExpectedUpdateOperation,
  ReclaimOutcome,
  UpdateStateCommitOptions,
  UpdateStateLockClaim,
};
