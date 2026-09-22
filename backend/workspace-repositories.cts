import * as path from 'path';
import * as fs from 'fs/promises';
import { isSameOrDescendantPath } from './path-containment.cjs';

interface GitReader {
  gitPath: string;
  execFile(command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }): Promise<{ stdout: unknown }>;
}
export interface WorkspaceRepository {
  path: string;
  root: string;
  error?: string;
}

async function git(reader: GitReader, root: string, args: string[]): Promise<string> {
  const result = await reader.execFile(reader.gitPath, args, { cwd: root, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout);
}

// An uninitialized child must never resolve to its containing parent repository.
export async function exactChildRepository(reader: GitReader, parent: string, childPath: string): Promise<string> {
  if (!childPath || childPath.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(childPath)) {
    throw new Error('Invalid submodule path');
  }
  const root = await fs.realpath(path.join(parent, childPath));
  if (!isSameOrDescendantPath(parent, root) || root === parent) throw new Error('Submodule is outside the project');
  const top = (await git(reader, root, ['rev-parse', '--show-toplevel'])).trim();
  if (await fs.realpath(top) !== root) throw new Error('Submodule is not initialized');
  return root;
}

export async function discoverWorkspaceRepositories(reader: GitReader, root: string): Promise<WorkspaceRepository[]> {
  const repositories: WorkspaceRepository[] = [{ path: '', root }];
  const seen = new Set([root]);
  const depths = new Map([[root, 0]]);
  for (let cursor = 0; cursor < repositories.length; cursor++) {
    const parent = repositories[cursor];
    if (parent.error) continue;
    let output: string;
    try {
      const manifest = await git(reader, parent.root, ['ls-files', '--stage', '-z', '--', '.gitmodules']);
      const manifestId = /^100[0-7]{3} ([a-f0-9]+) 0\t\.gitmodules\0$/.exec(manifest)?.[1];
      if (!manifestId) continue;
      let config: string;
      try {
        config = await git(reader, parent.root, ['config', '-z', `--blob=${manifestId}`, '--get-regexp', '^submodule\\..*\\.path$']);
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) continue;
        throw error;
      }
      const configuredPaths = config.split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\n') + 1));
      if (configuredPaths.length > 31) throw new Error('Too many submodules; open a submodule as its own project');
      if (configuredPaths.some(value => !value || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Invalid submodule path in .gitmodules');
      if (!configuredPaths.length) continue;
      output = await git(reader, parent.root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...configuredPaths]);
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr || '');
      if (cursor === 0 && /not a git repository/i.test(stderr)) return repositories;
      throw error;
    }
    const paths = new Set(output.split('\0').flatMap(record => {
      const match = /^160000 [a-f0-9]+ 0\t(.+)$/s.exec(record);
      return match ? [match[1]] : [];
    }));
    for (const childPath of paths) {
      if (repositories.length >= 32) throw new Error('Too many nested repositories; open a submodule as its own project');
      const relativePath = parent.path ? `${parent.path}/${childPath}` : childPath;
      const depth = (depths.get(parent.root) || 0) + 1;
      if (depth > 8) throw new Error('Submodule nesting exceeds 8 levels');
      try {
        const childRoot = await exactChildRepository(reader, parent.root, childPath);
        if (seen.has(childRoot)) throw new Error('Repeated submodule repository');
        seen.add(childRoot);
        depths.set(childRoot, depth);
        repositories.push({ path: relativePath, root: childRoot });
      } catch (error) {
        repositories.push({ path: relativePath, root: path.join(parent.root, childPath), error: error instanceof Error ? error.message : 'Submodule unavailable' });
      }
    }
  }
  return repositories;
}

export async function repositoryForFile(reader: GitReader, root: string, filePath: string): Promise<{ root: string; path: string }> {
  let directory = path.dirname(path.join(root, filePath));
  for (let depth = 0; directory !== root; depth++) {
    if (!isSameOrDescendantPath(root, directory)) throw new Error('File is outside the project');
    if (depth >= 64) throw new Error('Repository discovery exceeds the directory depth limit');
    let hasGitMarker = false;
    try {
      await fs.lstat(path.join(directory, '.git'));
      hasGitMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    }
    if (hasGitMarker) {
      const childPath = path.relative(root, directory).split(path.sep).join('/');
      const childRoot = await exactChildRepository(reader, root, childPath);
      return { root: childRoot, path: path.relative(directory, path.join(root, filePath)).split(path.sep).join('/') };
    }
    directory = path.dirname(directory);
  }
  return { root, path: filePath };
}
