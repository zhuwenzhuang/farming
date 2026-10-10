import assert from 'node:assert/strict'
import test from 'node:test'
import { attachPastedText, createPastedTextReference, restorePastedText } from '../src/components/code/composer-paste'
import { composerMessageWithContext } from '../src/components/code/composer-message'
import { createDefaultAgentComposerState, createPendingFollowUpMessage, restorePendingFollowUpMessageForEdit } from '../src/components/code/composer-state'
import { loadAgentComposerCheckpoint, saveAgentComposerCheckpoint } from '../src/components/code/composer-persistence'

const text = '# Design review\r\n' + '保留原文 🐱\n'.repeat(1500) + '\n  '

test('paste threshold counts Unicode characters and leaves short native pastes alone', () => {
  assert.equal(createPastedTextReference('x'.repeat(1000)), null)
  assert.equal(createPastedTextReference('🐱'.repeat(1000)), null)
  assert.equal(createPastedTextReference('🐱'.repeat(1001))?.text, '🐱'.repeat(1001))
  assert.equal(createPastedTextReference(text)?.label, '# Design review')
  assert.throws(() => createPastedTextReference('x'.repeat(250_001)), /Split it into smaller documents/)
})

test('paste replaces selection, repeats independently, and restores losslessly once', () => {
  const initial = createDefaultAgentComposerState()
  initial.draft = 'before REPLACE after'
  const first = createPastedTextReference(text)!
  const second = createPastedTextReference(text)!
  assert.notEqual(first.id, second.id)
  const attached = attachPastedText(initial, first, 7, 14)
  assert.equal(attached.draft, 'before  after')
  const repeated = attachPastedText(attached, second, 7, 7)
  assert.equal(repeated.contextReferences?.length, 2)
  const restored = restorePastedText(repeated, first.id)
  assert.equal(restored.draft, 'before  after\n\n' + text)
  assert.deepEqual(restored.contextReferences, [second])
  assert.equal(restorePastedText(restored, first.id), restored)
  assert.equal(initial.draft, 'before REPLACE after')
})

test('large pasted references recover independently and retain full content through queue editing', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const reference = createPastedTextReference(text)!
  const state = attachPastedText(createDefaultAgentComposerState(), reference, 0, 0)
  state.draft = 'Review this document'
  const message = composerMessageWithContext(state.draft, state.contextReferences!)
  assert.ok(message.includes(text))
  assert.ok(message.includes('reference material'))
  const pending = createPendingFollowUpMessage(message, [], state.draft, 'default', [reference])
  const queue = createDefaultAgentComposerState()
  queue.pendingFollowUp = { messages: [pending], createdAt: pending.createdAt }
  queue.submissions = [{ ...pending, id: 'failed-paste', status: 'submitting' }]
  assert.equal(saveAgentComposerCheckpoint({ draft: state, queue }, new Map(), new Map(), storage, 100), true)
  const recovered = loadAgentComposerCheckpoint(storage, 101).states
  assert.deepEqual(recovered.draft.contextReferences, [reference])
  assert.equal(recovered.draft.draft, state.draft)
  assert.equal(recovered.queue.submissions?.[0].status, 'unknown')
  assert.deepEqual(recovered.queue.submissions?.[0].contextReferences, [reference])
  const edited = restorePendingFollowUpMessageForEdit(recovered.queue, pending.id)
  assert.deepEqual(edited.contextReferences, [reference])
  assert.equal(edited.draft, state.draft)
  assert.equal(composerMessageWithContext(edited.draft, edited.contextReferences!), message)
})

test('format metadata is bounded, rejects unsafe styles, and cannot change snapshot text', async () => {
  const { validatePastedTextFormats } = await import('../src/components/code/composer-paste-format')
  const formats = [{ start: 0, end: 6, color: 'rgb(128, 0, 128)', bold: true, monospace: true }]
  assert.deepEqual(validatePastedTextFormats(formats, text), formats)
  for (const invalid of [
    [{ start: -1, end: 6 }], [{ start: 0, end: text.length + 1 }],
    [{ start: 2, end: 6 }, { start: 3, end: 9 }],
    [{ start: 0, end: 6, color: 'url(https://example.invalid)' }],
    [{ start: 0, end: 6, bold: 'true' }], Array(10_001).fill(formats[0]),
  ]) assert.equal(validatePastedTextFormats(invalid, text), undefined)
  const reference = { ...createPastedTextReference(text)!, textFormats: formats }
  const state = attachPastedText(createDefaultAgentComposerState(), reference, 0, 0)
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  assert.equal(saveAgentComposerCheckpoint({ draft: state }, new Map(), new Map(), storage, 100), true)
  const recovered = loadAgentComposerCheckpoint(storage, 101).states.draft
  assert.deepEqual(recovered.contextReferences, [reference])
  assert.equal(restorePastedText(recovered, reference.id).draft, text)
  assert.equal(composerMessageWithContext('', [reference]), composerMessageWithContext('', [{ ...reference, textFormats: undefined }]))
})

test('restoring formatted code keeps editable Markdown through checkpoints', () => {
  const reference = { ...createPastedTextReference(text)!, editableMarkdown: '```java\n' + text + '\n```' }
  assert.ok(composerMessageWithContext('Review', [reference]).includes(reference.editableMarkdown))
  const state = attachPastedText(createDefaultAgentComposerState(), reference, 0, 0)
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  assert.equal(saveAgentComposerCheckpoint({ draft: state }, new Map(), new Map(), storage, 100), true)
  const restored = restorePastedText(loadAgentComposerCheckpoint(storage, 101).states.draft, reference.id)
  assert.equal(restored.draft, reference.editableMarkdown)
  assert.deepEqual(restored.contextReferences, [])
  assert.equal(restorePastedText(restored, reference.id), restored)
})

test('syntax decoration preserves source text including empty and unfinished fences', async () => {
  const { highlightComposerMarkdown, fencedComposerCode } = await import('../src/components/code/composer-markdown')
  const decode = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  for (const draft of ['```java\n```', '```', '```java\npublic class Example {}\n```\n', '**bold**\n- item\n[link](https://example.com)', '~~~sql\nselect * from example\n~~~', '```java\nString value = "<img src=x>";']) {
    assert.equal(decode(highlightComposerMarkdown(draft)!), draft)
  }
  assert.match(highlightComposerMarkdown('```java\npublic class Example {}\n```')!, /hljs-keyword/)
  assert.equal(highlightComposerMarkdown('ordinary question'), null)
  assert.equal(highlightComposerMarkdown('```java\n' + 'x'.repeat(50_001)), null)
  assert.equal(fencedComposerCode('literal ``` token', 'java'), '````java\nliteral ``` token\n````')
})
