import assert from 'node:assert/strict'
import test from 'node:test'
import { pathQueryForWorkspace } from '../src/components/code/useGlobalWorkspaceFileSearch'
import { parseWorkspaceFileJumpQuery } from '../src/lib/workspace-file-search'

test('global file search scopes POSIX absolute paths to their mounted workspace', () => {
  assert.equal(pathQueryForWorkspace('/srv/project/src/App.tsx', '/srv/project'), 'src/App.tsx')
  assert.equal(pathQueryForWorkspace('/srv/other/src/App.tsx', '/srv/project'), null)
})

test('global file search scopes Windows absolute paths case-insensitively', () => {
  assert.equal(pathQueryForWorkspace('C:\\Repo\\src\\App.tsx', 'c:\\repo'), 'src/App.tsx')
  assert.equal(pathQueryForWorkspace('D:\\Repo\\src\\App.tsx', 'C:\\Repo'), null)
})

test('global file search leaves relative path queries workspace-relative', () => {
  assert.equal(pathQueryForWorkspace('./src/App.tsx', '/srv/project'), 'src/App.tsx')
})

test('file jump queries reject zero, unsafe, and non-finite positions', () => {
  assert.equal(parseWorkspaceFileJumpQuery('src/App.tsx:0'), null)
  assert.equal(parseWorkspaceFileJumpQuery('src/App.tsx:1:0'), null)
  assert.equal(parseWorkspaceFileJumpQuery('src/App.tsx#L0'), null)
  assert.equal(parseWorkspaceFileJumpQuery(`src/App.tsx:${'9'.repeat(400)}`), null)
  assert.deepStrictEqual(parseWorkspaceFileJumpQuery('src/App.tsx#L2C3'), {
    path: 'src/App.tsx',
    lineNumber: 2,
    column: 3,
  })
})
