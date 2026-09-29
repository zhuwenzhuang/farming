import assert from 'node:assert/strict'
import test from 'node:test'
import { composerContextReferenceId, composerMessageWithContext } from '../src/components/code/composer-message'

test('context rendering keeps skill identity, live paths and captured selection text distinct', () => {
  const file = { kind: 'file' as const, label: 'auth.ts', workspace: '/workspace', rootId: 'root', path: 'src/auth.ts' }
  const skill = { kind: 'skill' as const, label: 'Review', command: '$review', source: 'Personal' }
  const selection = { kind: 'selection' as const, label: 'auth.ts:3', workspace: '/workspace', rootId: 'root', path: 'src/auth.ts', startLine: 3, endLine: 4, text: 'const access = true' }
  const text = composerMessageWithContext('Please check this', [
    { ...file, id: composerContextReferenceId(file) },
    { ...skill, id: composerContextReferenceId(skill) },
    { ...selection, id: composerContextReferenceId(selection) },
  ])
  assert.match(text, /Use the \$review skill/)
  assert.match(text, /Please check this/)
  assert.match(text, /File: \/workspace\/src\/auth.ts/)
  assert.match(text, /Selection from \/workspace\/src\/auth.ts:3-4:\nconst access = true/)
  assert.notEqual(composerContextReferenceId(file), composerContextReferenceId(selection))
})


test('chat quotes retain captured text without inventing a filesystem path', () => {
  const quote = { id: 'quote', kind: 'quote' as const, label: 'Quote in chat', text: 'original\nanswer' }
  assert.equal(composerMessageWithContext('My question', [quote]), 'My question\n\nReferenced context:\n- Quote in chat:\noriginal\nanswer')
})
