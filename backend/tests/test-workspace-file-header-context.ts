import assert from 'node:assert/strict'
import { workspaceFileHeaderDirectory, workspaceFileHeaderLabel, workspaceFileHeaderParents } from '../../src/lib/workspace-file-header-context'
import type { WorkspaceFileTreeNode } from '../../src/lib/workspace-file-tree'

const tree: WorkspaceFileTreeNode[] = [
  { id: 'src/components', path: 'src/components', name: 'components', type: 'directory', size: 0, mtimeMs: 0,
    compactedPaths: ['src', 'src/components'], children: [
      { id: 'src/components/files', path: 'src/components/files', name: 'files', type: 'directory', size: 0, mtimeMs: 0,
        children: [{ id: 'src/components/files/a.ts', path: 'src/components/files/a.ts', name: 'a.ts', type: 'file', size: 0, mtimeMs: 0 }] },
      { id: 'src/components/z.ts', path: 'src/components/z.ts', name: 'z.ts', type: 'file', size: 0, mtimeMs: 0 },
    ] },
  { id: 'tools', path: 'tools', name: 'tools', type: 'directory', size: 0, mtimeMs: 0 },
]
const parents = workspaceFileHeaderParents(tree, new Set(['src/components', 'src/components/files']))
assert.deepEqual(parents, ['', 'src/components', 'src/components/files', 'src/components', ''])
// Partially visible source directory is never duplicated; its own parent wins.
assert.equal(workspaceFileHeaderDirectory(parents, 0, 23.9, 200, 24), '')
assert.equal(workspaceFileHeaderDirectory(parents, 0, 24, 200, 24), 'src/components')
assert.equal(workspaceFileHeaderDirectory(parents, 0, 47.9, 200, 24), 'src/components')
assert.equal(workspaceFileHeaderDirectory(parents, 0, 48, 200, 24), 'src/components/files')
assert.equal(workspaceFileHeaderDirectory(parents, 0, 96, 200, 24), '')
assert.equal(workspaceFileHeaderDirectory(parents, -200, 24, 200, 24), '')
assert.equal(workspaceFileHeaderDirectory(parents, 250, 24, 200, 24), '')
assert.equal(workspaceFileHeaderDirectory(parents, 0, 48, 48, 24), '')
assert.deepEqual(workspaceFileHeaderParents(tree, new Set()), ['', ''])
assert.deepEqual(workspaceFileHeaderParents(tree, new Set(['src/components'])), ['', 'src/components', 'src/components', ''])
const measure = (text: string) => text.length
assert.equal(workspaceFileHeaderLabel('src/components/files', 100, measure), 'src / components / files')
assert.equal(workspaceFileHeaderLabel('src/components/files', 22, measure), '… / components / files')
assert.equal(workspaceFileHeaderLabel('src/components/files', 12, measure), '… / files')
assert.equal(workspaceFileHeaderLabel('src/components/files', 1, measure), '… / files')
assert.equal(workspaceFileHeaderLabel('目录/很长的目录/文件', 8, measure), '… / 文件')
assert.equal(workspaceFileHeaderLabel('long-parent-name', 1, measure), 'long-parent-name')
console.log('✓ Files header context respects visible ancestors, compact chains and width budgets')
