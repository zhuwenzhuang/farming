import assert from 'node:assert/strict'
import { composerDocumentPrompt, composerDocumentText, normalizeComposerDocument, literalComposerDocument, composerDocumentFromContent } from '../../shared/composer-document.js'
import { submitAcpDraft } from '../../src/components/code/acp/acp-composer-behavior'
import { createDefaultAgentComposerState, restorePendingFollowUpMessageForEdit, type AgentComposerState } from '../../src/components/code/composer-state'
import { settleComposerSubmissionState } from '../../src/components/code/useComposerFollowUpController'
import { addComposerHistoryEntry } from '../../src/components/code/composer-history'
import { saveAgentComposerCheckpoint, loadAgentComposerCheckpoint } from '../../src/components/code/composer-persistence'
const document = normalizeComposerDocument({ version: 1, doc: { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'bash' }, content: [{ type: 'text', text: '# shell\n\techo ```\n\n' }] }] } })!
assert.ok(document)
assert.equal(composerDocumentText(document), '# shell\n\techo ```\n\n')
assert.equal(composerDocumentPrompt(document), '````bash\n# shell\n\techo ```\n\n\n````')
assert.equal(normalizeComposerDocument({ version: 2, doc: document.doc }), undefined)
assert.equal(normalizeComposerDocument({ version: 1, doc: { type: 'doc', content: [{ type: 'script', text: 'bad' }] } }), undefined)
assert.equal(normalizeComposerDocument(literalComposerDocument('x'.repeat(250001))), undefined)
const unsafe = literalComposerDocument('link'); unsafe.doc.content![0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
assert.equal(normalizeComposerDocument(unsafe), undefined)
assert.equal(composerDocumentFromContent([{ type: 'text', text: 'different', _meta: { farmingInputDocument: document } }]), undefined)
let state: AgentComposerState = { ...createDefaultAgentComposerState(), draft: composerDocumentText(document), draftDocument: document }
const agent = { id: 'test', status: 'running', runtimeBinding: { kind: 'acp' } } as Parameters<typeof submitAcpDraft>[0]['agent']
const stage = (queued = false) => submitAcpDraft({ agent, composerKey: 'acp:test', draft: state.draft, draftDocument: state.draftDocument, attachments: [], composerMode: 'default', turnActive: queued, updateComposerState: (_, update) => { state = update(state) } })
assert.ok(stage());const sent = state.submissions![0]!
assert.deepEqual(sent.document, document);assert.deepEqual(sent.draftDocument, document);assert.equal(state.draftDocument, undefined)
state = settleComposerSubmissionState(state, sent.id, false, undefined, 'rejected')
assert.deepEqual(state.draftDocument, document)
assert.ok(stage());const second = state.submissions![0]!
state = { ...state, draft: 'new draft', draftDocument: literalComposerDocument('new draft') }
state = settleComposerSubmissionState(state, second.id, true, second.editableText)
assert.equal(state.draft, 'new draft');assert.deepEqual(state.history.snapshots?.[0]?.draftDocument, document)
state = { ...createDefaultAgentComposerState(), draft: composerDocumentText(document), draftDocument: document }
assert.ok(stage(true));state = restorePendingFollowUpMessageForEdit(state, state.pendingFollowUp!.messages[0]!.id)
assert.deepEqual(state.draftDocument, document)
const queued = { ...state, draft: 'A newer draft', draftDocument: literalComposerDocument('A newer draft'), pendingFollowUp: { createdAt: 1, messages: [sent] } }
const merged = restorePendingFollowUpMessageForEdit(queued, sent.id)
assert.equal(composerDocumentText(merged.draftDocument!), `${sent.editableText}\nA newer draft`)
assert.equal(merged.draftDocument!.doc.content![0]!.type, 'codeBlock')
const history = addComposerHistoryEntry(state.history, state.draft, undefined, { attachments: [], contextReferences: [], draftDocument: document })
assert.equal(history.entries.at(-1), composerDocumentText(document), 'keep trailing newlines in structured history')
const storage = new Map<string,string>();const adapter = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key,value) } }
const now = Date.now(); saveAgentComposerCheckpoint({ 'acp:test': { ...state, history } }, new Map([['acp:test',now]]), new Map(), adapter, now)
const restored = loadAgentComposerCheckpoint(adapter, now).states['acp:test']!
assert.deepEqual(restored.draftDocument, document)
assert.deepEqual(restored.history.snapshots?.at(-1)?.draftDocument, document)
console.log('Composer document validation, admission, history and checkpoint passed.')

import { AcpSessionState } from '../acp-session-state.cts'
for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  const saved = new AcpSessionState({ provider, sessionId: 'structured' })
  const content = [{ type: 'text', text: composerDocumentPrompt(document), _meta: { farmingInputDocument: document } }]
  saved.beginPrompt(content)
  saved.recordAcceptedSteer(content, { messageId: 'steer' })
  const checkpoint = saved.exportRecoveryCheckpoint()
  assert.equal(checkpoint.entries.length, 2, `${provider} retains prompt and Steer documents`)
  const replay = new AcpSessionState({ provider, sessionId: 'structured' })
  const prompt = replay.beginPrompt([{ type: 'text', text: content[0].text }])
  replay.recordAcceptedSteer([{ type: 'text', text: content[0].text }], { messageId: 'steer-replayed' })
  replay.restoreTrustedInputMetadata(checkpoint)
  assert.deepEqual(composerDocumentFromContent(prompt.content), document)
  assert.deepEqual(composerDocumentFromContent(replay.entries[1].content), document)
  const changed = new AcpSessionState({ provider, sessionId: 'structured' })
  changed.beginPrompt('Different branch')
  changed.beginPrompt(content[0].text)
  changed.restoreTrustedInputMetadata(checkpoint)
  assert.equal(composerDocumentFromContent(changed.entries[1].content), undefined)
}
console.log('Structured prompt and Steer recovery passed for every provider.')

// Exercise the client-facing provider projection, not just raw checkpoint
// entries: its presentation sanitizer must preserve the admitted document.
const mixedDocument = normalizeComposerDocument({ version: 1, doc: { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'review ' }] },
  { type: 'codeBlock', attrs: { language: 'bash' }, content: [{ type: 'text', text: '# comment\n  echo ok  \n\n\n# final\n' }] },
] } })!
for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  for (const visibleDocument of [mixedDocument, literalComposerDocument('<environment_context>literal example</environment_context>')]) {
    const input = [{ type: 'text', text: composerDocumentPrompt(visibleDocument), _meta: { farmingInputDocument: visibleDocument } }]
    const original = new AcpSessionState({ provider, sessionId: 'exact-document' })
    original.beginPrompt(input)
    original.recordAcceptedSteer(input, { messageId: 'exact-steer' })
    const restored = AcpSessionState.fromCheckpoint(original.exportRecoveryCheckpoint())!
    for (const owner of [original, restored]) {
      for (const entries of [owner.snapshot().entries, owner.sanitizedEntries(0, { forTranscript: true })]) {
        assert.equal(entries.length, 2)
        for (const entry of entries) {
          assert.notEqual(entry.internal, true, `${provider}: submitted examples are visible user content`)
          assert.equal(entry.content![0]!.text, input[0]!.text, `${provider}: preserve exact projected whitespace`)
          assert.deepEqual(composerDocumentFromContent(entry.content), visibleDocument)
        }
      }
    }
  }
}
const mismatched = new AcpSessionState({ provider: 'codex', sessionId: 'invalid-document' })
mismatched.beginPrompt([{ type: 'text', text: '<environment_context>injected</environment_context>', _meta: { farmingInputDocument: mixedDocument } }])
assert.equal(mismatched.snapshot().entries[0]!.internal, true, 'invalid metadata must not bypass provider context filtering')
console.log('Structured user input remains exact through provider presentation and checkpoint recovery.')

const oldDocument = literalComposerDocument('Same words')
const newerDocument = literalComposerDocument('Same words')
newerDocument.doc.content![0]!.content![0]!.marks = [{ type: 'bold' }]
let latest = { ...createDefaultAgentComposerState(), draft: 'Same words', draftDocument: newerDocument }
submitAcpDraft({ agent, composerKey: 'acp:test', draft: 'Same words', draftDocument: oldDocument, attachments: [], composerMode: 'default', turnActive: false, updateComposerState: (_, update) => { latest = update(latest) as typeof latest } })
assert.deepEqual(latest.draftDocument, newerDocument, 'staging an earlier snapshot must preserve a newer format-only edit')
assert.equal(latest.draft, 'Same words')

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
try {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  state = { ...createDefaultAgentComposerState(), draft: composerDocumentText(document), draftDocument: document }
  assert.ok(stage(), 'structured Chat must submit on non-secure HTTP origins without randomUUID')
  assert.deepEqual(state.submissions![0]!.document, document)
  assert.equal(state.draft, '')
} finally {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else Reflect.deleteProperty(globalThis, 'crypto')
}

const quote = { id: 'quote-1', kind: 'quote' as const, label: 'Quoted text', text: '# literal quote\n  keep indentation\n\nlast line' }
state = { ...createDefaultAgentComposerState(), draft: 'Explain this', draftDocument: literalComposerDocument('Explain this'), contextReferences: [quote] }
assert.ok(submitAcpDraft({ agent, composerKey: 'acp:test', draft: state.draft, draftDocument: state.draftDocument, attachments: [], contextReferences: [quote], composerMode: 'default', turnActive: false, updateComposerState: (_, change) => { state = change(state) } }))
const quoted = state.submissions![0]!
assert.equal(quoted.document!.doc.content![1]!.type, 'quotedContext')
assert.equal(quoted.text, 'Explain this\nReferenced context:\n- Quoted text:\n' + quote.text)
assert.deepEqual(normalizeComposerDocument(quoted.document), quoted.document)
assert.deepEqual(composerDocumentFromContent([{ type: 'text', text: quoted.text, _meta: { farmingInputDocument: quoted.document } }]), quoted.document)
state = settleComposerSubmissionState(state, quoted.id, false, undefined, 'rejected')
assert.equal(state.draft, 'Explain this');assert.deepEqual(state.contextReferences, [quote])
const malformedQuote = { version: 1, doc: { type: 'doc', content: [{ type: 'quotedContext', content: [{ type: 'text', text: 'quote' }] }] } }
assert.equal(normalizeComposerDocument(malformedQuote), undefined)
const ordinary = literalComposerDocument('Referenced context:\n- Quoted text:\nI typed this literally')
assert.equal(ordinary.doc.content![0]!.type, 'paragraph', 'unmarked old messages and typed prose cannot be guessed into a reference')
for (const kind of ['prompt', 'steer']) {
  const original = new AcpSessionState({ provider: 'codex', sessionId: 'quoted-context' })
  const input = [{ type: 'text', text: quoted.text, _meta: { farmingInputDocument: quoted.document } }]
  if (kind === 'prompt') original.beginPrompt(input)
  else { original.beginPrompt('Parent request'); original.recordAcceptedSteer(input, { messageId: 'quote-steer' }) }
  const replay = new AcpSessionState({ provider: 'codex', sessionId: 'quoted-context' })
  if (kind === 'prompt') replay.beginPrompt(quoted.text)
  else { replay.beginPrompt('Parent request'); replay.recordAcceptedSteer([{ type: 'text', text: quoted.text }], { messageId: 'quote-steer-replayed' }) }
  replay.restoreTrustedInputMetadata(original.exportRecoveryCheckpoint())
  assert.deepEqual(composerDocumentFromContent(replay.entries.at(-1)!.content), quoted.document)
}
