import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { findKnownLeftovers, parseDirtyPaths } from '../scripts/assert-clean-workspace'

const repoRoot = path.join(__dirname, '..')

test('a clean listing and a clean status report nothing', () => {
  assert.deepEqual(findKnownLeftovers(['backend', 'src', 'package.json', 'fabric-notes']), [])
  assert.deepEqual(parseDirtyPaths(''), [])
  assert.deepEqual(parseDirtyPaths('\n'), [])
})

test('a literal tilde directory is rejected as an unexpanded home path', () => {
  const leftovers = findKnownLeftovers(['src', '~'])
  assert.equal(leftovers.length, 1)
  assert.equal(leftovers[0].path, '~')
  assert.match(leftovers[0].reason, /unexpanded home path/)
})

test('Agent fork worktree leftovers are rejected by their id prefix', () => {
  const leftovers = findKnownLeftovers(['fa-273-mol-dog-stale-db', 'fa-oxg-mol-dog-stale-db', 'src'])
  assert.deepEqual(leftovers.map(leftover => leftover.path), [
    'fa-273-mol-dog-stale-db',
    'fa-oxg-mol-dog-stale-db',
  ])
})

test('directories that merely start with "fa" stay accepted', () => {
  assert.deepEqual(findKnownLeftovers(['farming-net', 'fake', 'fa', 'fa-']), [])
})

test('porcelain status is parsed into paths for every change kind', () => {
  const porcelain = [
    ' M backend/agent-manager.cts',
    '?? backend/tests/test-new.ts',
    ' D scripts/removed.ts',
    'A  src/added.tsx',
  ].join('\n')
  assert.deepEqual(parseDirtyPaths(porcelain), [
    'backend/agent-manager.cts',
    'backend/tests/test-new.ts',
    'scripts/removed.ts',
    'src/added.tsx',
  ])
})

test('the clean-workspace gate is wired into CI after the check gate', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  assert.ok(
    workflow.includes('scripts/assert-clean-workspace.ts'),
    'CI must run the clean-workspace assertion',
  )
  assert.ok(
    workflow.indexOf('npm run check') < workflow.indexOf('scripts/assert-clean-workspace.ts'),
    'the assertion must run after the check gate so it observes what the gate left behind',
  )
})
