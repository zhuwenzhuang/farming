#!/usr/bin/env -S npx tsx
/**
 * Fail when a verification run left the working tree dirty or dropped known test
 * garbage beside the sources.
 *
 * Tests own the cleanup of every directory, socket, process, and fixture they
 * create, including on failure and cancellation paths. Widening .gitignore until
 * the leftovers disappear from `git status` normalizes the cleanup failure
 * instead of fixing it, so this gate names the exact leftovers it refuses to
 * accept and reports them by their real paths.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A leftover this gate refuses to accept, with the reason it is never legitimate. */
export interface WorkspaceLeftover {
  path: string;
  reason: string;
}

/**
 * Repo-root entries that no build, test, or tool may leave behind.
 *
 * `~` is only ever created by a child process that received an unexpanded `~`
 * path and resolved it relative to its working directory. `fa-*` directories are
 * Agent fork worktrees, which their owning operation must remove.
 */
export function findKnownLeftovers(rootEntries: readonly string[]): WorkspaceLeftover[] {
  const leftovers: WorkspaceLeftover[] = [];
  for (const entry of rootEntries) {
    if (entry === '~') {
      leftovers.push({
        path: entry,
        reason: 'a literal "~" directory means a child process resolved an unexpanded home path against its working directory',
      });
      continue;
    }
    if (/^fa-[0-9a-z]/.test(entry)) {
      leftovers.push({
        path: entry,
        reason: 'an Agent fork worktree outlived the operation that created it',
      });
    }
  }
  return leftovers;
}

/** Parses `git status --porcelain` into the paths it reports as not clean. */
export function parseDirtyPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .map(line => line.slice(3));
}

function main(): void {
  const projectRoot = path.resolve(__dirname, '..');
  const failures: string[] = [];

  const porcelain = execFileSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const dirtyPaths = parseDirtyPaths(porcelain);
  if (dirtyPaths.length > 0) {
    failures.push(
      'The working tree is not clean. A verification run must not modify tracked files:',
      ...dirtyPaths.map(dirtyPath => `  ${dirtyPath}`),
    );
  }

  const leftovers = findKnownLeftovers(fs.readdirSync(projectRoot));
  if (leftovers.length > 0) {
    failures.push(
      'Known test garbage is present in the repository root:',
      ...leftovers.map(leftover => `  ${leftover.path} — ${leftover.reason}`),
    );
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('Workspace is clean: no tracked modifications and no known leftovers.');
}

if (require.main === module) main();
