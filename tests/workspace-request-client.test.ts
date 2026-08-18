import assert from 'node:assert/strict'
import {
  requestLanguageServerTransport,
  requestWorkspace,
  setWorkspaceRequestTransport,
  setWorkspaceRequestTransportReady,
  settleLanguageServerRequest,
  settleWorkspaceRequest,
  WorkspaceTransportError,
} from '../src/lib/workspace-request-client'
import type {
  LanguageServerRequestMessage,
  WorkspaceCancelMessage,
  WorkspaceRequestMessage,
} from '../shared/browser-protocol'

type SentMessage = WorkspaceRequestMessage | WorkspaceCancelMessage | LanguageServerRequestMessage

async function run(): Promise<void> {
  const sent: SentMessage[] = []
  setWorkspaceRequestTransport(message => {
    sent.push(message)
    return true
  })
  setWorkspaceRequestTransportReady(true, 512 * 1024)

  const read = requestWorkspace<{ content: string }>({
    operation: 'read-file', rootId: 'root-a', path: 'a.ts',
  })
  const readMessage = sent.at(-1) as WorkspaceRequestMessage
  setWorkspaceRequestTransportReady(false)
  setWorkspaceRequestTransportReady(true)
  assert.strictEqual(
    sent.filter(message => message.type === 'workspace-request' && message.requestId === readMessage.requestId).length,
    2,
    'read requests must replay once transport compatibility is restored',
  )
  assert.strictEqual(settleWorkspaceRequest({
    type: 'workspace-result', requestId: readMessage.requestId, ok: true, result: { content: 'ready' },
  }), true)
  assert.deepStrictEqual(await read, { content: 'ready' })

  const mutation = requestWorkspace({
    operation: 'save-file', rootId: 'root-a', path: 'a.ts', content: 'changed', baseSha1: 'v1',
  }, { mutation: true })
  setWorkspaceRequestTransportReady(false)
  await assert.rejects(mutation, (error: unknown) => (
    error instanceof WorkspaceTransportError
    && error.code === 'DISCONNECTED'
    && error.uncertain
  ))
  setWorkspaceRequestTransportReady(true)

  const controller = new AbortController()
  const cancelled = requestWorkspace({
    operation: 'search', rootId: 'root-a', query: 'needle',
  }, { signal: controller.signal })
  const searchMessage = sent.at(-1) as WorkspaceRequestMessage
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) => error instanceof DOMException && error.name === 'AbortError')
  assert(sent.some(message => message.type === 'workspace-cancel' && message.requestId === searchMessage.requestId))

  const language = requestLanguageServerTransport<{ items: string[] }>({
    operation: 'request', rootId: 'root-a', method: 'completion', filePath: 'a.ts', position: { line: 0, column: 1 },
  })
  const languageMessage = sent.at(-1) as LanguageServerRequestMessage
  assert.strictEqual(settleLanguageServerRequest({
    type: 'language-server-result', requestId: languageMessage.requestId, ok: true,
    result: { items: ['one'] }, supported: true,
  }), true)
  assert.deepStrictEqual(await language, { result: { items: ['one'] }, supported: true })

  setWorkspaceRequestTransport(null)
  console.log('workspace request client passed')
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
