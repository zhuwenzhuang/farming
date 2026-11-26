import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isSameOrDescendantPath as isInside } from './path-containment.cjs';

const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OBJECT_ID_RE = /^[0-9a-f]{40,64}$/i;
const SAFE_REF_SEGMENT_RE = /[^A-Za-z0-9._-]/g;
const GIT_TIMEOUT_MS = 15_000;
const DIFF_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_CHECKPOINTS_PER_AGENT = 50;
const MAX_TOTAL_CHECKPOINTS = 500;

const GIT_ENV: NodeJS.ProcessEnv = {
  LANG: 'C',
  LANGUAGE: 'C',
  LC_ALL: 'C',
  LC_MESSAGES: 'C',
  GIT_OPTIONAL_LOCKS: '0',
};

export type TurnCheckpointKind = 'turn' | 'manual' | 'pre-restore';

export interface TurnCheckpointFileStat {
  additions: number | null;
  deletions: number | null;
  path: string;
  status: string;
}

export interface TurnCheckpointRecord {
  afterCommit: string;
  afterRef: string;
  afterTree: string;
  agentId: string;
  beforeCommit: string;
  beforeRef: string;
  beforeTree: string;
  createdAt: string;
  files: TurnCheckpointFileStat[];
  id: string;
  kind: TurnCheckpointKind;
  repoRoot: string;
  summary: string;
  turnHandle: string;
  workspace: string;
}

export interface TurnCheckpointDiffResult {
  checkpoint: TurnCheckpointRecord;
  files: TurnCheckpointFileStat[];
  patch: string;
  truncated: boolean;
}

export interface TurnCheckpointRestoreResult {
  checkpointId: string;
  removedCount: number;
  restored: boolean;
  restoredCount: number;
  safetyCheckpoint: TurnCheckpointRecord | null;
  target: 'before' | 'after';
}

export interface CaptureTurnCheckpointInput {
  agentId: string;
  force?: boolean;
  kind?: TurnCheckpointKind;
  summary?: string;
  turnHandle?: string;
  workspace: string;
}

export interface TurnCheckpointServiceOptions {
  gitPath?: string;
  maxCheckpointsPerAgent?: number;
  maxTotalCheckpoints?: number;
  onWorkspaceMutated?: (repoRoot: string) => void;
  storageFile: string;
}

interface PersistedCheckpointsEnvelope {
  checkpoints: TurnCheckpointRecord[];
  version: 1;
}

interface BaselineState {
  capturedAt: number;
  commitOid: string;
  repoRoot: string;
  treeOid: string;
}

export class TurnCheckpointError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TurnCheckpointError';
    this.statusCode = statusCode;
  }
}

function sanitizeRefSegment(value: string): string {
  const cleaned = String(value || '').trim().replace(SAFE_REF_SEGMENT_RE, '_').replace(/\.{2,}/g, '_');
  return cleaned.slice(0, 96) || 'agent';
}

function execGit(
  gitPath: string,
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number } = {},
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        env: { ...process.env, ...GIT_ENV, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { code?: string | number; stderr?: string; stdout?: string };
          enriched.stdout = stdout;
          enriched.stderr = stderr;
          reject(enriched);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseNameStatusZ(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++] || '';
      const newPath = parts[i++] || '';
      if (oldPath) map.set(oldPath, 'D');
      if (newPath) map.set(newPath, status[0]);
      continue;
    }
    const filePath = parts[i++] || '';
    if (filePath) map.set(filePath, status[0]);
  }
  return map;
}

function parseNumstatZ(stdout: string, statusByPath: ReadonlyMap<string, string>): TurnCheckpointFileStat[] {
  const files: TurnCheckpointFileStat[] = [];
  const parts = stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i++];
    if (!entry) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(entry);
    if (!match) continue;
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    let filePath = match[3];
    if (!filePath) {
      // Rename entry under -z emits empty path followed by oldPath and newPath NUL fields.
      const _oldPath = parts[i++] || '';
      filePath = parts[i++] || _oldPath;
    }
    if (!filePath) continue;
    files.push({
      path: filePath,
      status: statusByPath.get(filePath) || 'M',
      additions,
      deletions,
    });
  }
  return files;
}

export class TurnCheckpointService {
  private readonly gitPath: string;
  private readonly storageFile: string;
  private readonly maxPerAgent: number;
  private readonly maxTotal: number;
  private readonly onWorkspaceMutated?: (repoRoot: string) => void;
  private readonly baselines = new Map<string, BaselineState>();
  private readonly repoQueues = new Map<string, Promise<void>>();
  private checkpoints: TurnCheckpointRecord[] = [];
  private loaded = false;

  constructor(options: TurnCheckpointServiceOptions) {
    this.storageFile = options.storageFile;
    this.gitPath = options.gitPath || 'git';
    this.maxPerAgent = Math.max(2, options.maxCheckpointsPerAgent ?? MAX_CHECKPOINTS_PER_AGENT);
    this.maxTotal = Math.max(this.maxPerAgent, options.maxTotalCheckpoints ?? MAX_TOTAL_CHECKPOINTS);
    this.onWorkspaceMutated = options.onWorkspaceMutated;
  }

  listCheckpoints(agentId: string): TurnCheckpointRecord[] {
    this.ensureLoaded();
    return this.checkpoints
      .filter(cp => cp.agentId === agentId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  getCheckpoint(agentId: string, checkpointId: string): TurnCheckpointRecord | null {
    this.ensureLoaded();
    return this.checkpoints.find(cp => cp.agentId === agentId && cp.id === checkpointId) ?? null;
  }

  async captureTurnBaseline(agentId: string, workspace: string): Promise<boolean> {
    if (!agentId || !workspace) return false;
    const repoRoot = await this.resolveGitRepoRoot(workspace);
    if (!repoRoot) return false;
    return await this.runRepoSerialized(repoRoot, async () => {
      try {
        const snapshot = await this.captureWorkspaceTree(repoRoot);
        this.baselines.set(agentId, {
          repoRoot,
          treeOid: snapshot.treeOid,
          commitOid: snapshot.commitOid,
          capturedAt: Date.now(),
        });
        return true;
      } catch {
        return false;
      }
    });
  }

  async captureTurnCheckpoint(input: CaptureTurnCheckpointInput): Promise<TurnCheckpointRecord | null> {
    if (!input.agentId || !input.workspace) return null;
    this.ensureLoaded();
    const repoRoot = await this.resolveGitRepoRoot(input.workspace);
    if (!repoRoot) return null;

    return await this.runRepoSerialized(repoRoot, async () => {
      const afterSnapshot = await this.captureWorkspaceTree(repoRoot);
      const baseline = this.baselines.get(input.agentId);
      let beforeTree = '';
      let beforeCommit = '';
      if (baseline && baseline.repoRoot === repoRoot) {
        beforeTree = baseline.treeOid;
        beforeCommit = baseline.commitOid;
      } else {
        const previousForAgent = this.checkpoints.find(
          cp => cp.agentId === input.agentId && cp.repoRoot === repoRoot,
        );
        if (previousForAgent && await this.objectExists(repoRoot, previousForAgent.afterTree, 'tree')) {
          beforeTree = previousForAgent.afterTree;
          beforeCommit = previousForAgent.afterCommit;
        } else {
          const headCommit = await this.resolveHeadCommit(repoRoot);
          beforeTree = headCommit ? await this.treeForCommit(repoRoot, headCommit) : EMPTY_TREE_OID;
          beforeCommit = headCommit || await this.createCommitForTree(repoRoot, beforeTree, 'farming checkpoint base');
        }
      }

      // Advance baseline to the newly captured state for the next turn.
      this.baselines.set(input.agentId, {
        repoRoot,
        treeOid: afterSnapshot.treeOid,
        commitOid: afterSnapshot.commitOid,
        capturedAt: Date.now(),
      });

      const files = await this.diffTreeStats(repoRoot, beforeTree, afterSnapshot.treeOid);
      if (files.length === 0 && input.force !== true) {
        return null;
      }

      const id = `cp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const safeAgent = sanitizeRefSegment(input.agentId);
      const beforeRef = `refs/farming/checkpoints/${safeAgent}/${id}-before`;
      const afterRef = `refs/farming/checkpoints/${safeAgent}/${id}-after`;

      await execGit(this.gitPath, repoRoot, ['update-ref', beforeRef, beforeCommit]);
      await execGit(this.gitPath, repoRoot, ['update-ref', afterRef, afterSnapshot.commitOid]);

      const record: TurnCheckpointRecord = {
        id,
        agentId: input.agentId,
        turnHandle: String(input.turnHandle || ''),
        kind: input.kind || 'turn',
        summary: String(input.summary || '').trim().slice(0, 200),
        repoRoot,
        workspace: input.workspace,
        beforeRef,
        afterRef,
        beforeTree,
        afterTree: afterSnapshot.treeOid,
        beforeCommit,
        afterCommit: afterSnapshot.commitOid,
        files,
        createdAt: new Date().toISOString(),
      };

      this.checkpoints.unshift(record);
      await this.pruneExcessCheckpoints();
      this.persist();
      return record;
    });
  }

  async getCheckpointDiff(
    agentId: string,
    checkpointId: string,
    filePath?: string,
  ): Promise<TurnCheckpointDiffResult> {
    const checkpoint = this.getCheckpoint(agentId, checkpointId);
    if (!checkpoint) {
      throw new TurnCheckpointError('Checkpoint not found', 404);
    }
    const repoRoot = checkpoint.repoRoot;
    const [beforeOk, afterOk] = await Promise.all([
      this.objectExists(repoRoot, checkpoint.beforeTree, 'tree'),
      this.objectExists(repoRoot, checkpoint.afterTree, 'tree'),
    ]);
    if (!beforeOk || !afterOk) {
      throw new TurnCheckpointError('Checkpoint Git snapshot is no longer available in this repository', 410);
    }
    const args = ['diff', '--unified=3', '--no-ext-diff', checkpoint.beforeTree, checkpoint.afterTree];
    if (filePath && filePath.trim()) {
      args.push('--', filePath.trim());
    }
    let patch = '';
    let truncated = false;
    try {
      const result = await execGit(this.gitPath, repoRoot, args, { maxBuffer: DIFF_MAX_BUFFER });
      patch = result.stdout;
    } catch (caught) {
      const error = caught as Error & { code?: string | number; stdout?: string };
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        patch = String(error.stdout || '');
        truncated = true;
      } else {
        throw new TurnCheckpointError(error.message || 'Failed to compute checkpoint diff', 500);
      }
    }
    return {
      checkpoint,
      files: checkpoint.files,
      patch,
      truncated,
    };
  }

  async restoreCheckpoint(
    agentId: string,
    checkpointId: string,
    options: { isAgentBusy?: boolean; target?: 'before' | 'after' } = {},
  ): Promise<TurnCheckpointRestoreResult> {
    if (options.isAgentBusy) {
      throw new TurnCheckpointError('Cannot restore a checkpoint while the Agent is actively running a turn', 409);
    }
    const checkpoint = this.getCheckpoint(agentId, checkpointId);
    if (!checkpoint) {
      throw new TurnCheckpointError('Checkpoint not found', 404);
    }
    const target: 'before' | 'after' = options.target === 'after' ? 'after' : 'before';
    const targetTree = target === 'after' ? checkpoint.afterTree : checkpoint.beforeTree;
    const repoRoot = checkpoint.repoRoot;

    return await this.runRepoSerialized(repoRoot, async () => {
      if (!await this.objectExists(repoRoot, targetTree, 'tree')) {
        throw new TurnCheckpointError('Target checkpoint snapshot no longer exists in Git history', 410);
      }

      // 1. Capture current state and save an automatic safety backup checkpoint before modifying disk.
      const currentSnapshot = await this.captureWorkspaceTree(repoRoot);
      const diffToTarget = await this.diffTreeNameStatus(repoRoot, currentSnapshot.treeOid, targetTree);
      if (diffToTarget.size === 0) {
        return {
          restored: true,
          checkpointId,
          target,
          restoredCount: 0,
          removedCount: 0,
          safetyCheckpoint: null,
        };
      }

      const safetyFiles = await this.diffTreeStats(repoRoot, targetTree, currentSnapshot.treeOid);
      const safetyId = `cp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const safeAgent = sanitizeRefSegment(agentId);
      const safetyBeforeRef = `refs/farming/checkpoints/${safeAgent}/${safetyId}-before`;
      const safetyAfterRef = `refs/farming/checkpoints/${safeAgent}/${safetyId}-after`;
      const targetCommit = target === 'after' ? checkpoint.afterCommit : checkpoint.beforeCommit;
      await execGit(this.gitPath, repoRoot, ['update-ref', safetyBeforeRef, targetCommit]);
      await execGit(this.gitPath, repoRoot, ['update-ref', safetyAfterRef, currentSnapshot.commitOid]);

      const safetyCheckpoint: TurnCheckpointRecord = {
        id: safetyId,
        agentId,
        turnHandle: checkpoint.turnHandle,
        kind: 'pre-restore',
        summary: `Pre-rollback safety backup (${checkpoint.id})`,
        repoRoot,
        workspace: checkpoint.workspace,
        beforeRef: safetyBeforeRef,
        afterRef: safetyAfterRef,
        beforeTree: targetTree,
        afterTree: currentSnapshot.treeOid,
        beforeCommit: targetCommit,
        afterCommit: currentSnapshot.commitOid,
        files: safetyFiles,
        createdAt: new Date().toISOString(),
      };
      this.checkpoints.unshift(safetyCheckpoint);
      await this.pruneExcessCheckpoints();
      this.persist();

      // 2. Apply exact tree delta from currentTree -> targetTree without touching .gitignored files.
      const toRemove: string[] = [];
      const toCheckout: string[] = [];
      for (const [relPath, status] of diffToTarget.entries()) {
        if (status === 'D') {
          toRemove.push(relPath);
        } else {
          toCheckout.push(relPath);
        }
      }

      for (const relPath of toRemove) {
        const absPath = path.resolve(repoRoot, relPath);
        if (!isInside(repoRoot, absPath) || absPath === repoRoot) continue;
        await fsp.rm(absPath, { force: true, recursive: true });
        // Prune empty parent directories up to repoRoot.
        let parent = path.dirname(absPath);
        while (parent !== repoRoot && isInside(repoRoot, parent)) {
          try {
            const entries = await fsp.readdir(parent);
            if (entries.length > 0) break;
            await fsp.rmdir(parent);
            parent = path.dirname(parent);
          } catch {
            break;
          }
        }
      }

      if (toCheckout.length > 0) {
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'farming-cp-restore-'));
        const tempIndex = path.join(tempDir, 'index');
        try {
          const env = { GIT_INDEX_FILE: tempIndex };
          await execGit(this.gitPath, repoRoot, ['read-tree', targetTree], { env });
          let batch: string[] = [];
          let bytes = 0;
          const flush = async () => {
            if (batch.length === 0) return;
            await execGit(this.gitPath, repoRoot, ['checkout-index', '-f', '--', ...batch], { env });
            batch = [];
            bytes = 0;
          };
          for (const relPath of toCheckout) {
            const size = Buffer.byteLength(relPath) + 1;
            if (bytes + size > 16 * 1024) await flush();
            batch.push(relPath);
            bytes += size;
          }
          await flush();
        } finally {
          await fsp.rm(tempDir, { force: true, recursive: true });
        }
      }

      // 3. Refresh baseline to the restored tree & invalidate workspace caches.
      const restoredSnapshot = await this.captureWorkspaceTree(repoRoot);
      this.baselines.set(agentId, {
        repoRoot,
        treeOid: restoredSnapshot.treeOid,
        commitOid: restoredSnapshot.commitOid,
        capturedAt: Date.now(),
      });
      this.onWorkspaceMutated?.(repoRoot);

      return {
        restored: true,
        checkpointId,
        target,
        restoredCount: toCheckout.length,
        removedCount: toRemove.length,
        safetyCheckpoint,
      };
    });
  }

  private async resolveGitRepoRoot(workspace: string): Promise<string | null> {
    try {
      const { stdout } = await execGit(this.gitPath, workspace, ['rev-parse', '--show-toplevel']);
      const root = stdout.trim();
      return root ? await fsp.realpath(root) : null;
    } catch {
      return null;
    }
  }

  private async resolveHeadCommit(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await execGit(this.gitPath, repoRoot, ['rev-parse', '--verify', 'HEAD']);
      const oid = stdout.trim();
      return OBJECT_ID_RE.test(oid) ? oid : null;
    } catch {
      return null;
    }
  }

  private async treeForCommit(repoRoot: string, commitOid: string): Promise<string> {
    const { stdout } = await execGit(this.gitPath, repoRoot, ['rev-parse', `${commitOid}^{tree}`]);
    const oid = stdout.trim();
    if (!OBJECT_ID_RE.test(oid)) throw new TurnCheckpointError('Failed to resolve Git tree', 500);
    return oid;
  }

  private async objectExists(repoRoot: string, oid: string, expectedType: 'tree' | 'commit'): Promise<boolean> {
    if (!OBJECT_ID_RE.test(oid)) return false;
    try {
      const { stdout } = await execGit(this.gitPath, repoRoot, ['cat-file', '-t', oid]);
      return stdout.trim() === expectedType;
    } catch {
      return false;
    }
  }

  private async createCommitForTree(repoRoot: string, treeOid: string, message: string): Promise<string> {
    const { stdout } = await execGit(
      this.gitPath,
      repoRoot,
      ['commit-tree', treeOid, '-m', message],
      {
        env: {
          GIT_AUTHOR_NAME: 'Farming Checkpoint',
          GIT_AUTHOR_EMAIL: 'checkpoint@farming.local',
          GIT_COMMITTER_NAME: 'Farming Checkpoint',
          GIT_COMMITTER_EMAIL: 'checkpoint@farming.local',
        },
      },
    );
    const oid = stdout.trim();
    if (!OBJECT_ID_RE.test(oid)) throw new TurnCheckpointError('git commit-tree failed', 500);
    return oid;
  }

  private async captureWorkspaceTree(repoRoot: string): Promise<{ commitOid: string; treeOid: string }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'farming-cp-capture-'));
    const tempIndex = path.join(tempDir, 'index');
    try {
      const env = { GIT_INDEX_FILE: tempIndex };
      const headCommit = await this.resolveHeadCommit(repoRoot);
      if (headCommit) {
        await execGit(this.gitPath, repoRoot, ['read-tree', headCommit], { env });
      } else {
        await execGit(this.gitPath, repoRoot, ['read-tree', '--empty'], { env });
      }
      await execGit(this.gitPath, repoRoot, ['add', '-A'], { env });
      const { stdout } = await execGit(this.gitPath, repoRoot, ['write-tree'], { env });
      const treeOid = stdout.trim();
      if (!OBJECT_ID_RE.test(treeOid)) {
        throw new TurnCheckpointError('git write-tree returned invalid object id', 500);
      }
      const commitOid = await this.createCommitForTree(repoRoot, treeOid, 'farming turn checkpoint');
      return { treeOid, commitOid };
    } finally {
      await fsp.rm(tempDir, { force: true, recursive: true });
    }
  }

  private async diffTreeNameStatus(
    repoRoot: string,
    fromTree: string,
    toTree: string,
  ): Promise<Map<string, string>> {
    if (fromTree === toTree) return new Map();
    const { stdout } = await execGit(
      this.gitPath,
      repoRoot,
      ['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree],
      { maxBuffer: DIFF_MAX_BUFFER },
    );
    return parseNameStatusZ(stdout);
  }

  private async diffTreeStats(
    repoRoot: string,
    fromTree: string,
    toTree: string,
  ): Promise<TurnCheckpointFileStat[]> {
    if (fromTree === toTree) return [];
    const [nameStatusOut, numstatOut] = await Promise.all([
      execGit(this.gitPath, repoRoot, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree], {
        maxBuffer: DIFF_MAX_BUFFER,
      }),
      execGit(this.gitPath, repoRoot, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', fromTree, toTree], {
        maxBuffer: DIFF_MAX_BUFFER,
      }),
    ]);
    const statusByPath = parseNameStatusZ(nameStatusOut.stdout);
    return parseNumstatZ(numstatOut.stdout, statusByPath);
  }

  private async pruneExcessCheckpoints(): Promise<void> {
    const kept: TurnCheckpointRecord[] = [];
    const removed: TurnCheckpointRecord[] = [];
    const countByAgent = new Map<string, number>();

    for (const cp of this.checkpoints) {
      const agentCount = countByAgent.get(cp.agentId) || 0;
      if (agentCount < this.maxPerAgent && kept.length < this.maxTotal) {
        kept.push(cp);
        countByAgent.set(cp.agentId, agentCount + 1);
      } else {
        removed.push(cp);
      }
    }
    this.checkpoints = kept;

    for (const cp of removed) {
      await execGit(this.gitPath, cp.repoRoot, ['update-ref', '-d', cp.beforeRef]).catch(() => {});
      await execGit(this.gitPath, cp.repoRoot, ['update-ref', '-d', cp.afterRef]).catch(() => {});
    }
  }

  private async runRepoSerialized<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
    const previous = this.repoQueues.get(repoRoot) || Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.repoQueues.set(repoRoot, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.repoQueues.get(repoRoot) === tail) {
        this.repoQueues.delete(repoRoot);
      }
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.storageFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.storageFile, 'utf8')) as Partial<PersistedCheckpointsEnvelope>;
      if (parsed?.version === 1 && Array.isArray(parsed.checkpoints)) {
        this.checkpoints = parsed.checkpoints.filter(
          (item): item is TurnCheckpointRecord => Boolean(item && typeof item.id === 'string' && typeof item.agentId === 'string'),
        );
      }
    } catch {
      this.checkpoints = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      const payload: PersistedCheckpointsEnvelope = {
        version: 1,
        checkpoints: this.checkpoints,
      };
      const tmpFile = `${this.storageFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storageFile);
    } catch (error) {
      console.warn('Failed to persist turn checkpoints:', error);
    }
  }
}
