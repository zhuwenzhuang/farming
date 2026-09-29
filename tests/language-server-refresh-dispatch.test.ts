import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dispatchLanguageServerRefresh,
  registerLanguageServerRefreshConsumer,
} from '../extensions/language-server/frontend/refresh-dispatch'
import type { LanguageServerRefreshMessage } from '../src/types/messages'

test('defers only the latest refresh of the current server epoch until Monaco subscribes', () => {
  const event = (serverEpoch: string, revision: number): LanguageServerRefreshMessage => ({
    type: 'language-server-refresh', serverEpoch, revision,
    rootId: 'project-a', workspace: '/workspace-a', kind: 'semanticTokens',
  })
  dispatchLanguageServerRefresh(event('old-server', 1))
  dispatchLanguageServerRefresh(event('old-server', 3))
  dispatchLanguageServerRefresh(event('old-server', 2))
  dispatchLanguageServerRefresh(event('current-server', 1))
  dispatchLanguageServerRefresh(event('current-server', 4))
  dispatchLanguageServerRefresh(event('current-server', 2))

  const received: LanguageServerRefreshMessage[] = []
  registerLanguageServerRefreshConsumer(message => received.push(message))
  assert.deepEqual(received, [event('current-server', 4)])

  dispatchLanguageServerRefresh(event('current-server', 5))
  assert.deepEqual(received, [event('current-server', 4), event('current-server', 5)])
})
