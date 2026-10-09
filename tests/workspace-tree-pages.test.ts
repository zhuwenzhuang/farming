import assert from 'node:assert/strict'
import { fetchWorkspaceTree } from '../src/lib/workspace-files'
import { setWorkspaceRequestTransport, setWorkspaceRequestTransportReady, settleWorkspaceRequest } from '../src/lib/workspace-request-client'
import type { WorkspaceRequest } from '../shared/browser-protocol'

async function run() {
  const sent: WorkspaceRequest[] = []
  let mode: 'complete' | 'cancel' | 'expire' = 'complete'
  let controller = new AbortController()
  setWorkspaceRequestTransport(message => {
    if (message.type !== 'workspace-request') return true
    const request = message.request
    sent.push(request)
    assert.equal(request.operation, 'tree')
    if (request.operation !== 'tree') return false
    queueMicrotask(() => {
      if (request.cursor && !request.release && mode === 'cancel') {
        controller.abort()
        return
      }
      if (request.cursor && !request.release && mode === 'expire') {
        settleWorkspaceRequest({ type: 'workspace-result', requestId: message.requestId, ok: false,
          error: { code: 'CONFLICT', message: 'Directory listing expired', status: 409 } })
        return
      }
      settleWorkspaceRequest({ type: 'workspace-result', requestId: message.requestId, ok: true, result: {
        path: 'large', items: request.release ? [] : [{ name: request.cursor ? 'b' : 'a', path: request.cursor ? 'large/b' : 'large/a', type: 'file', size: 0, mtimeMs: 0 }],
        nextCursor: request.cursor ? null : 'snapshot:1',
      } })
    })
    return true
  })
  setWorkspaceRequestTransportReady(true)
  try {
    const tree = await fetchWorkspaceTree('root', 'large', { signal: controller.signal })
    assert.deepEqual(tree.items.map(item => item.name), ['a', 'b'])
    assert(sent.some(request => request.operation === 'tree' && request.release), 'completed snapshots are released')
    for (const failure of ['cancel', 'expire'] as const) {
      sent.length = 0
      controller = new AbortController()
      mode = failure
      await assert.rejects(fetchWorkspaceTree('root', 'large', { signal: controller.signal }))
      assert(sent.some(request => request.operation === 'tree' && request.release), 'failed transfers release their snapshot')
      assert.equal(sent.filter(request => request.operation === 'tree' && !request.cursor).length, 1,
        'failure cannot silently restart or return a partial listing')
    }
  } finally { setWorkspaceRequestTransport(null) }
  console.log('workspace tree page client tests passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
