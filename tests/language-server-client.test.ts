import assert from 'node:assert/strict'
import test from 'node:test'

test('Language Server client turns an aborted bounded request into an explicit timeout', async () => {
  const {
    setWorkspaceRequestTransport,
    setWorkspaceRequestTransportReady,
    settleLanguageServerRequest,
  } = await import('../src/lib/workspace-request-client')
  setWorkspaceRequestTransport(message => {
    if (message.type !== 'language-server-request') return true
    queueMicrotask(() => settleLanguageServerRequest({
      type: 'language-server-result',
      requestId: message.requestId,
      ok: false,
      error: { code: 'TIMEOUT', message: 'Workspace request timed out', status: 504 },
    }))
    return true
  })
  setWorkspaceRequestTransportReady(true)

  try {
    const { LanguageServerError, fetchLanguageServerCapability } = await import('../extensions/language-server/frontend/client')
    await assert.rejects(
      fetchLanguageServerCapability(),
      (error: unknown) => error instanceof LanguageServerError
        && error.status === 504
        && error.code === 'LANGUAGE_SERVER_REQUEST_TIMEOUT',
    )
  } finally {
    setWorkspaceRequestTransport(null)
  }
})
