import assert from 'node:assert/strict'
import test from 'node:test'
import { addComposerHistoryEntry, navigateComposerHistory } from '../src/components/code/composer-history'
import { createDefaultAgentComposerState } from '../src/components/code/composer-state'
import { saveAgentComposerCheckpoint, loadAgentComposerCheckpoint } from '../src/components/code/composer-persistence'

test('attachment-only history recalls the whole message and restores the unsent attachment draft', () => {
  const reference = { id: 'doc', kind: 'document' as const, label: 'notes.txt', status: 'ready' as const, path: '/attachments/doc.txt', text: 'Review' }
  const saved = { attachments: [], contextReferences: [reference] }
  const history = addComposerHistoryEntry({ entries: [], cursor: null }, '', undefined, saved)
  const unsent = { attachments: [], contextReferences: [{ ...reference, id: 'unsent' }] }
  const older = navigateComposerHistory(history, 'previous', '', unsent)
  assert.deepEqual(older.snapshot, saved)
  const back = navigateComposerHistory(older.history, 'next', '', saved)
  assert.deepEqual(back.snapshot, unsent)
  const changed = addComposerHistoryEntry(history, '', undefined, unsent)
  assert.equal(changed.entries.length, 2)
})
test('checkpoint retains document snapshots and interrupted media without persisting object URLs', () => {
  let raw = ''
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } }
  const state = createDefaultAgentComposerState()
  state.contextReferences = [{ id: 'doc', kind: 'document', label: 'review.pdf', status: 'uploading' }]
  state.attachments = [{ id: 'image', kind: 'image', name: 'image.png', type: 'image/png', size: 1, status: 'uploading', previewUrl: 'blob:temporary' }]
  state.history = addComposerHistoryEntry(state.history, 'review', undefined, { attachments: [{ ...state.attachments[0], status: 'ready', path: '/attachments/pasted-image-123-12345678.png' }], contextReferences: [] })
  saveAgentComposerCheckpoint({ agent: state }, new Map([['agent', Date.now()]]), new Map(), storage)
  assert.ok(!raw.includes('blob:'))
  const recovered = loadAgentComposerCheckpoint(storage).states.agent
  assert.equal(recovered.contextReferences?.[0].status, 'error')
  assert.equal(recovered.attachments[0].status, 'error')
  assert.equal(recovered.history.snapshots?.[0]?.attachments[0].status, 'ready')
})
