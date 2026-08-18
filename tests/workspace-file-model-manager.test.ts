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

test('concurrent watch and explicit reloads share one in-flight transport read', async () => {
  let reads = 0
  let releaseReload: (() => void) | null = null
  const reloadGate = new Promise<void>(resolve => { releaseReload = resolve })
  const manager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      reads += 1
      if (reads > 1) await reloadGate
      return workspaceFile(filePath, `read ${reads}\n`)
    },
  })
  const options = { reload: true, workspaceRoot: '/repo' }

  await manager.resolve('root', 'one.txt', { workspaceRoot: '/repo' })
  const watchRefresh = manager.resolve('root', 'one.txt', options)
  const explicitReload = manager.resolve('root', 'one.txt', options)
  assert.equal(reads, 2)
  releaseReload!()
  await Promise.all([watchRefresh, explicitReload])
  assert.equal(reads, 2)
  manager.dispose()
})

test('concurrent reloads keep identical relative paths isolated by workspace root', async () => {
  let reads = 0
  let releaseReads: (() => void) | null = null
  const readGate = new Promise<void>(resolve => { releaseReads = resolve })
  const manager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      reads += 1
      await readGate
      return workspaceFile(filePath)
    },
  })

  const first = manager.resolve('root', 'same.txt', { reload: true, workspaceRoot: '/one' })
  const second = manager.resolve('root', 'same.txt', { reload: true, workspaceRoot: '/two' })
  assert.equal(reads, 2)
  releaseReads!()
  await Promise.all([first, second])
  assert.equal(reads, 2)
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

test('a watch event invalidates one retained model without discarding siblings', async () => {
  const reads = new Map<string, number>()
  const manager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      reads.set(filePath, (reads.get(filePath) ?? 0) + 1)
      return workspaceFile(filePath)
    },
  })

  await manager.resolve('root', 'one.txt')
  await manager.resolve('root', 'two.txt')
  manager.invalidateFile('root', 'one.txt')
  await manager.resolve('root', 'one.txt')
  await manager.resolve('root', 'two.txt')

  assert.equal(reads.get('one.txt'), 2)
  assert.equal(reads.get('two.txt'), 1)
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
