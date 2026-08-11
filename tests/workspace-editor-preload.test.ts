import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS,
  createWorkspaceEditorLanguagePreloader,
} from '../src/lib/workspace-editor-preload'

test('workspace editor preload warms the supported language inventory once', async () => {
  const warmed: string[] = []
  const preload = createWorkspaceEditorLanguagePreloader(async languageId => {
    warmed.push(languageId)
  })

  const first = preload()
  const second = preload()
  assert.strictEqual(second, first)
  await Promise.all([first, second])
  assert.deepEqual(warmed, [...WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS])
})

test('workspace editor preload is best-effort and remains settled after a language fails', async () => {
  const attempts: string[] = []
  const preload = createWorkspaceEditorLanguagePreloader(async languageId => {
    attempts.push(languageId)
    if (languageId === 'broken') throw new Error('tokenizer unavailable')
  }, ['typescript', 'broken', 'markdown'])

  await assert.doesNotReject(preload())
  await assert.doesNotReject(preload())
  assert.deepEqual(attempts, ['typescript', 'broken', 'markdown'])
})
