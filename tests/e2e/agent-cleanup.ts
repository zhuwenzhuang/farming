import type { APIResponse, TestInfo } from '@playwright/test'

type CleanupAgent = { id: string; command?: string }
type CleanupResponse = Pick<APIResponse, 'ok' | 'status' | 'json'>
type CleanupRequest = {
  get: (url: string, options: { timeout: number }) => Promise<CleanupResponse>
  delete: (url: string, options: { timeout: number }) => Promise<CleanupResponse>
  patch: (url: string, options: { timeout: number; data: { archived: boolean } }) => Promise<CleanupResponse>
}

export async function cleanupAgents(
  request: CleanupRequest,
  { archiveCodex = false, timeoutMs = 10_000, pollIntervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs
  const cleanupRequested = new Set<string>()
  const remainingTime = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Timed out cleaning up Farming E2E Agents: ${[...cleanupRequested].join(', ')}`)
    }
    return remaining
  }
  const checkedRequest = async (label: string, mutate: boolean, send: () => Promise<CleanupResponse>) => {
    let response: CleanupResponse
    try {
      response = await send()
    } catch (cause) {
      throw new Error(`${label} failed; ${mutate ? 'mutation outcome is uncertain; no replay' : 'Agent inventory is unknown'}`, { cause })
    }
    if (!response.ok()) throw new Error(`${label} failed: HTTP ${response.status()}; cleanup incomplete`)
    return response
  }

  while (true) {
    const timeout = remainingTime()
    const response = await checkedRequest('GET Agent inventory', false, () => (
      request.get('/farming/api/control/agents', { timeout })
    ))
    let data: unknown
    try {
      data = await response.json()
    } catch (cause) {
      throw new Error('GET Agent inventory returned invalid JSON; Agent inventory is unknown', { cause })
    }
    if (!data || typeof data !== 'object' || !('agents' in data) || !Array.isArray(data.agents)
      || !data.agents.every((agent: unknown) => agent && typeof agent === 'object'
        && 'id' in agent && typeof agent.id === 'string' && agent.id.length > 0)) {
      throw new Error('GET Agent inventory returned invalid Agents; Agent inventory is unknown')
    }
    const agents = data.agents as CleanupAgent[]
    if (agents.length === 0) return
    const pending = agents.filter(agent => {
      if (cleanupRequested.has(agent.id)) return false
      cleanupRequested.add(agent.id)
      return true
    })
    // Settle every admitted request before exiting, even when a peer fails.
    const results = await Promise.allSettled(pending.map(async agent => {
      const id = encodeURIComponent(agent.id)
      const timeout = remainingTime()
      if (archiveCodex && agent.command === 'codex') {
        await checkedRequest(`PATCH archive Agent ${agent.id}`, true, () => (
          request.patch(`/farming/api/agents/${id}`, { data: { archived: true }, timeout })
        ))
      } else {
        await checkedRequest(`DELETE Agent ${agent.id}`, true, () => (
          request.delete(`/farming/api/control/agents/${id}?recordHistory=0`, { timeout })
        ))
      }
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length === 1) throw failures[0].reason
    if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), 'Farming E2E Agent cleanup failed')
    // A successful mutation (including 202) still requires authoritative absence.
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingTime())))
  }
}

export async function reportAgentCleanupFailure(
  cleanup: () => Promise<void>,
  testInfo: Pick<TestInfo, 'attach'>,
) {
  try {
    await cleanup()
  } catch (error) {
    // Playwright appends fixture errors after the original test failure.
    try {
      await testInfo.attach('Agent cleanup failure', {
        body: Buffer.from(error instanceof Error ? error.stack ?? error.message : String(error)),
        contentType: 'text/plain',
      })
    } catch (attachmentError) {
      console.error('Could not attach Agent cleanup failure evidence:', attachmentError)
    }
    throw error
  }
}
