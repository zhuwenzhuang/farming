const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
import { resolveWorkspacePath } from './client-services.cjs';

const fsp = fs.promises;

class AcpPatchDecisionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'AcpPatchDecisionError';
    this.statusCode = statusCode;
  }
}

interface PatchDecisionRequest {
  entry: unknown;
  root: string;
  requestedPath: unknown;
}

interface PatchDecisionResult {
  action: 'reverted';
  path: string;
}

type ExistingTarget = {
  exists: false;
  logical: string;
  target: null;
  stat: null;
} | {
  exists: true;
  logical: string;
  target: string;
  stat: import('fs').Stats;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fileSystemErrorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function logicalPatchPath(root: string, requestedPath: unknown): string {
  const workspace = path.resolve(root);
  let realWorkspace = workspace;
  try {
    realWorkspace = fs.realpathSync.native(workspace);
  } catch {
    // The caller will report the missing workspace through the normal file operation.
  }
  const value = String(requestedPath || '').trim();
  if (!value || value.includes('\0')) throw new AcpPatchDecisionError('ACP patch path is invalid', 400);
  const target = path.resolve(path.isAbsolute(value) ? value : path.join(workspace, value));
  if (!inside(workspace, target) && !inside(realWorkspace, target)) {
    throw new AcpPatchDecisionError('ACP patch is outside the Agent workspace', 403);
  }
  return target;
}

function relativeWorkspacePath(root: string, target: string): string {
  const workspace = path.resolve(root);
  let realWorkspace = workspace;
  try {
    realWorkspace = fs.realpathSync.native(workspace);
  } catch {
    // Fall through to the logical root.
  }
  const base = inside(workspace, target) ? workspace : realWorkspace;
  return path.relative(base, target);
}

function matchingDiffBlocks(
  entry: unknown,
  root: string,
  requestedPath: unknown,
): Array<Record<string, unknown>> {
  const requested = logicalPatchPath(root, requestedPath);
  const content = recordValue(entry).content;
  return (Array.isArray(content) ? content : []).filter(
    (block): block is Record<string, unknown> => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type !== 'diff' || typeof blockRecord.path !== 'string') return false;
    try {
      return logicalPatchPath(root, blockRecord.path) === requested;
    } catch {
      return false;
    }
  });
}

function patchBlock(entry: unknown, root: string, requestedPath: unknown): Record<string, unknown> {
  const matches = matchingDiffBlocks(entry, root, requestedPath);
  if (matches.length === 0) throw new AcpPatchDecisionError('ACP patch file was not found', 404);
  if (matches.length > 1) throw new AcpPatchDecisionError('ACP patch file has multiple changes; open Review to resolve them', 409);
  return matches[0];
}

function patchKind(block: Record<string, unknown>): string {
  return String(recordValue(block._meta).kind || '').trim().toLowerCase();
}

async function existingTarget(root: string, requestedPath: unknown): Promise<ExistingTarget> {
  const logical = logicalPatchPath(root, requestedPath);
  let stat;
  try {
    stat = await fsp.lstat(logical);
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') {
      return { exists: false, logical, target: null, stat: null };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new AcpPatchDecisionError('ACP patch decision will not modify a symbolic link', 409);
  if (!stat.isFile()) throw new AcpPatchDecisionError('ACP patch target is not a regular file', 409);
  const target = await resolveWorkspacePath({ cwd: root }, logical);
  return { exists: true, logical, target, stat };
}

async function missingTarget(
  root: string,
  requestedPath: unknown,
): Promise<{ logical: string; target: string }> {
  const logical = logicalPatchPath(root, requestedPath);
  const target = await resolveWorkspacePath({ cwd: root }, logical, { allowMissing: true });
  return { logical, target };
}

async function atomicWrite(target: string, content: string, mode = 0o666): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.farming-acp-revert-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fsp.writeFile(temporary, content, { mode });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function rejectPatch({
  entry,
  root,
  requestedPath,
}: PatchDecisionRequest): Promise<PatchDecisionResult> {
  const block = patchBlock(entry, root, requestedPath);
  const oldText = block.oldText == null ? '' : String(block.oldText);
  const newText = block.newText == null ? '' : String(block.newText);
  const kind = patchKind(block);
  const added = block.oldText == null || ['add', 'added', 'create', 'created'].includes(kind);
  const deleted = ['delete', 'deleted', 'remove', 'removed'].includes(kind);
  const current = await existingTarget(root, requestedPath);

  if (deleted) {
    if (current.exists) {
      const currentText = await fsp.readFile(current.target, 'utf8');
      if (currentText === oldText) {
        return { action: 'reverted', path: relativeWorkspacePath(root, current.logical) };
      }
      throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);
    }
    const target = await missingTarget(root, requestedPath);
    await atomicWrite(target.target, oldText);
    return { action: 'reverted', path: relativeWorkspacePath(root, target.logical) };
  }

  if (!current.exists) {
    if (added) return { action: 'reverted', path: relativeWorkspacePath(root, current.logical) };
    throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);
  }
  const currentText = await fsp.readFile(current.target, 'utf8');
  if (!added && currentText === oldText) {
    return { action: 'reverted', path: relativeWorkspacePath(root, current.logical) };
  }
  if (currentText !== newText) throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);

  if (added) {
    await fsp.rm(current.target);
  } else {
    await atomicWrite(current.target, oldText, current.stat.mode);
  }
  return { action: 'reverted', path: relativeWorkspacePath(root, current.logical) };
}

export {
  AcpPatchDecisionError,
  logicalPatchPath,
  patchBlock,
  rejectPatch,
};
