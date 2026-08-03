import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_IMAGE_ARTIFACT_BYTES = 32 * 1024 * 1024;

interface WorkspaceArtifact {
  kind: 'image';
  path: string;
  mimeType: string;
  size: number;
}

interface WriteWorkspaceImageOptions {
  bytes: Buffer;
  capability: 'browser' | 'computer';
  mimeType?: string;
  operation: string;
  workspace: string;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeNamePart(value: unknown, fallback: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/png') return '.png';
  throw new Error(`Unsupported Workspace image artifact MIME type: ${mimeType}`);
}

async function ensurePrivateDirectory(
  parentReal: string,
  name: string,
  workspaceReal: string,
): Promise<string> {
  const candidate = path.join(parentReal, name);
  try {
    await fs.promises.mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
  const stat = await fs.promises.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Workspace artifact path contains a symlink or non-directory component');
  }
  const resolved = await fs.promises.realpath(candidate);
  if (!pathInside(workspaceReal, resolved)) {
    throw new Error('Workspace artifact directory resolves outside the Project workspace');
  }
  return resolved;
}

async function writeWorkspaceImageArtifact(
  options: WriteWorkspaceImageOptions,
): Promise<WorkspaceArtifact> {
  const workspace = path.resolve(String(options.workspace || '').trim());
  if (!String(options.workspace || '').trim()) {
    throw new Error('Workspace image artifact requires an exact Project workspace');
  }
  const bytes = Buffer.isBuffer(options.bytes) ? options.bytes : Buffer.from(options.bytes);
  if (bytes.length === 0) throw new Error('Workspace image artifact is empty');
  if (bytes.length > MAX_IMAGE_ARTIFACT_BYTES) {
    throw new Error(`Workspace image artifact exceeds ${MAX_IMAGE_ARTIFACT_BYTES} bytes`);
  }

  const workspaceReal = await fs.promises.realpath(workspace);
  const capability = safeNamePart(options.capability, 'capability');
  const temporaryDirectory = await ensurePrivateDirectory(workspaceReal, '.tmp', workspaceReal);
  const farmingDirectory = await ensurePrivateDirectory(temporaryDirectory, 'farming', workspaceReal);
  const directoryReal = await ensurePrivateDirectory(farmingDirectory, capability, workspaceReal);

  const mimeType = String(options.mimeType || 'image/png').toLowerCase();
  const operation = safeNamePart(options.operation, 'capture');
  const filename = `${operation}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${extensionForMimeType(mimeType)}`;
  const absolutePath = path.join(directoryReal, filename);
  try {
    await fs.promises.writeFile(absolutePath, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.promises.rm(absolutePath, { force: true }).catch(() => {});
    throw error;
  }
  const relativePath = path.relative(workspaceReal, absolutePath).split(path.sep).join('/');
  return {
    kind: 'image',
    path: relativePath,
    mimeType,
    size: bytes.length,
  };
}

export {
  MAX_IMAGE_ARTIFACT_BYTES,
  pathInside,
  writeWorkspaceImageArtifact,
  type WorkspaceArtifact,
};
