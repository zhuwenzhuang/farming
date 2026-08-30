// Update operation state is one file shared by the Server and detached update
// helpers that may run in separate processes. Every mutation of that file —
// conditional helper commits, authoritative Server persists, and state
// removal — serializes through one exclusive claim directory carrying the
// holder's exact process identity, following the Config owner and managed
// runtime preparation claim patterns. The ownership observation and the state
// publication inside `commitUpdateOperationState` form one atomic decision:
// no protocol participant can interleave between them. Writers that bypass
// this protocol are outside its guarantee.
//
// The claim is published atomically: the complete owner record is written
// into a sibling temporary directory first, and only the finished directory
// is renamed into the lock path. A claim therefore never exists without its
// identity proof, a live holder can never be mistaken for a half-published
// claim, and a failed publish removes exactly its own temporary directory.
//
// Waiting is synchronous (bounded) because every critical section is a small
// synchronous filesystem transaction. Only detached helper processes may
// poll within the deadline. The Server passes a zero timeout and gets
// exactly one non-waiting publication attempt, one exact synchronous stale
// reclaim, and one immediate retry — bounded by an explicit attempt count,
// never sleeping or looping — while crash recovery still works without any
// polling participant. The proven property is exactly that: no polling, no
// sleep, and a bounded attempt count. The single attempt still performs a
// small number of synchronous filesystem and process-inspection steps, so it
// is short and bounded, not non-blocking. Every retry path passes the same
// bounded loop boundary.

const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
import {
  matchingProcessIdentity,
  readServerProcessIdentity,
  type ServerProcessIdentity,
} from './server-process-identity.cjs';

interface UpdateStateLockClaim {
  format: 'farming-update-state-lock-v1';
  pid: number;
  processGroupId: number;
  startedAt: string;
  token: string;
  createdAt: string;
}

interface ExpectedUpdateOperation {
  format?: string;
  operationId: string;
  phase?: string;
}

interface UpdateStateCommitOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  readProcessIdentity?: (pid: number) => ServerProcessIdentity | null;
  // Replaces the poll wait; production uses the synchronous sleep. Tests
  // count calls to prove the no-polling property deterministically.
  sleep?: (ms: number) => void;
}

const UPDATE_STATE_LOCK_TIMEOUT_MS = 1_500;
const UPDATE_STATE_LOCK_POLL_MS = 10;
const UPDATE_STATE_ORPHAN_GRACE_MS = 60_000;
const UPDATE_STATE_LOCK_CLAIM_FORMAT = 'farming-update-state-lock-v1';
const UPDATE_STATE_LOCK_ERROR_CODE = 'FARMING_UPDATE_STATE_LOCK';

// A release can fail after a state mutation has already completed. Keep the
// exact claim in this process so the next mutation can retry that release
// before attempting a new acquisition. A process restart intentionally drops
// this map: the next process then recovers the old claim through its exact
// dead-process identity, using the normal stale-claim protocol.
const pendingLockReleases = new Map<string, UpdateStateLockClaim>();

type ClaimLiveness = 'live' | 'dead' | 'unknown';
type ReclaimOutcome = 'reclaimed' | 'gone' | 'failed';

function fsErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Only the original failure matters; a leftover temp is inert.
    }
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function updateStateLockDir(stateFile: string): string {
  return `${stateFile}.lock`;
}

// This process's own identity cannot change during its lifetime; cache it so
// repeated claim attempts cost one process inspection instead of one per
// attempt. Holder identities are never cached: holders change. The cache is
// keyed by the reader so an injected reader never sees another reader's
// result. Only a proven non-null identity is cached: a failed read must be
// retried by the next attempt instead of permanently poisoning the process.
let cachedSelfIdentity: {
  pid: number;
  reader: (pid: number) => ServerProcessIdentity | null;
  identity: ServerProcessIdentity | null;
} | null = null;
function readSelfIdentity(
  readIdentity: (pid: number) => ServerProcessIdentity | null,
): ServerProcessIdentity | null {
  if (cachedSelfIdentity && cachedSelfIdentity.pid === process.pid && cachedSelfIdentity.reader === readIdentity) {
    return cachedSelfIdentity.identity;
  }
  let identity: ServerProcessIdentity | null = null;
  try {
    identity = readIdentity(process.pid);
  } catch {
    identity = null;
  }
  if (identity) {
    cachedSelfIdentity = { pid: process.pid, reader: readIdentity, identity };
  }
  return identity;
}

function claimFilePath(stateFile: string): string {
  return path.join(updateStateLockDir(stateFile), 'owner.json');
}

// Strict parse of the claim owner file: throws on unreadable, malformed, or
// invalid claims; ENOENT propagates so callers can distinguish absence.
function parseLockClaimFile(stateFile: string): UpdateStateLockClaim {
  const value = JSON.parse(fs.readFileSync(claimFilePath(stateFile), 'utf8')) as Record<string, unknown>;
  if (
    value.format !== UPDATE_STATE_LOCK_CLAIM_FORMAT
    || !Number.isSafeInteger(Number(value.pid))
    || Number(value.pid) <= 0
    || !Number.isSafeInteger(Number(value.processGroupId))
    || Number(value.processGroupId) <= 0
    || typeof value.startedAt !== 'string'
    || !value.startedAt
    || typeof value.token !== 'string'
    || !value.token
  ) {
    throw new Error(`Update state lock claim for ${stateFile} is malformed`);
  }
  return {
    format: UPDATE_STATE_LOCK_CLAIM_FORMAT,
    pid: Number(value.pid),
    processGroupId: Number(value.processGroupId),
    startedAt: value.startedAt,
    token: value.token,
    createdAt: String(value.createdAt || ''),
  };
}

// Release-verification read: null means proven absent, a returned claim means
// proven present, and any transient, malformed, or non-owner-only directory
// state throws so the caller can distinguish "unverifiable" from "gone".
// Release requires the exact owner-only directory shape; a concurrent reclaim
// marker or foreign entry fails closed.
function readLockClaimStrict(stateFile: string): UpdateStateLockClaim | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(updateStateLockDir(stateFile));
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (entries.length !== 1 || entries[0] !== 'owner.json') {
    throw new Error(`Update state lock claim for ${stateFile} is unverifiable`);
  }
  return parseLockClaimFile(stateFile);
}

// Lenient holder read for liveness decisions and the marker-owning reclaim
// re-read: parses owner.json directly while known reclaim markers coexist.
// Any unreadable or malformed claim state becomes null, which the caller
// treats as unknown and waits on (or fails closed at the deadline).
function readLockClaim(stateFile: string): UpdateStateLockClaim | null {
  try {
    return parseLockClaimFile(stateFile);
  } catch {
    return null;
  }
}

// Tri-state holder liveness. Only an exact identity match proves the holder
// live; only a proven-gone process proves it dead. Anything that cannot be
// proven stays unknown and must be waited out, never broken.
function claimLiveness(
  claim: UpdateStateLockClaim,
  readIdentity: (pid: number) => ServerProcessIdentity | null,
): ClaimLiveness {
  let identity;
  try {
    identity = readIdentity(claim.pid);
  } catch {
    // An identity-read anomaly is not proof of death.
    return 'unknown';
  }
  if (identity) {
    return matchingProcessIdentity(
      { pid: claim.pid, processGroupId: claim.processGroupId, startedAt: claim.startedAt },
      identity,
    )
      ? 'live'
      // The PID was reused by a different process: the claim holder is gone.
      : 'dead';
  }
  // Process inspection found no process, but absence must be proven by the
  // kernel before a claim is broken.
  try {
    process.kill(claim.pid, 0);
    return 'unknown';
  } catch (error) {
    if (fsErrorCode(error) === 'ESRCH') return 'dead';
    // EPERM/EACCES means the process exists but is not signalable by us.
    return 'unknown';
  }
}

function lockFailure(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = UPDATE_STATE_LOCK_ERROR_CODE;
  return error;
}

function reclaimMarkerDir(stateFile: string, claimToken: string): string {
  // The claim token is read from foreign claim state; hash it so the marker
  // is always exactly one safe child of the lock directory, regardless of
  // what the token string contains.
  const tokenDigest = crypto.createHash('sha256').update(claimToken).digest('hex');
  return path.join(updateStateLockDir(stateFile), `.reclaim-${tokenDigest}`);
}

// Claim-scoped, exclusive stale recovery. A breaker that observed a dead
// claim must not rename the lock path on that stale observation alone:
// between the observation and the rename, the dead claim may already have
// been reclaimed and a new live claim published (ABA). The breaker first
// creates an exclusive marker directory keyed to the observed claim token,
// then re-reads the exact holder and liveness, and renames only while it
// owns that marker. Cleanup removes only this token-keyed marker, so a
// replacement claim's own marker is never touched. A crashed breaker can
// leave the marker behind; recovery then fails closed visibly.
function tryReclaimDeadClaim(
  stateFile: string,
  observed: UpdateStateLockClaim,
  readIdentity: (pid: number) => ServerProcessIdentity | null,
): ReclaimOutcome {
  const lockDir = updateStateLockDir(stateFile);
  const markerDir = reclaimMarkerDir(stateFile, observed.token);
  try {
    fs.mkdirSync(markerDir, { recursive: false });
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT') return 'gone';
    // EEXIST: another breaker pinned this claim first. Any other error is a
    // failed recovery the caller bounds by its deadline.
    return 'failed';
  }
  try {
    // Re-read the exact holder and liveness before touching the lock path.
    const holder = readLockClaim(stateFile);
    const stillObserved = holder
      && holder.token === observed.token
      && claimLiveness(holder, readIdentity) === 'dead';
    if (stillObserved) {
      const stale = `${lockDir}.stale-${process.pid}-${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockDir, stale);
      } catch (renameError) {
        if (fsErrorCode(renameError) === 'ENOENT') return 'gone';
        // Persistent failures (EACCES, EBUSY, ...) surface to the caller's
        // bounded deadline instead of looping silently.
        return 'failed';
      }
      try {
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        // The renamed stale claim no longer blocks anyone.
      }
      return 'reclaimed';
    }
    return 'failed';
  } finally {
    // Remove only this observation's token-keyed marker. If the claim
    // directory was renamed away, this path resolves into the replacement
    // directory, which never held this marker; removal is a no-op there.
    try {
      fs.rmSync(markerDir, { recursive: true, force: true });
    } catch {
      // A leftover marker fails closed on the next reclaim attempt.
    }
  }
}

// A crashed publisher can leave its finished temporary claim directory
// behind (it renamed never happened). Orphans older than the grace window
// are collected best-effort after a successful acquisition; the lock itself
// never depends on them.
function sweepOrphanClaimDirs(stateFile: string): void {
  const lockDir = updateStateLockDir(stateFile);
  const parent = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.claim-`;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const orphan = path.join(parent, entry);
    try {
      if (now - fs.statSync(orphan).mtimeMs < UPDATE_STATE_ORPHAN_GRACE_MS) continue;
      fs.rmSync(orphan, { recursive: true, force: true });
    } catch {
      // Orphan collection is best-effort and never fails an acquisition.
    }
  }
}

// Creates the exclusive claim and publishes this process's exact identity
// into it atomically. Acquisition fails closed when this process cannot prove
// its own identity: a claim without exact identity could be mistaken for a
// dead holder and stolen. A claim is broken only when its complete recorded
// identity is proven dead; a live holder is waited for until the bounded
// deadline, and an unreadable or malformed claim also fails visibly at the
// deadline instead of being guessed dead.
function acquireUpdateStateLock(
  stateFile: string,
  options: UpdateStateCommitOptions = {},
): UpdateStateLockClaim {
  const timeoutMs = options.lockTimeoutMs ?? UPDATE_STATE_LOCK_TIMEOUT_MS;
  // Waiting mode must never busy-loop: a non-positive poll is normalized to
  // 1ms. Zero-timeout writers never reach the sleep, so this only shapes
  // writers that are allowed to poll. The deadline cap below keeps every
  // sleep inside the remaining budget regardless.
  const pollMs = Math.max(1, options.lockPollMs ?? UPDATE_STATE_LOCK_POLL_MS);
  const readIdentity = options.readProcessIdentity || readServerProcessIdentity;
  const sleep = options.sleep || sleepSync;
  const lockDir = updateStateLockDir(stateFile);
  const identity = readSelfIdentity(readIdentity);
  if (!identity) {
    throw lockFailure(
      `Cannot acquire the update state lock for ${stateFile}: this process cannot prove its own identity`,
    );
  }
  const claim: UpdateStateLockClaim = {
    format: UPDATE_STATE_LOCK_CLAIM_FORMAT,
    pid: process.pid,
    processGroupId: identity.processGroupId,
    startedAt: identity.startedAt,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const startedAt = Date.now();
  let blockedMessage = `Timed out acquiring the update state lock on ${stateFile}`;
  const waits = timeoutMs > 0;
  // A non-waiting writer gets one publication attempt plus one immediate
  // retry after a successful reclaim; nothing may loop past that count.
  const maxAttempts = waits ? Number.POSITIVE_INFINITY : 2;
  let attempt = 0;
  let reclaimUsed = false;
  for (;;) {
    attempt += 1;
    if (!fs.existsSync(lockDir)) sweepOrphanClaimDirs(stateFile);
    const stagingDir = `${lockDir}.claim-${process.pid}-${claim.token}`;
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
      writeJsonAtomic(path.join(stagingDir, 'owner.json'), claim);
      fs.renameSync(stagingDir, lockDir);
      return claim;
    } catch (error) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Orphan collection will gather an abandoned staging directory.
      }
      const publishErrorCode = fsErrorCode(error);
      if (publishErrorCode !== 'ENOENT' && publishErrorCode !== 'EEXIST' && publishErrorCode !== 'ENOTEMPTY') {
        throw error;
      }
      if (publishErrorCode === 'EEXIST' || publishErrorCode === 'ENOTEMPTY') {
        const holder = readLockClaim(stateFile);
        const liveness = holder ? claimLiveness(holder, readIdentity) : 'unknown';
        if (holder && liveness === 'dead') {
          // Exact identity proof shows the holder died or its PID was
          // reused. A non-waiting writer may spend its single synchronous
          // reclaim attempt here; the retry still passes the bounded
          // boundary below.
          const mayReclaim = waits || (!reclaimUsed && attempt < maxAttempts);
          if (mayReclaim) {
            reclaimUsed = true;
            const outcome = tryReclaimDeadClaim(stateFile, holder, readIdentity);
            if (outcome !== 'failed' && attempt < maxAttempts) {
              blockedMessage = waits
                ? `Timed out re-acquiring the update state lock on ${stateFile} after stale recovery`
                : `Update state lock on ${stateFile} was recovered from dead PID ${holder.pid}, `
                  + 'but no retry attempt remains for this non-waiting writer; retry the operation';
              continue;
            }
            blockedMessage = waits
              ? `Timed out recovering the proven-dead update state lock held by PID ${holder.pid} on ${stateFile}; `
                + 'inspect the lock directory if this persists'
              : `Update state lock on ${stateFile} carries a proven-dead claim from PID ${holder.pid} `
                + 'that could not be recovered without waiting; inspect the lock directory';
          } else {
            blockedMessage = waits
              ? `Timed out recovering the proven-dead update state lock held by PID ${holder.pid} on ${stateFile}; `
                + 'inspect the lock directory if this persists'
              : `Update state lock on ${stateFile} carries another proven-dead claim from PID ${holder.pid}; `
                + 'this non-waiting writer already spent its single recovery attempt';
          }
        } else if (holder && liveness === 'live') {
          blockedMessage = waits
            ? `Timed out waiting for the update state lock held by live PID ${holder.pid} on ${stateFile}`
            : `Update state lock on ${stateFile} is held by live PID ${holder.pid}; this writer does not wait for the lock`;
        } else {
          blockedMessage = waits
            ? `Timed out waiting for an unverifiable update state lock on ${stateFile}; `
              + 'inspect the lock directory if this persists'
            : `Update state lock on ${stateFile} is unverifiable; this writer does not wait for the lock`;
        }
      } else {
        blockedMessage = waits
          ? `Timed out publishing the update state lock claim for ${stateFile}; the Config directory is unstable`
          : `Update state lock claim for ${stateFile} could not be published; the Config directory is unstable`;
      }
      // Common bounded boundary: every retry path passes here, so no outcome
      // (including a successful stale reclaim) can loop past the deadline or
      // the explicit attempt count. A non-waiting writer never sleeps. The
      // sleep is capped to the remaining deadline so acquisition never
      // overshoots lockTimeoutMs by a full poll interval.
      const elapsedMs = Date.now() - startedAt;
      if (!waits || attempt >= maxAttempts || elapsedMs >= timeoutMs) {
        throw lockFailure(blockedMessage);
      }
      sleep(Math.min(pollMs, timeoutMs - elapsedMs));
    }
  }
}

// Releases the lock only while it still carries this exact claim. A claim
// that no longer matches belongs to a later holder and must stay untouched;
// proven absence or proven replacement both satisfy the release goal. An
// unverifiable claim state or a failed rename is retried within the bounded
// deadline, and false is returned only when the exact claim could not be
// proven released — callers must surface that instead of reporting success.
function releaseUpdateStateLock(
  stateFile: string,
  claim: UpdateStateLockClaim,
  options: UpdateStateCommitOptions = {},
): boolean {
  const timeoutMs = options.lockTimeoutMs ?? UPDATE_STATE_LOCK_TIMEOUT_MS;
  const pollMs = Math.max(1, options.lockPollMs ?? UPDATE_STATE_LOCK_POLL_MS);
  const sleep = options.sleep || sleepSync;
  const lockDir = updateStateLockDir(stateFile);
  const startedAt = Date.now();
  for (;;) {
    let holder: UpdateStateLockClaim | null = null;
    let verifiable = true;
    try {
      holder = readLockClaimStrict(stateFile);
    } catch {
      verifiable = false;
    }
    if (verifiable) {
      if (!holder) {
        if (pendingLockReleases.get(stateFile)?.token === claim.token) {
          pendingLockReleases.delete(stateFile);
        }
        return true;
      }
      if (
        holder.token !== claim.token
        || holder.pid !== claim.pid
        || holder.processGroupId !== claim.processGroupId
        || holder.startedAt !== claim.startedAt
      ) {
        // Proven replaced: this exact claim no longer holds the lock.
        if (pendingLockReleases.get(stateFile)?.token === claim.token) {
          pendingLockReleases.delete(stateFile);
        }
        return true;
      }
      try {
        const released = `${lockDir}.released-${process.pid}-${crypto.randomUUID()}`;
        fs.renameSync(lockDir, released);
        try {
          fs.rmSync(released, { recursive: true, force: true });
        } catch {
          // The renamed claim no longer blocks anyone.
        }
        if (pendingLockReleases.get(stateFile)?.token === claim.token) {
          pendingLockReleases.delete(stateFile);
        }
        return true;
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') {
          // Raced away between the read and the rename: fall through to the
          // shared bounded boundary and re-verify on the next attempt.
        }
        // Any other rename failure also falls through to the same boundary.
      }
    }
    // Single shared bounded boundary: every non-terminal outcome (unverifiable
    // claim, raced rename, persistent rename failure) crosses here, so no
    // path can loop past the deadline or skip the attempt bound.
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      pendingLockReleases.set(stateFile, claim);
      return false;
    }
    // Every retryable path uses the shared capped sleep when a positive
    // timeout exists; zero-timeout writers already returned at the boundary.
    sleep(Math.min(pollMs, timeoutMs - elapsedMs));
  }
}

function recoverPendingLockRelease(
  stateFile: string,
  options: UpdateStateCommitOptions,
): void {
  const pending = pendingLockReleases.get(stateFile);
  if (!pending) return;
  if (releaseUpdateStateLock(stateFile, pending, options)) return;
  throw lockFailure(
    `Update state lock claim for ${stateFile} is still pending release; `
    + 'retry this update operation after the Config filesystem recovers, or restart Farming',
  );
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
