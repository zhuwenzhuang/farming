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

interface LocalBranchItem {
  checkedOutWorkspace: string;
  current: boolean;
  head: string;
  name: string;
}

interface LocalBranchInventory {
  blockedReason: string;
  blockedReasonCode: LocalBranchBlockedReasonCode;
  blockingAgentIds: string[];
  canSwitch: boolean;
  currentBranch: string;
  dirtyCount: number;
  head: string;
  isGitRepo: boolean;
  items: LocalBranchItem[];
  mainWorkspace: string;
  truncated: boolean;
  workspace: string;
}

type LocalBranchBlockedReasonCode =
  | ''
  | 'active-agents'
  | 'dirty-worktree'
  | 'no-switchable-branch'
  | 'not-git-repository'
  | 'not-main-worktree'
  | 'pending-agent-starts';

interface LocalBranchSwitchRequest {
  branch: string;
  expectedBranch: string;
  expectedHead: string;
}

interface LocalBranchSwitchResult {
  error?: string;
  inventory?: LocalBranchInventory;
  previousBranch?: string;
  previousHead?: string;
  switched: boolean;
  uncertain: boolean;
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
const temporaryReservationTokenProperty: unique symbol = Symbol('temporaryWorktreeReservation');

type ReservedPermanentWorktreeIdentity = PermanentWorktreeIdentity & {
  [reservationTokenProperty]: symbol;
};

type ReservedTemporaryWorktreeIdentity = TemporaryWorktreeIdentity & {
  [temporaryReservationTokenProperty]: symbol;
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

interface TemporaryWorktreeRollback {
  error?: string;
  retainedWorkspace?: string;
  rolledBack: boolean;
  uncertain?: boolean;
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
  allocateTemporaryWorktree(sourceWorkspace: string): Promise<TemporaryWorktreeIdentity>;
  allocatePermanentWorktree(sourceWorkspace: string): Promise<PermanentWorktreeIdentity>;
  createPermanentWorktree(identity: PermanentWorktreeIdentity): Promise<PermanentWorktreeMutation>;
  createTemporaryWorktree(identity: TemporaryWorktreeIdentity): Promise<TemporaryWorktreeMutation>;
  deleteWorktree(identity: TemporaryWorktreeIdentity, force?: boolean): Promise<WorktreeDeleteMutation>;
  inspectForkWorktree(workspace: string): Promise<ForkWorktreeInspection>;
  inspectLocalBranches(workspace: string): Promise<LocalBranchInventory>;
  inspectPostcondition(sourceWorkspace: string, workspace: string, branch?: string): Promise<WorktreePostcondition>;
  listWorktrees(sourceWorkspace: string): Promise<WorktreeListRecord[]>;
  releasePermanentWorktreeReservation(identity: PermanentWorktreeIdentity): void;
  releaseTemporaryWorktreeReservation(identity: TemporaryWorktreeIdentity): void;
  resolveSourceRoot(workspace: string): Promise<string>;
  rollbackPermanentWorktree(identity: PermanentWorktreeIdentity): Promise<{ error?: string; rolledBack: boolean }>;
  rollbackTemporaryWorktree(identity: TemporaryWorktreeIdentity): Promise<TemporaryWorktreeRollback>;
  switchLocalBranch(workspace: string, request: LocalBranchSwitchRequest): Promise<LocalBranchSwitchResult>;
}

type CommandError = Error & { code?: string | number; stderr?: unknown };

const LOCAL_BRANCH_INVENTORY_LIMIT = 200;
const GIT_INSPECTION_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_INSPECTION_TIMEOUT_MS = 15_000;

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

function isNotGitRepositoryError(value: unknown): boolean {
  return /not a git repository/i.test(commandErrorMessage(value, ''));
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

function parseLocalBranchRefs(output: unknown): Array<{ head: string; name: string }> {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('\0');
      if (separator <= 'refs/heads/'.length) {
        throw new Error('Git returned an invalid local branch record');
      }
      const ref = line.slice(0, separator);
      const head = line.slice(separator + 1).trim();
      if (!ref.startsWith('refs/heads/') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) {
        throw new Error('Git returned an invalid local branch record');
      }
      return { name: ref.slice('refs/heads/'.length), head };
    });
}

function parseLocalBranchStatus(output: unknown): {
  currentBranch: string;
  dirtyCount: number;
  head: string;
} {
  let currentBranch = '';
  let dirtyCount = 0;
  let head = '';
  let sawBranchHead = false;
  let sawBranchOid = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      head = value === '(initial)' ? '' : value;
      if (head && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) {
        throw new Error('Git returned an invalid HEAD object id');
      }
      sawBranchOid = true;
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      currentBranch = value === '(detached)' ? '' : value;
      sawBranchHead = true;
      continue;
    }
    if (line.startsWith('# ')) continue;
    if (/^(?:1|2|u|\?|!) /.test(line)) {
      dirtyCount += 1;
      continue;
    }
    throw new Error('Git returned an invalid worktree status record');
  }
  if (!sawBranchHead || !sawBranchOid) {
    throw new Error('Git did not return authoritative branch status');
  }
  return { currentBranch, dirtyCount, head };
}

class WorktreeGitService implements WorktreeGitServicePort {
  private readonly execFile: WorktreeGitExec;
  private readonly identityNonce: () => string;
  private readonly invalidateCache: () => void;
  private readonly now: () => Date;
  private readonly pathExists: (workspace: string) => boolean | Promise<boolean>;
  private readonly permanentWorktreeReservations = new Map<string, symbol>();
  private readonly temporaryWorktreeReservations = new Map<string, symbol>();

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

  private temporaryReservationToken(identity: TemporaryWorktreeIdentity): symbol | undefined {
    return (identity as Partial<ReservedTemporaryWorktreeIdentity>)[temporaryReservationTokenProperty];
  }

  private reservedTemporaryIdentity(
    identity: TemporaryWorktreeIdentity,
    token: symbol,
  ): TemporaryWorktreeIdentity {
    const reserved = { ...identity } as ReservedTemporaryWorktreeIdentity;
    Object.defineProperty(reserved, temporaryReservationTokenProperty, { value: token });
    return reserved;
  }

  releaseTemporaryWorktreeReservation(identity: TemporaryWorktreeIdentity): void {
    const token = this.temporaryReservationToken(identity);
    if (!token) return;
    const key = this.reservationKey(identity);
    if (this.temporaryWorktreeReservations.get(key) === token) {
      this.temporaryWorktreeReservations.delete(key);
    }
  }

  async listWorktrees(sourceWorkspace: string): Promise<WorktreeListRecord[]> {
    const { stdout } = await this.execFile('git', [
      '-C', sourceWorkspace, 'worktree', 'list', '--porcelain',
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return parseGitWorktreeList(stdout);
  }

  private emptyLocalBranchInventory(workspace: string): LocalBranchInventory {
    return {
      isGitRepo: false,
      workspace: path.resolve(workspace),
      mainWorkspace: '',
      currentBranch: '',
      head: '',
      dirtyCount: 0,
      canSwitch: false,
      blockedReason: 'Workspace is not inside a Git repository',
      blockedReasonCode: 'not-git-repository',
      blockingAgentIds: [],
      items: [],
      truncated: false,
    };
  }

  async inspectLocalBranches(workspace: string): Promise<LocalBranchInventory> {
    if (!workspace) throw new Error('Workspace is empty');
    const requestedWorkspace = path.resolve(workspace);
    let canonicalRequestedWorkspace = requestedWorkspace;
    try {
      canonicalRequestedWorkspace = await fs.promises.realpath(requestedWorkspace);
    } catch (caught) {
      if (!isAbsentFilesystemError(caught)) throw caught;
    }
    let repositoryWorkspace = '';
    try {
      const { stdout } = await this.execFile('git', [
        '-C', requestedWorkspace, 'rev-parse', '--show-toplevel',
      ], { timeout: GIT_INSPECTION_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      repositoryWorkspace = path.resolve(String(stdout).trim());
    } catch (caught) {
      if (isNotGitRepositoryError(caught)) return this.emptyLocalBranchInventory(requestedWorkspace);
      throw new Error(commandErrorMessage(caught, 'Failed to inspect Git repository'), { cause: caught });
    }

    const [worktrees, branchStatusOutput, refsOutput] = await Promise.all([
      this.listWorktrees(repositoryWorkspace),
      this.execFile('git', [
        '-C', repositoryWorkspace, 'status', '--porcelain=v2', '--branch', '--untracked-files=all',
      ], { timeout: GIT_INSPECTION_TIMEOUT_MS, maxBuffer: GIT_INSPECTION_MAX_BUFFER })
        .then(result => result.stdout),
      this.execFile('git', [
        '-C', repositoryWorkspace, 'for-each-ref',
        `--count=${LOCAL_BRANCH_INVENTORY_LIMIT + 1}`,
        '--sort=refname',
        '--format=%(refname)%00%(objectname)',
        'refs/heads',
      ], { timeout: GIT_INSPECTION_TIMEOUT_MS, maxBuffer: GIT_INSPECTION_MAX_BUFFER })
        .then(result => result.stdout),
    ]);

    const { currentBranch, dirtyCount, head } = parseLocalBranchStatus(branchStatusOutput);
    const mainWorkspace = worktrees[0]?.workspace || '';
    const checkedOutByBranch = new Map(
      worktrees.filter(item => item.branch).map(item => [item.branch, item.workspace]),
    );
    const refs = parseLocalBranchRefs(refsOutput);
    const truncated = refs.length > LOCAL_BRANCH_INVENTORY_LIMIT;
    const visibleRefs = refs.slice(0, LOCAL_BRANCH_INVENTORY_LIMIT);
    if (
      currentBranch
      && head
      && !visibleRefs.some(item => item.name === currentBranch)
    ) {
      visibleRefs.splice(Math.max(0, LOCAL_BRANCH_INVENTORY_LIMIT - 1), 1, {
        name: currentBranch,
        head,
      });
    }
    const items = visibleRefs.map(item => ({
      ...item,
      current: item.name === currentBranch,
      checkedOutWorkspace: checkedOutByBranch.get(item.name) || '',
    }));
    let blockedReason = '';
    let blockedReasonCode: LocalBranchBlockedReasonCode = '';
    if (
      canonicalRequestedWorkspace !== repositoryWorkspace
      || !mainWorkspace
      || repositoryWorkspace !== mainWorkspace
    ) {
      blockedReason = 'Branches can only be switched in the repository main worktree';
      blockedReasonCode = 'not-main-worktree';
    } else if (dirtyCount > 0) {
      blockedReason = `Workspace has ${dirtyCount} uncommitted or untracked change${dirtyCount === 1 ? '' : 's'}`;
      blockedReasonCode = 'dirty-worktree';
    } else if (!items.some(item => !item.current && !item.checkedOutWorkspace)) {
      blockedReason = truncated
        ? 'No switchable branch is available in the bounded branch inventory'
        : 'No other local branch is available';
      blockedReasonCode = 'no-switchable-branch';
    }
    return {
      isGitRepo: true,
      workspace: repositoryWorkspace,
      mainWorkspace,
      currentBranch,
      head,
      dirtyCount,
      canSwitch: !blockedReason,
      blockedReason,
      blockedReasonCode,
      blockingAgentIds: [],
      items,
      truncated,
    };
  }

  async switchLocalBranch(
    workspace: string,
    request: LocalBranchSwitchRequest,
  ): Promise<LocalBranchSwitchResult> {
    const branch = String(request.branch || '').trim();
    const before = await this.inspectLocalBranches(workspace);
    const rejected = (error: string): LocalBranchSwitchResult => ({
      inventory: before,
      switched: false,
      uncertain: false,
      error,
    });
    if (!before.isGitRepo) return rejected(before.blockedReason);
    if (before.workspace !== before.mainWorkspace) {
      return rejected('Branches can only be switched in the repository main worktree');
    }
    if (before.currentBranch !== request.expectedBranch || before.head !== request.expectedHead) {
      return rejected('Branch state changed; refresh the branch list and try again');
    }
    if (!before.canSwitch) return rejected(before.blockedReason);
    const target = before.items.find(item => item.name === branch);
    if (!target) return rejected(`Local branch does not exist in the current inventory: ${branch}`);
    if (target.current) return rejected(`Branch is already checked out: ${branch}`);
    if (target.checkedOutWorkspace && target.checkedOutWorkspace !== before.workspace) {
      return rejected(`Branch is already checked out in another worktree: ${target.checkedOutWorkspace}`);
    }

    let commandFailure: WorktreeCommandFailure | null = null;
    try {
      await this.execFile('git', [
        '-C', before.workspace, 'switch', '--no-guess', '--', branch,
      ], { timeout: 60_000, maxBuffer: GIT_INSPECTION_MAX_BUFFER });
    } catch (caught) {
      commandFailure = {
        cause: caught,
        message: commandErrorMessage(caught, `Failed to switch to branch ${branch}`),
      };
    } finally {
      try {
        this.invalidateCache();
      } catch {
        // The authoritative reconciliation below does not depend on the cache.
      }
    }

    let after: LocalBranchInventory;
    try {
      after = await this.inspectLocalBranches(before.workspace);
    } catch (caught) {
      return {
        switched: false,
        uncertain: true,
        previousBranch: before.currentBranch,
        previousHead: before.head,
        error: `${commandFailure?.message || 'Branch switch completed without a verifiable result'}; fresh Git state could not be inspected: ${commandErrorMessage(caught, 'unknown inspection error')}`,
      };
    }
    const afterTarget = after.items.find(item => item.name === branch);
    if (after.currentBranch === branch && after.head && afterTarget?.head === after.head) {
      return {
        inventory: after,
        switched: true,
        uncertain: false,
        previousBranch: before.currentBranch,
        previousHead: before.head,
      };
    }
    if (
      commandFailure
      && after.currentBranch === before.currentBranch
      && after.head === before.head
      && after.dirtyCount === 0
    ) {
      return {
        inventory: after,
        switched: false,
        uncertain: false,
        previousBranch: before.currentBranch,
        previousHead: before.head,
        error: commandFailure.message,
      };
    }
    return {
      inventory: after,
      switched: false,
      uncertain: true,
      previousBranch: before.currentBranch,
      previousHead: before.head,
      error: commandFailure?.message || `Git did not establish branch ${branch}`,
    };
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

  async allocateTemporaryWorktree(sourceWorkspace: string): Promise<TemporaryWorktreeIdentity> {
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
      const token = Symbol(key);
      this.temporaryWorktreeReservations.set(key, token);
      return this.reservedTemporaryIdentity(identity, token);
    }
    throw new Error('Unable to allocate a temporary worktree name');
  }

  async createTemporaryWorktree(identity: TemporaryWorktreeIdentity): Promise<TemporaryWorktreeMutation> {
    const reservationKey = this.reservationKey(identity);
    const reservationToken = this.temporaryReservationToken(identity);
    if (!reservationToken || this.temporaryWorktreeReservations.get(reservationKey) !== reservationToken) {
      throw new Error('Temporary worktree reservation is no longer active');
    }
    const sourceWorkspace = identity.sourceWorkspace;
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
      if (this.temporaryWorktreeReservations.get(reservationKey) === reservationToken) {
        this.temporaryWorktreeReservations.delete(reservationKey);
      }
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
      const [canonicalTopLevel, canonicalWorkspace] = await Promise.all([
        fs.promises.realpath(path.resolve(String(topLevelOutput).trim())),
        fs.promises.realpath(resolvedWorkspace),
      ]);
      if (canonicalTopLevel !== canonicalWorkspace) {
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

  async rollbackTemporaryWorktree(
    identity: TemporaryWorktreeIdentity,
  ): Promise<TemporaryWorktreeRollback> {
    const sourceWorkspace = path.resolve(String(identity.sourceWorkspace || ''));
    const workspace = path.resolve(String(identity.workspace || ''));
    const retained = (error: string): TemporaryWorktreeRollback => ({
      rolledBack: false,
      error,
      retainedWorkspace: workspace,
      uncertain: true,
    });
    try {
      const postcondition = await this.inspectPostcondition(sourceWorkspace, workspace);
      if (postcondition.proven && !postcondition.exists && !postcondition.registered) {
        return { rolledBack: true };
      }

      const inspection = await this.inspectForkWorktree(workspace);
      if (inspection.error) return retained(inspection.error);
      const [
        canonicalExpectedSource,
        canonicalInspectedSource,
        canonicalExpectedWorkspace,
        canonicalInspectedWorkspace,
      ] = await Promise.all([
        fs.promises.realpath(sourceWorkspace),
        fs.promises.realpath(inspection.sourceWorkspace),
        fs.promises.realpath(workspace),
        fs.promises.realpath(inspection.workspace),
      ]);
      if (
        canonicalExpectedSource !== canonicalInspectedSource
        || canonicalExpectedWorkspace !== canonicalInspectedWorkspace
      ) {
        return retained('Temporary Fork worktree identity does not match the inspected Git worktree');
      }
      if (inspection.requiresForce) {
        return retained('Temporary Fork worktree contains uncommitted changes');
      }

      const mutation = await this.deleteWorktree({
        sourceWorkspace: canonicalExpectedSource,
        workspace: canonicalExpectedWorkspace,
      }, false);
      if (
        mutation.postcondition.proven
        && !mutation.postcondition.exists
        && !mutation.postcondition.registered
      ) {
        return { rolledBack: true };
      }
      return retained(
        mutation.commandFailure?.message
          || mutation.postcondition.error
          || 'Temporary Fork worktree rollback could not be proven',
      );
    } catch (caught) {
      return retained(commandErrorMessage(caught, 'Temporary Fork worktree rollback could not be proven'));
    }
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
  LOCAL_BRANCH_INVENTORY_LIMIT,
  WorktreeGitService,
  isFarmingForkWorktreePath,
  parseGitWorktreeList,
  parseLocalBranchRefs,
  parseLocalBranchStatus,
  statusEntriesFromPorcelain,
  type ForkWorktreeInspection,
  type LocalBranchInventory,
  type LocalBranchBlockedReasonCode,
  type LocalBranchItem,
  type LocalBranchSwitchRequest,
  type LocalBranchSwitchResult,
  type PermanentWorktreeIdentity,
  type PermanentWorktreeMutation,
  type TemporaryWorktreeIdentity,
  type TemporaryWorktreeMutation,
  type TemporaryWorktreeRollback,
  type WorktreeGitExec,
  type WorktreeCommandFailure,
  type WorktreeGitServiceOptions,
  type WorktreeGitServicePort,
  type WorktreeListRecord,
  type WorktreeDeleteMutation,
  type WorktreePostcondition,
};
