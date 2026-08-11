import assert from 'node:assert/strict'
import test from 'node:test'

test('Language Server client turns an aborted bounded request into an explicit timeout', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const fakeWindow = {
    setTimeout(callback: () => void) {
      callback()
      return 1
    },
    clearTimeout() {},
  } as unknown as Window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('Language Server request did not receive an abort signal'))
          return
        }
        if (signal.aborted) {
          reject(signal.reason || new Error('request aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason || new Error('request aborted')), { once: true })
      })
    },
  })

  try {
    const { LanguageServerError, fetchLanguageServerCapability } = await import('../extensions/language-server/frontend/client')
    await assert.rejects(
      fetchLanguageServerCapability(),
      (error: unknown) => error instanceof LanguageServerError
        && error.status === 504
        && error.code === 'LANGUAGE_SERVER_REQUEST_TIMEOUT',
    )
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
  }
})
