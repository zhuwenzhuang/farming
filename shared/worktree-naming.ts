/** Shared display/allocation suffix; Git name validation remains backend-owned. */
export function worktreeDirectorySuffix(branch: string): string {
  return branch.replace(/\//g, '-');
}
