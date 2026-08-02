import assert from 'node:assert/strict'
import test from 'node:test'
import {
  languageNavigatorNodeRoot,
  languageNavigatorRequestIsCurrent,
  nextLanguageNavigatorDirectionSource,
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
