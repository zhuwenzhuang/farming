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
        const inspectedWorkspace = await ports.inspectWorkspace(candidate);
        if (inspectedWorkspace) return inspectedWorkspace;
      } catch (error) {
        ports.warnInspectFailure(candidate, error);
      }
      try {
        return await ports.realpath(candidate);
      } catch {
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

export { createProjectWorkspaceCanonicalizer };
