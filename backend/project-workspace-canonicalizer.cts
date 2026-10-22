import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function normalizeWorkspacePath(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function canonicalWorkspacePath(value: unknown): string {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return '';
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

interface ProjectWorkspaceCanonicalizerPorts {
  inspectWorkspace(candidate: string): Promise<string>;
  realpath(candidate: string): Promise<string>;
  warnInspectFailure(candidate: string, error: unknown): void;
}

function createProjectWorkspaceCanonicalizer(ports: ProjectWorkspaceCanonicalizerPorts) {
  const pending = new Map<string, Promise<string>>();

  return async function canonicalProjectWorkspaceCandidate(candidate: string): Promise<string> {
    if (!candidate) return '';
    const existing = pending.get(candidate);
    if (existing) return existing;

    const resolution = (async () => {
      try {
        return await ports.realpath(candidate);
      } catch {
        try {
          const inspectedWorkspace = await ports.inspectWorkspace(candidate);
          if (inspectedWorkspace) return inspectedWorkspace;
        } catch (error) {
          ports.warnInspectFailure(candidate, error);
        }
        return candidate;
      }
    })();
    pending.set(candidate, resolution);
    try {
      return await resolution;
    } finally {
      if (pending.get(candidate) === resolution) pending.delete(candidate);
    }
  };
}

export { canonicalWorkspacePath, normalizeWorkspacePath, createProjectWorkspaceCanonicalizer };
