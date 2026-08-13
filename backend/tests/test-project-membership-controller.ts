const assert = require('assert')
const {
  requestProjectMountForFile,
} = require('../../src/components/code/useProjectMembershipController.ts')

async function run() {
  const requests: Array<{ url: string; body: unknown }> = []
  const request = async (url: string, init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json' }
    body: string
    signal?: AbortSignal
  }) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          workspace: '/repo',
          projectWorkspaces: ['/repo'],
          pinnedProjectWorkspaces: [],
        }
      },
    }
  }
  const mounted = await requestProjectMountForFile('/repo/src/file.ts', undefined, request)
  assert.deepStrictEqual(requests, [{
    url: '/api/projects/mount-file',
    body: { path: '/repo/src/file.ts' },
  }])
  assert.strictEqual(mounted.workspace, '/repo')
  assert.deepStrictEqual(mounted.membership?.projectWorkspaces, ['/repo'])

  const missing = await requestProjectMountForFile('/tmp/plain.txt', undefined, async () => ({
    ok: false,
    status: 404,
    async json() {
      return { error: 'No Git repository found for file' }
    },
  }))
  assert.deepStrictEqual(missing, { membership: null, workspace: '' })

  console.log('project membership controller behavior passed')
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
