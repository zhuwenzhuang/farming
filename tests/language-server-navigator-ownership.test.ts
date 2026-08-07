import assert from 'node:assert/strict'
import test from 'node:test'
import {
  languageNavigatorHierarchyRequestIsCurrent,
  languageNavigatorNodeRoot,
  languageNavigatorRequestIsCurrent,
  nextLanguageNavigatorDirectionSource,
  resetLanguageNavigatorNodesForDirection,
  sameLanguageNavigatorFile,
  type LanguageNavigatorSource,
} from '../src/components/files/language-navigator-ownership'

test('a stale navigator response and node cannot cross into a newly selected Agent', () => {
  const sourceA: LanguageNavigatorSource = {
    rootId: 'agent-a',
    filePath: '/workspace-a/main.ts',
    generation: 1,
  }
  let activeFile = { rootId: sourceA.rootId, filePath: sourceA.filePath }
  let navigatorSource: LanguageNavigatorSource | null = sourceA

  activeFile = { rootId: 'agent-b', filePath: '/workspace-b/main.ts' }
  navigatorSource = null

  assert.equal(
    languageNavigatorRequestIsCurrent(activeFile, navigatorSource, sourceA),
    false,
    'the response from Agent A must not populate Agent B navigator state',
  )
  assert.equal(
    languageNavigatorNodeRoot(activeFile, sourceA),
    null,
    'clicking a retained Agent A node must not open its path in Agent B',
  )
})

test('only the latest navigator generation can commit within one file', () => {
  const activeFile = { rootId: 'agent-a', filePath: '/workspace-a/main.ts' }
  const first = { ...activeFile, generation: 7 }
  const second = { ...activeFile, generation: 8 }

  assert.equal(languageNavigatorRequestIsCurrent(activeFile, second, first), false)
  assert.equal(languageNavigatorRequestIsCurrent(activeFile, second, second), true)
  assert.equal(languageNavigatorNodeRoot(activeFile, second), 'agent-a')
})

test('a hierarchy stays owned by its project while navigation opens one of its result files', () => {
  const source = { rootId: 'agent-a', filePath: 'App.ts', generation: 9 }
  const navigatedFile = { rootId: 'agent-a', filePath: 'Other.ts' }

  assert.equal(languageNavigatorRequestIsCurrent(navigatedFile, source, source), false)
  assert.equal(languageNavigatorHierarchyRequestIsCurrent(navigatedFile, source, source), true)
  assert.equal(languageNavigatorNodeRoot(navigatedFile, source), 'agent-a')
  assert.deepEqual(nextLanguageNavigatorDirectionSource(navigatedFile, source, 10), {
    rootId: 'agent-a',
    filePath: 'App.ts',
    generation: 10,
  })
})

test('direction change cannot relabel old nodes before the file-change effect runs', () => {
  const sourceA = {
    rootId: 'agent-a',
    filePath: '/workspace-a/main.ts',
    generation: 10,
  }
  const activeFileB = { rootId: 'agent-b', filePath: '/workspace-b/main.ts' }

  assert.equal(
    nextLanguageNavigatorDirectionSource(activeFileB, sourceA, 11),
    null,
    'the stale navigator must close instead of adopting Agent B identity',
  )
  assert.deepEqual(
    nextLanguageNavigatorDirectionSource(
      { rootId: sourceA.rootId, filePath: sourceA.filePath },
      sourceA,
      11,
    ),
    { rootId: sourceA.rootId, filePath: sourceA.filePath, generation: 11 },
  )
  assert.deepEqual(sourceA, {
    rootId: 'agent-a',
    filePath: '/workspace-a/main.ts',
    generation: 10,
  }, 'the node birth identity remains immutable')
})

test('pending hierarchy expansion is reset when direction changes and its old response is fenced', () => {
  const activeFile = { rootId: 'agent-a', filePath: '/workspace-a/main.ts' }
  const nodeSource = { ...activeFile, generation: 20 }
  const pendingNodes = [{
    key: 'root',
    source: nodeSource,
    loading: true,
    expanded: true,
    children: [{ key: 'pending-child', source: nodeSource, loading: true }],
  }]
  const directionSource = nextLanguageNavigatorDirectionSource(activeFile, nodeSource, 21)
  assert(directionSource)

  const resetNodes = resetLanguageNavigatorNodesForDirection(pendingNodes)
  assert.equal(resetNodes[0].loading, false)
  assert.equal(resetNodes[0].expanded, false)
  assert.equal(resetNodes[0].children, undefined)
  assert.equal(
    languageNavigatorRequestIsCurrent(activeFile, directionSource, nodeSource),
    false,
    'the pending expansion response from the old direction must be dropped',
  )
  assert.equal(
    sameLanguageNavigatorFile(directionSource, resetNodes[0].source),
    true,
    'the reset node remains eligible for a new expansion in the selected direction',
  )
})
