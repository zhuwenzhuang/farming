import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelComposerIntake, intakeComposerFile, normalizeAttachmentMime } from '../src/components/code/composer-intake'
import { createDefaultAgentComposerState, type AgentComposerState } from '../src/components/code/composer-state'

test('intake reserves exact draft ownership, and deletion fences a late successful response', async () => {
  const originalFetch = globalThis.fetch
  let complete!: (response: Response) => void
  let requestedSignal: AbortSignal | undefined
  globalThis.fetch = (_input, init) => {
    requestedSignal = init?.signal || undefined
    return new Promise(resolve => { complete = resolve })
  }
  let source = createDefaultAgentComposerState(); const other = createDefaultAgentComposerState()
  const update = (change: (state: AgentComposerState) => AgentComposerState) => { source = change(source) }
  try {
    intakeComposerFile(new File(['document'], 'notes.txt'), update, update)
    const id = source.contextReferences![0].id
    assert.equal(source.contextReferences![0].status, 'uploading')
    assert.equal(other.contextReferences?.length || 0, 0)
    cancelComposerIntake(id)
    source.contextReferences = []
    assert.equal(requestedSignal?.aborted, true)
    complete(Response.json({ text: 'document', path: '/attachments/notes.txt', type: 'text/plain' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(source.contextReferences, [])
    assert.equal(other.contextReferences?.length || 0, 0)
  } finally { globalThis.fetch = originalFetch }
})
test('recognized media extensions repair missing MIME types without treating documents as images', () => {
  assert.equal(normalizeAttachmentMime(new File([''], 'photo.HEIC')).type, 'image/heic')
  assert.equal(normalizeAttachmentMime(new File([''], 'audio.wav', { type: 'application/octet-stream' })).type, 'audio/wav')
  assert.equal(normalizeAttachmentMime(new File([''], 'notes.md')).type, '')
})
