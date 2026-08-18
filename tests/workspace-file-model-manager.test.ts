import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceFileModelManager,
  type WorkspaceFileReader,
} from '../src/lib/workspace-file-model-manager'
import type { WorkspaceFile } from '../src/lib/workspace-files'
import {
  openWorkspaceFileFromRead,
  selectWorkspaceOpenFile,
  type WorkspaceOpenFilesState,
} from '../src/lib/workspace-open-files'

function workspaceFile(path: string, content = `${path}\n`): WorkspaceFile {
  return {
    path,
    content,
    size: content.length,
    mtimeMs: 1,
    sha1: `sha1-${path}`,
  }
}

test('watch readiness revalidates retained reads but not fresh authoritative reads', async () => {
  let reads = 0
  const readFile: WorkspaceFileReader = async (_rootId, filePath) => {
    reads += 1
    return workspaceFile(filePath)
  }
  const manager = new WorkspaceFileModelManager({ readFile })
  const options = { workspaceRoot: '/repo' }

  await manager.resolve('root', 'one.txt', options)
  assert.equal(reads, 1)
  assert.equal(manager.consumeWatchReadyRevalidation('root', 'one.txt', options), false)

  await manager.resolve('root', 'one.txt', options)
  assert.equal(reads, 1)
  assert.equal(manager.consumeWatchReadyRevalidation('root', 'one.txt', options), true)
  assert.equal(manager.consumeWatchReadyRevalidation('root', 'one.txt', options), false)

  await manager.resolve('root', 'one.txt', { ...options, reload: true })
  assert.equal(reads, 2)
  assert.equal(manager.consumeWatchReadyRevalidation('root', 'one.txt', options), false)
  manager.dispose()
})

test('unwatchable retained entries keep the authoritative reopen path', async () => {
  let reads = 0
  const readFile: WorkspaceFileReader = async (_rootId, filePath) => {
    reads += 1
    return { ...workspaceFile(filePath), external: true }
  }
  const manager = new WorkspaceFileModelManager({ readFile })

  await manager.resolve('root', 'external.txt')
  await manager.resolve('root', 'external.txt')

  assert.equal(reads, 2)
  assert.equal(manager.consumeWatchReadyRevalidation('root', 'external.txt'), false)
  manager.dispose()
})

test('retained models do not cross workspace access owners for the same physical file', async () => {
  let reads = 0
  const manager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      reads += 1
      return workspaceFile(filePath)
    },
  })

  await manager.resolve('parent-root', 'nested/file.txt', { workspaceRoot: '/repo' })
  await manager.resolve('nested-root', 'file.txt', { workspaceRoot: '/repo/nested' })

  assert.equal(reads, 2)
  manager.dispose()
})

test('an open tab cannot bypass a read when its workspace access owner changes', () => {
  const emptyState: WorkspaceOpenFilesState = {
    activeFile: null,
    files: [],
    closedFileCache: new Map(),
  }
  const globalState = openWorkspaceFileFromRead(
    emptyState,
    'wroot_global',
    workspaceFile('repo/file.txt'),
    { workspaceRoot: '/', exactExternal: true },
  )

  assert.equal(selectWorkspaceOpenFile(
    globalState,
    'project-root',
    'file.txt',
    { workspaceRoot: '/repo', exactExternal: false },
  ), null)
  assert.ok(selectWorkspaceOpenFile(
    globalState,
    'wroot_global',
    'repo/file.txt',
    { workspaceRoot: '/', exactExternal: true },
  ))
})
