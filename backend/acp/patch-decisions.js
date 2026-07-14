const fs = require('fs');
const path = require('path');
const { resolveWorkspacePath } = require('./client-services');

const fsp = fs.promises;

class AcpPatchDecisionError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'AcpPatchDecisionError';
    this.statusCode = statusCode;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function logicalPatchPath(root, requestedPath) {
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

function relativeWorkspacePath(root, target) {
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

function matchingDiffBlocks(entry, root, requestedPath) {
  const requested = logicalPatchPath(root, requestedPath);
  return (Array.isArray(entry?.content) ? entry.content : []).filter(block => {
    if (block?.type !== 'diff' || typeof block.path !== 'string') return false;
    try {
      return logicalPatchPath(root, block.path) === requested;
    } catch {
      return false;
    }
  });
}

function patchBlock(entry, root, requestedPath) {
  const matches = matchingDiffBlocks(entry, root, requestedPath);
  if (matches.length === 0) throw new AcpPatchDecisionError('ACP patch file was not found', 404);
  if (matches.length > 1) throw new AcpPatchDecisionError('ACP patch file has multiple changes; open Review to resolve them', 409);
  return matches[0];
}

function patchKind(block) {
  return String(block?._meta?.kind || '').trim().toLowerCase();
}

async function existingTarget(root, requestedPath) {
  const logical = logicalPatchPath(root, requestedPath);
  let stat;
  try {
    stat = await fsp.lstat(logical);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, logical, target: null, stat: null };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new AcpPatchDecisionError('ACP patch decision will not modify a symbolic link', 409);
  if (!stat.isFile()) throw new AcpPatchDecisionError('ACP patch target is not a regular file', 409);
  const target = await resolveWorkspacePath({ cwd: root }, logical);
  return { exists: true, logical, target, stat };
}

async function missingTarget(root, requestedPath) {
  const logical = logicalPatchPath(root, requestedPath);
  const target = await resolveWorkspacePath({ cwd: root }, logical, { allowMissing: true });
  return { logical, target };
}

async function atomicWrite(target, content, mode = 0o666) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.farming-acp-revert-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.writeFile(temporary, content, { mode });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function rejectPatch({ entry, root, requestedPath }) {
  const block = patchBlock(entry, root, requestedPath);
  const oldText = block.oldText == null ? '' : String(block.oldText);
  const newText = block.newText == null ? '' : String(block.newText);
  const kind = patchKind(block);
  const added = block.oldText == null || ['add', 'added', 'create', 'created'].includes(kind);
  const deleted = ['delete', 'deleted', 'remove', 'removed'].includes(kind);
  const current = await existingTarget(root, requestedPath);

  if (deleted) {
    if (current.exists) throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);
    const target = await missingTarget(root, requestedPath);
    await atomicWrite(target.target, oldText);
    return { action: 'reverted', path: relativeWorkspacePath(root, target.logical) };
  }

  if (!current.exists) throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);
  const currentText = await fsp.readFile(current.target, 'utf8');
  if (currentText !== newText) throw new AcpPatchDecisionError('File changed after this ACP patch; it was not reverted', 409);

  if (added) {
    await fsp.rm(current.target);
  } else {
    await atomicWrite(current.target, oldText, current.stat.mode);
  }
  return { action: 'reverted', path: relativeWorkspacePath(root, current.logical) };
}

module.exports = {
  AcpPatchDecisionError,
  logicalPatchPath,
  patchBlock,
  rejectPatch,
};
