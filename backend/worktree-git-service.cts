import { invalidateGitWorktreeInfoCache } from './git-worktree-info.cjs';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const defaultExecFile = promisify(execFile) as WorktreeGitExec;

interface WorktreeListRecord {
  branch: string;
  workspace: string;
}

interface WorktreePostcondition {
  branchExists: boolean;
  branchMatches: boolean;
  error?: string;
  exists: boolean;
  proven: boolean;
  registered: boolean;
  worktree: WorktreeListRecord | null;
}

interface PermanentWorktreeIdentity {
  branch: string;
  sourceWorkspace: string;
  workspace: string;
}

const reservationTokenProperty: unique symbol = Symbol('permanentWorktreeReservation');

type ReservedPermanentWorktreeIdentity = PermanentWorktreeIdentity & {
  [reservationTokenProperty]: symbol;
};

interface PermanentWorktreeMutation {
  commandFailure: WorktreeCommandFailure | null;
  postcondition: WorktreePostcondition;
}

interface TemporaryWorktreeIdentity {
  sourceWorkspace: string;
  workspace: string;
}

interface TemporaryWorktreeMutation {
  commandFailure: WorktreeCommandFailure | null;
  identity: TemporaryWorktreeIdentity;
  postcondition: WorktreePostcondition;
}

type ForkWorktreeInspection = {
  dirtyEntries?: never;
  error: string;
  requiresForce?: never;
  sourceWorkspace?: never;
  workspace: string;
} | {
  dirtyEntries: string[];
  error?: never;
  requiresForce: boolean;
  sourceWorkspace: string;
  workspace: string;
};

interface WorktreeDeleteMutation {
  commandFailure: WorktreeCommandFailure | null;
  postcondition: WorktreePostcondition;
}

interface WorktreeCommandFailure {
  cause: unknown;
  message: string;
}

interface WorktreeGitExecOptions {
  maxBuffer: number;
  timeout: number;
}

type WorktreeGitExec = (
  executable: string,
  args: readonly string[],
  options: WorktreeGitExecOptions,
) => Promise<{ stderr: string | Buffer; stdout: string | Buffer }>;

interface WorktreeGitServiceOptions {
  execFile?: WorktreeGitExec;
  identityNonce?: () => string;
  invalidateCache?: () => void;
  now?: () => Date;
  pathExists?: (workspace: string) => boolean | Promise<boolean>;
}

interface WorktreeGitServicePort {
  allocatePermanentWorktree(sourceWorkspace: string): Promise<PermanentWorktreeIdentity>;
  createPermanentWorktree(identity: PermanentWorktreeIdentity): Promise<PermanentWorktreeMutation>;
  createTemporaryWorktree(sourceWorkspace: string): Promise<TemporaryWorktreeMutation>;
  deleteWorktree(identity: TemporaryWorktreeIdentity, force?: boolean): Promise<WorktreeDeleteMutation>;
  inspectForkWorktree(workspace: string): Promise<ForkWorktreeInspection>;
  inspectPostcondition(sourceWorkspace: string, workspace: string, branch?: string): Promise<WorktreePostcondition>;
  listWorktrees(sourceWorkspace: string): Promise<WorktreeListRecord[]>;
  releasePermanentWorktreeReservation(identity: PermanentWorktreeIdentity): void;
  resolveSourceRoot(workspace: string): Promise<string>;
  rollbackPermanentWorktree(identity: PermanentWorktreeIdentity): Promise<{ error?: string; rolledBack: boolean }>;
}

type CommandError = Error & { code?: string | number; stderr?: unknown };

function commandError(value: unknown): CommandError {
  return value instanceof Error ? value as CommandError : new Error(String(value)) as CommandError;
}

function commandErrorMessage(value: unknown, fallback: string): string {
  const error = commandError(value);
  return String(error.stderr || '').trim() || error.message || fallback;
}

function isAbsentFilesystemError(value: unknown): boolean {
  const code = commandError(value).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function timestampSlug(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function isFarmingForkWorktreePath(workspace: string): boolean {
  const basename = path.basename(String(workspace || '').replace(/[\\/]+$/, ''));
  return /-farming-fork-\d{8}-\d{6}(?:-\d+)?$/.test(basename);
}

function statusEntriesFromPorcelain(output: unknown): string[] {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
}

function parseGitWorktreeList(output: unknown): WorktreeListRecord[] {
  const worktrees: WorktreeListRecord[] = [];
  let current: WorktreeListRecord | null = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { workspace: path.resolve(line.slice('worktree '.length)), branch: '' };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

class WorktreeGitService implements WorktreeGitServicePort {
  private readonly execFile: WorktreeGitExec;
  private readonly identityNonce: () => string;
  private readonly invalidateCache: () => void;
  private readonly now: () => Date;
  private readonly pathExists: (workspace: string) => boolean | Promise<boolean>;
  private readonly permanentWorktreeReservations = new Map<string, symbol>();
  private readonly temporaryWorktreeReservations = new Set<string>();

  constructor(options: WorktreeGitServiceOptions = {}) {
    this.execFile = options.execFile || defaultExecFile;
    this.identityNonce = options.identityNonce || (() => crypto.randomBytes(16).toString('hex'));
    this.invalidateCache = options.invalidateCache || invalidateGitWorktreeInfoCache;
    this.now = options.now || (() => new Date());
    this.pathExists = options.pathExists || (async (workspace: string) => {
      try {
        await fs.promises.lstat(workspace);
        return true;
      } catch (caught) {
        if (isAbsentFilesystemError(caught)) return false;
        throw caught;
      }
    });
  }

  private reservationKey(identity: Pick<PermanentWorktreeIdentity, 'sourceWorkspace' | 'workspace'>): string {
    return `${path.resolve(identity.sourceWorkspace)}\0${path.resolve(identity.workspace)}`;
  }

  private reservationToken(identity: PermanentWorktreeIdentity): symbol | undefined {
    return (identity as Partial<ReservedPermanentWorktreeIdentity>)[reservationTokenProperty];
  }

  private reserveIdentity(identity: PermanentWorktreeIdentity): symbol {
    const key = this.reservationKey(identity);
    const suppliedToken = this.reservationToken(identity);
    const currentToken = this.permanentWorktreeReservations.get(key);
    if (suppliedToken) {
      if (currentToken !== suppliedToken) {
        throw new Error('Permanent worktree reservation is no longer active');
      }
      return suppliedToken;
    }
    if (currentToken) throw new Error('Permanent worktree identity is already reserved');
    const token = Symbol(key);
    this.permanentWorktreeReservations.set(key, token);
    return token;
  }

  private reservedIdentity(identity: PermanentWorktreeIdentity, token: symbol): PermanentWorktreeIdentity {
    const reserved = { ...identity } as ReservedPermanentWorktreeIdentity;
    Object.defineProperty(reserved, reservationTokenProperty, { value: token });
    return reserved;
  }

  releasePermanentWorktreeReservation(identity: PermanentWorktreeIdentity): void {
    const token = this.reservationToken(identity);
    if (!token) return;
    const key = this.reservationKey(identity);
    if (this.permanentWorktreeReservations.get(key) === token) {
      this.permanentWorktreeReservations.delete(key);
    }
  }

  async listWorktrees(sourceWorkspace: string): Promise<WorktreeListRecord[]> {
    const { stdout } = await this.execFile('git', [
      '-C', sourceWorkspace, 'worktree', 'list', '--porcelain',
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return parseGitWorktreeList(stdout);
  }

  private async branchExists(sourceWorkspace: string, branch: string): Promise<boolean> {
    try {
      await this.execFile('git', [
        '-C', sourceWorkspace, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
      ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return true;
    } catch (caught) {
      const error = commandError(caught);
      if (Number(error.code) === 1) return false;
      throw caught;
    }
  }

  async inspectPostcondition(
    sourceWorkspace: string,
    workspace: string,
    branch = '',
  ): Promise<WorktreePostcondition> {
    const target = path.resolve(workspace);
    let worktrees: WorktreeListRecord[];
    try {
      worktrees = await this.listWorktrees(sourceWorkspace);
    } catch (caught) {
      return {
        proven: false,
        exists: false,
        registered: false,
        branchMatches: false,
        branchExists: false,
        worktree: null,
        error: commandErrorMessage(caught, 'Failed to inspect git worktrees'),
      };
    }
    const registered = worktrees.find(entry => entry.workspace === target) || null;
    let exists = false;
    try {
      exists = await this.pathExists(target);
    } catch (caught) {
      return {
        proven: false,
        exists: false,
        registered: Boolean(registered),
        branchMatches: !branch || registered?.branch === branch,
        branchExists: false,
        worktree: registered,
        error: commandErrorMessage(caught, 'Failed to inspect worktree path'),
      };
    }
    let branchExists = false;
    if (branch) {
      try {
        branchExists = await this.branchExists(sourceWorkspace, branch);
      } catch (caught) {
        return {
          proven: false,
          exists,
          registered: Boolean(registered),
          branchMatches: !branch || registered?.branch === branch,
          branchExists: false,
          worktree: registered,
          error: commandErrorMessage(caught, 'Failed to inspect git branch'),
        };
      }
    }
    return {
      proven: true,
      exists,
      registered: Boolean(registered),
      branchMatches: !branch || registered?.branch === branch,
      branchExists,
      worktree: registered,
    };
  }

  async resolveSourceRoot(workspace: string): Promise<string> {
    if (!workspace) throw new Error('Source workspace is empty');
    try {
      const { stdout } = await this.execFile('git', [
        '-C', workspace, 'rev-parse', '--show-toplevel',
      ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return String(stdout).trim();
    } catch (caught) {
      throw new Error(commandErrorMessage(caught, 'Source workspace is not inside a git repository'), {
        cause: caught,
      });
    }
  }

  async allocatePermanentWorktree(sourceWorkspace: string): Promise<PermanentWorktreeIdentity> {
    const parentDir = path.dirname(sourceWorkspace);
    const baseName = path.basename(sourceWorkspace);
    const nonce = String(this.identityNonce()).trim().toLowerCase();
    if (!/^[a-z0-9]{16,64}$/.test(nonce)) {
      throw new Error('Permanent worktree identity nonce is invalid');
    }
    const slug = `${timestampSlug(this.now())}-${nonce}`;
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const suffixText = suffix === 1 ? '' : `-${suffix}`;
      const workspace = path.join(parentDir, `${baseName}-farming-worktree-${slug}${suffixText}`);
      const branch = `farming/worktree-${slug}${suffixText}`;
      const identity = { sourceWorkspace, workspace, branch };
      const key = this.reservationKey(identity);
      if (this.permanentWorktreeReservations.has(key)) continue;
      if (await this.pathExists(workspace) || await this.branchExists(sourceWorkspace, branch)) continue;
      if (this.permanentWorktreeReservations.has(key)) continue;
      const token = Symbol(key);
      this.permanentWorktreeReservations.set(key, token);
      return this.reservedIdentity(identity, token);
    }
    throw new Error('Unable to allocate a permanent worktree name');
  }

  private temporaryNonceSlug(): string {
    const nonce = String(this.identityNonce()).trim().toLowerCase();
    if (!/^[a-z0-9]{16,64}$/.test(nonce)) {
      throw new Error('Temporary worktree identity nonce is invalid');
    }
    const digest = crypto.createHash('sha256').update(nonce).digest('hex');
    return BigInt(`0x${digest.slice(0, 32)}`).toString(10).padStart(39, '0');
  }

  private async allocateTemporaryWorktree(sourceWorkspace: string): Promise<TemporaryWorktreeIdentity> {
    const parentDir = path.dirname(sourceWorkspace);
    const baseName = path.basename(sourceWorkspace);
    const slug = `${timestampSlug(this.now())}-${this.temporaryNonceSlug()}`;
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const suffixText = String(suffix).padStart(3, '0');
      const identity = {
        sourceWorkspace,
        workspace: path.join(parentDir, `${baseName}-farming-fork-${slug}${suffixText}`),
      };
      const key = this.reservationKey(identity);
      if (this.temporaryWorktreeReservations.has(key)) continue;
      if (await this.pathExists(identity.workspace)) continue;
      if (this.temporaryWorktreeReservations.has(key)) continue;
      this.temporaryWorktreeReservations.add(key);
      return identity;
    }
    throw new Error('Unable to allocate a temporary worktree name');
  }

  async createTemporaryWorktree(sourceWorkspace: string): Promise<TemporaryWorktreeMutation> {
    const identity = await this.allocateTemporaryWorktree(sourceWorkspace);
    const reservationKey = this.reservationKey(identity);
    let commandFailure: WorktreeCommandFailure | null = null;
    try {
      try {
        await this.execFile('git', [
          '-C', sourceWorkspace, 'worktree', 'add', identity.workspace, 'HEAD',
        ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      } catch (caught) {
        commandFailure = {
          cause: caught,
          message: commandErrorMessage(caught, 'Failed to create git worktree'),
        };
      } finally {
        this.invalidateCache();
      }
      return {
        commandFailure,
        identity,
        postcondition: await this.inspectPostcondition(sourceWorkspace, identity.workspace),
      };
    } finally {
      this.temporaryWorktreeReservations.delete(reservationKey);
    }
  }

  async inspectForkWorktree(workspace: string): Promise<ForkWorktreeInspection> {
    const resolvedWorkspace = workspace ? path.resolve(workspace) : '';
    if (!resolvedWorkspace) return { workspace: resolvedWorkspace, error: 'Workspace is required' };
    if (!isFarmingForkWorktreePath(resolvedWorkspace)) {
      return { workspace: resolvedWorkspace, error: 'Only Farming fork worktrees can be deleted' };
    }
    try {
      if (!(await fs.promises.stat(resolvedWorkspace)).isDirectory()) {
        return { workspace: resolvedWorkspace, error: 'Workspace is not a directory' };
      }
    } catch (caught) {
      return {
        workspace: resolvedWorkspace,
        error: isAbsentFilesystemError(caught)
          ? 'Workspace not found'
          : commandErrorMessage(caught, 'Failed to inspect workspace path'),
      };
    }

    try {
      const { stdout: topLevelOutput } = await this.execFile('git', [
        '-C', resolvedWorkspace, 'rev-parse', '--show-toplevel',
      ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      if (path.resolve(String(topLevelOutput).trim()) !== resolvedWorkspace) {
        return { workspace: resolvedWorkspace, error: 'Workspace must be the root of a Farming fork worktree' };
      }
      const worktrees = await this.listWorktrees(resolvedWorkspace);
      const sourceWorkspace = worktrees[0]?.workspace || resolvedWorkspace;
      const { stdout: statusOutput } = await this.execFile('git', [
        '-C', resolvedWorkspace, 'status', '--porcelain', '--untracked-files=all',
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const dirtyEntries = statusEntriesFromPorcelain(statusOutput);
      return {
        workspace: resolvedWorkspace,
        sourceWorkspace,
        dirtyEntries,
        requiresForce: dirtyEntries.length > 0,
      };
    } catch (caught) {
      return {
        workspace: resolvedWorkspace,
        error: commandErrorMessage(caught, 'Failed to inspect worktree status'),
      };
    }
  }

  async deleteWorktree(
    identity: TemporaryWorktreeIdentity,
    force = false,
  ): Promise<WorktreeDeleteMutation> {
    let commandFailure: WorktreeCommandFailure | null = null;
    const args = ['-C', identity.sourceWorkspace, 'worktree', 'remove'];
    if (force) args.push('--force');
    args.push(identity.workspace);
    try {
      await this.execFile('git', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (caught) {
      commandFailure = {
        cause: caught,
        message: commandErrorMessage(caught, 'Failed to delete git worktree'),
      };
    } finally {
      this.invalidateCache();
    }
    return {
      commandFailure,
      postcondition: await this.inspectPostcondition(
        identity.sourceWorkspace,
        identity.workspace,
      ),
    };
  }

  async createPermanentWorktree(identity: PermanentWorktreeIdentity): Promise<PermanentWorktreeMutation> {
    const reservationToken = this.reserveIdentity(identity);
    let commandFailure: WorktreeCommandFailure | null = null;
    try {
      try {
        await this.execFile('git', [
          '-C', identity.sourceWorkspace,
          'worktree', 'add', '-b', identity.branch, identity.workspace, 'HEAD',
        ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      } catch (caught) {
        commandFailure = {
          cause: caught,
          message: commandErrorMessage(caught, 'Failed to create permanent git worktree'),
        };
      } finally {
        this.invalidateCache();
      }
      return {
        commandFailure,
        postcondition: await this.inspectPostcondition(
          identity.sourceWorkspace,
          identity.workspace,
          identity.branch,
        ),
      };
    } finally {
      const key = this.reservationKey(identity);
      if (this.permanentWorktreeReservations.get(key) === reservationToken) {
        this.permanentWorktreeReservations.delete(key);
      }
    }
  }

  async rollbackPermanentWorktree(
    identity: PermanentWorktreeIdentity,
  ): Promise<{ error?: string; rolledBack: boolean }> {
    const errors: string[] = [];
    try {
      await this.execFile('git', [
        '-C', identity.sourceWorkspace, 'worktree', 'remove', '--force', identity.workspace,
      ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (caught) {
      errors.push(commandErrorMessage(caught, 'Failed to remove the created worktree'));
    } finally {
      this.invalidateCache();
    }
    if (identity.branch) {
      try {
        await this.execFile('git', [
          '-C', identity.sourceWorkspace, 'branch', '-D', identity.branch,
        ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      } catch (caught) {
        errors.push(commandErrorMessage(caught, 'Failed to delete the created worktree branch'));
      }
    }
    const postcondition = await this.inspectPostcondition(
      identity.sourceWorkspace,
      identity.workspace,
      identity.branch,
    );
    // A timeout is an uncertain command outcome. Fresh, exact absence is the
    // authoritative rollback result, even if either cleanup command reported an error.
    if (
      postcondition.proven
      && !postcondition.exists
      && !postcondition.registered
      && !postcondition.branchExists
    ) {
      return { rolledBack: true };
    }
    errors.push(postcondition.error || 'Permanent worktree rollback could not be proven');
    return { rolledBack: false, error: errors.join('; ') };
  }
}

export {
  WorktreeGitService,
  isFarmingForkWorktreePath,
  parseGitWorktreeList,
  statusEntriesFromPorcelain,
  type ForkWorktreeInspection,
  type PermanentWorktreeIdentity,
  type PermanentWorktreeMutation,
  type TemporaryWorktreeIdentity,
  type TemporaryWorktreeMutation,
  type WorktreeGitExec,
  type WorktreeCommandFailure,
  type WorktreeGitServiceOptions,
  type WorktreeGitServicePort,
  type WorktreeListRecord,
  type WorktreeDeleteMutation,
  type WorktreePostcondition,
};
