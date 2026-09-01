import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { projectFilesWorkspaceId } from '../src/lib/project-workspaces'

type JsonRecord = Record<string, unknown>

type BrowserResource = {
  browserKind?: string
  id: string
  controlEpoch: number
  controlOwner: 'agent' | 'user'
  desktopAdapterId?: string
  generation: number
  ownerAgentId: string
  sessionGeneration: number
  sessionId: string
  status: string
  tabId: string
  title?: string
  url?: string
}

type AcpSession = {
  configOptions?: Array<Record<string, unknown>>
  entries?: Array<Record<string, unknown>>
}

const cdpEndpoint = process.env.FARMING_DESKTOP_COMPOSED_CDP || ''
const evidenceDir = process.env.FARMING_DESKTOP_COMPOSED_EVIDENCE || ''
const workspace = process.env.FARMING_DESKTOP_COMPOSED_WORKSPACE || ''
const targetUrl = process.env.FARMING_DESKTOP_COMPOSED_TARGET_URL || ''
const existingAgentId = process.env.FARMING_DESKTOP_COMPOSED_AGENT_ID || ''
const phase = process.argv[2] || 'initial'

function required(value: string, name: string) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function jsonFetch<T>(
  page: Page,
  url: string,
  init: { body?: unknown; method?: string } = {},
): Promise<T> {
  const result = await page.evaluate(async ({ requestUrl, requestInit }) => {
    const response = await fetch(requestUrl, {
      method: requestInit.method,
      headers: requestInit.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { body, ok: response.ok, status: response.status }
  }, { requestInit: init, requestUrl: url })
  assert.equal(
    result.ok,
    true,
    `${init.method || 'GET'} ${url} failed (${result.status}): ${JSON.stringify(result.body)}`,
  )
  return result.body as T
}

async function poll<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await operation()
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${message}. Last value: ${JSON.stringify(last)}`)
}

async function browserResources(page: Page) {
  const snapshot = await jsonFetch<{ resources?: BrowserResource[] }>(page, '/api/browsers')
  return snapshot.resources || []
}

async function acpSession(page: Page, agentId: string) {
  const snapshot = await jsonFetch<{ session?: AcpSession }>(
    page,
    `/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=1`,
  )
  return snapshot.session || {}
}

async function openBrowserViewer(page: Page, agentId: string, browserId: string) {
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agentRow.waitFor({ state: 'visible', timeout: 30_000 })
  await agentRow.click()
  const resourceRow = page.locator(
    `[data-testid="farming-browser-row"][data-resource-id="${browserId}"], `
    + `[data-testid="farming-browser-row"][data-browser-id="${browserId}"]`,
  )
  if (!(await resourceRow.count())) {
    const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle')
    if (await resourcesToggle.count()) {
      await resourcesToggle.click()
      await resourceRow.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    }
  }
  if (await resourceRow.count()) {
    await resourceRow.first().click()
  } else if (await page.getByRole('button', { name: 'Open full browser' }).count()) {
    await page.getByRole('button', { name: 'Open full browser' }).first().click()
  } else if (await page.getByTestId('farming-browser-activity-preview-card').count()) {
    await page.getByTestId('farming-browser-activity-preview-card').first().click()
  } else {
    const browserRows = page.getByTestId('farming-browser-row')
    await browserRows.first().waitFor({ state: 'visible', timeout: 30_000 })
    const matching = browserRows.filter({ hasText: browserId })
    await (await matching.count() ? matching.first() : browserRows.first()).click()
  }
  const viewer = page.getByTestId('farming-browser-viewer')
  await viewer.waitFor({ state: 'visible', timeout: 30_000 })
  await viewer.getByTestId('farming-browser-native-surface').waitFor({ state: 'visible', timeout: 30_000 })
  return viewer
}

async function main() {
  required(cdpEndpoint, 'FARMING_DESKTOP_COMPOSED_CDP')
  required(evidenceDir, 'FARMING_DESKTOP_COMPOSED_EVIDENCE')
  required(workspace, 'FARMING_DESKTOP_COMPOSED_WORKSPACE')
  required(targetUrl, 'FARMING_DESKTOP_COMPOSED_TARGET_URL')
  fs.mkdirSync(evidenceDir, { recursive: true })

  const browser = await chromium.connectOverCDP(cdpEndpoint)
  try {
    const pages = browser.contexts().flatMap(context => context.pages())
    const page = pages.find(candidate => candidate.url().includes('/code/'))
    assert.ok(page, 'Farming Desktop renderer page is not available over CDP')
    page.setDefaultTimeout(30_000)
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })

    if (phase === 'hard-restart-after') {
      const before = JSON.parse(fs.readFileSync(
        path.join(evidenceDir, 'phase-hard-restart-prepare.json'),
        'utf8',
      )) as {
        adapterId: string
        ownerAgentId: string
        ownerWorkspace: string
        resources: Array<{ id: string; tabId: string }>
      }
      const resourceIds = before.resources.map(resource => resource.id)
      let freshResourceId = ''
      let freshOwnerId = ''
      try {
        const recovered = await poll(
          () => browserResources(page),
          resources => resources
            .filter(resource => resourceIds.includes(resource.id))
            .every(resource => resource.status !== 'running' && !resource.tabId),
          'Hard restart retained a stale native Browser lease',
          60_000,
        )
        const adapterId = (
          await page.evaluate(() => window.farmingDesktop?.nativeBrowser?.adapterId)
        ) || ''
        assert.equal(adapterId, before.adapterId)
        const ownerSnapshot = await jsonFetch<{
          agents?: Array<{ id?: string; status?: string }>
        }>(page, '/api/control/agents')
        const previousOwnerStatus = ownerSnapshot.agents
          ?.find(candidate => candidate.id === before.ownerAgentId)?.status || 'absent'
        const createdOwner = await jsonFetch<{ agentId?: string }>(page, '/api/control/agents', {
          method: 'POST',
          body: {
            agentRuntimeMode: 'terminal',
            command: 'bash',
            requestId: `desktop-hard-restart-owner-${Date.now()}`,
            task: '',
            workspace,
          },
        })
        assert.ok(createdOwner.agentId)
        freshOwnerId = createdOwner.agentId
        const owner = await poll(
          async () => {
            const snapshot = await jsonFetch<{
              agents?: Array<{ cwd?: string; id?: string; projectWorkspace?: string }>
            }>(page, '/api/control/agents')
            return snapshot.agents?.find(candidate => candidate.id === freshOwnerId)
          },
          candidate => Boolean(candidate?.projectWorkspace || candidate?.cwd),
          'Fresh hard-restart owner Agent did not become authoritative',
        )
        assert.ok(owner?.id)
        const ownerWorkspace = owner.projectWorkspace || owner.cwd || before.ownerWorkspace
        const created = await jsonFetch<BrowserResource>(page, '/api/browsers', {
          method: 'POST',
          body: {
            agentId: owner.id,
            desktopAdapterId: adapterId,
            name: 'Hard-restart fresh Browser 7F3A',
            rootId: projectFilesWorkspaceId(ownerWorkspace),
            source: 'desktop',
            url: `${targetUrl}done`,
          },
        })
        freshResourceId = created.id
        const fresh = await jsonFetch<BrowserResource>(
          page,
          `/api/browsers/${created.id}/start`,
          { method: 'POST' },
        )
        assert.equal(fresh.status, 'running')
        assert.ok(fresh.tabId)
        assert.equal(before.resources.some(resource => resource.tabId === fresh.tabId), false)
        const result = {
          adapterId,
          freshResource: {
            id: fresh.id,
            sessionId: fresh.sessionId,
            status: fresh.status,
            tabId: fresh.tabId,
            url: fresh.url,
          },
          oldResources: recovered
            .filter(resource => resourceIds.includes(resource.id))
            .map(resource => ({
              error: resource.error,
              id: resource.id,
              sessionId: resource.sessionId,
              status: resource.status,
              tabId: resource.tabId,
            })),
          previousOwnerStatus,
          ownerAgentId: owner.id,
          ownerWorkspace,
          phase,
        }
        fs.writeFileSync(
          path.join(evidenceDir, 'phase-hard-restart-after.json'),
          `${JSON.stringify(result, null, 2)}\n`,
        )
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return
      } finally {
        if (freshOwnerId) {
          await jsonFetch(
            page,
            `/api/control/agents/${encodeURIComponent(freshOwnerId)}`,
            { method: 'DELETE' },
          )
        }
        const cleanupIds = [...resourceIds, ...(freshResourceId ? [freshResourceId] : [])]
        const finalResources = await poll(
          () => browserResources(page),
          resources => resources
            .filter(resource => cleanupIds.includes(resource.id))
            .every(resource => resource.status === 'stopped' && !resource.tabId),
          'Hard-restart cleanup left a native Browser lease',
          60_000,
        )
        fs.writeFileSync(
          path.join(evidenceDir, 'phase-hard-restart-cleanup.json'),
          `${JSON.stringify({
            previousOwnerAgentId: before.ownerAgentId,
            freshOwnerAgentId: freshOwnerId,
            resourceIds: cleanupIds,
            resources: finalResources
              .filter(resource => cleanupIds.includes(resource.id))
              .map(resource => ({
                id: resource.id,
                sessionId: resource.sessionId,
                status: resource.status,
                tabId: resource.tabId,
              })),
          }, null, 2)}\n`,
        )
      }
    }

    if (phase === 'parallel-only' || phase === 'hard-restart-prepare') {
      const cleanupAfter = phase === 'parallel-only'
      let ownerId = ''
      const resourceIds: string[] = []
      try {
        const createdOwner = await jsonFetch<{ agentId?: string }>(page, '/api/control/agents', {
          method: 'POST',
          body: {
            agentRuntimeMode: 'terminal',
            command: 'bash',
            requestId: `desktop-parallel-only-owner-${Date.now()}`,
            task: '',
            workspace,
          },
        })
        assert.ok(createdOwner.agentId, 'Parallel-only owner creation returned no Agent id')
        ownerId = createdOwner.agentId
        const owner = await poll(
          async () => {
            const snapshot = await jsonFetch<{
              agents?: Array<{ cwd?: string; id?: string; projectWorkspace?: string }>
            }>(page, '/api/control/agents')
            return snapshot.agents?.find(candidate => candidate.id === ownerId)
          },
          candidate => Boolean(candidate?.projectWorkspace || candidate?.cwd),
          'Parallel-only owner workspace did not become authoritative',
        )
        assert.ok(owner?.id, 'Parallel-only owner is missing')
        const ownerWorkspace = owner.projectWorkspace || owner.cwd || ''
        const rootId = projectFilesWorkspaceId(ownerWorkspace)
        const desktopAdapterId = (
          await page.evaluate(() => window.farmingDesktop?.nativeBrowser?.adapterId)
        ) || ''
        assert.ok(desktopAdapterId, 'Desktop native Browser adapter identity is missing')
        const createRunning = async (name: string, url: string) => {
          const created = await jsonFetch<BrowserResource>(page, '/api/browsers', {
            method: 'POST',
            body: {
              agentId: owner.id,
              desktopAdapterId,
              name,
              rootId,
              source: 'desktop',
              url,
            },
          })
          resourceIds.push(created.id)
          return jsonFetch<BrowserResource>(page, `/api/browsers/${created.id}/start`, {
            method: 'POST',
          })
        }
        const [first, second] = await Promise.all([
          createRunning('Parallel-only home 7F3A', targetUrl),
          createRunning('Parallel-only popup 7F3A', `${targetUrl}popup`),
        ])
        await jsonFetch(page, `/api/browsers/${first.id}/navigate`, {
          method: 'POST',
          body: { url: `${targetUrl}step-one` },
        })
        const resources = await poll(
          () => browserResources(page),
          snapshot => snapshot.some(resource => (
            resource.id === first.id
            && resource.ownerAgentId === owner.id
            && resource.status === 'running'
            && resource.url?.includes('/step-one')
          )) && snapshot.some(resource => (
            resource.id === second.id
            && resource.ownerAgentId === owner.id
            && resource.status === 'running'
            && resource.url?.includes('/popup')
          )),
          'Parallel-only Desktop Browser Resources crossed owner or navigation state',
        )
        const firstIsolated = resources.find(resource => resource.id === first.id)
        const secondIsolated = resources.find(resource => resource.id === second.id)
        assert.ok(firstIsolated && secondIsolated)
        assert.notEqual(firstIsolated.id, secondIsolated.id)
        assert.notEqual(firstIsolated.sessionId, secondIsolated.sessionId)
        assert.notEqual(firstIsolated.tabId, secondIsolated.tabId)
        const result = {
          adapterId: desktopAdapterId,
          ownerAgentId: owner.id,
          ownerWorkspace,
          phase,
          resources: [firstIsolated, secondIsolated].map(resource => ({
            id: resource.id,
            sessionId: resource.sessionId,
            status: resource.status,
            tabId: resource.tabId,
            url: resource.url,
          })),
        }
        fs.writeFileSync(
          path.join(
            evidenceDir,
            phase === 'parallel-only'
              ? 'phase-parallel-only.json'
              : 'phase-hard-restart-prepare.json',
          ),
          `${JSON.stringify(result, null, 2)}\n`,
        )
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return
      } finally {
        if (ownerId && cleanupAfter) {
          await jsonFetch(page, `/api/control/agents/${encodeURIComponent(ownerId)}`, {
            method: 'DELETE',
          })
          const finalResources = await poll(
            () => browserResources(page),
            resources => resources
              .filter(resource => resourceIds.includes(resource.id))
              .every(resource => resource.status === 'stopped' && !resource.tabId),
            'Parallel-only cleanup left a native Resource lease',
            60_000,
          )
          fs.writeFileSync(
            path.join(evidenceDir, 'phase-parallel-only-cleanup.json'),
            `${JSON.stringify({
              ownerAgentId: ownerId,
              resourceIds,
              resources: finalResources
                .filter(resource => resourceIds.includes(resource.id))
                .map(resource => ({
                  id: resource.id,
                  sessionId: resource.sessionId,
                  status: resource.status,
                  tabId: resource.tabId,
                })),
            }, null, 2)}\n`,
          )
        }
      }
    }

    if (phase === 'initial') {
      const capability = await jsonFetch<{
        sources?: Array<{ available?: boolean; source?: string }>
      }>(page, '/api/browsers/capability')
      assert.equal(
        capability.sources?.some(source => source.source === 'desktop' && source.available === true),
        true,
        'Desktop Browser capability is not authoritatively available',
      )

      const catalog = await jsonFetch<{
        catalog?: Array<{ reasoningLevels?: Array<{ value?: string }>; value?: string }>
      }>(page, '/api/codex/models?homeId=default')
      const model = catalog.catalog?.find(candidate => (
        candidate.value === 'gpt-5.6-luna'
        && candidate.reasoningLevels?.some(level => level.value === 'low')
      ))
      assert.ok(model?.value, 'The requested Codex launch profile gpt-5.6-luna/low is unavailable')
      await jsonFetch(page, '/api/settings', {
        method: 'POST',
        body: {
          browserExtensionEnabled: true,
          browserSource: 'desktop',
          codexModel: model.value,
          codexReasoningEffort: 'low',
          codexServiceTier: 'default',
          codexModelPreset: `${model.value}:low`,
          agentLaunchProfiles: {
            codex: {
              approvalMode: 'approve',
              model: model.value,
              reasoningEffort: 'low',
              serviceTier: 'default',
              modelPreset: `${model.value}:low`,
            },
          },
        },
      })

      const prompt = [
        'Use only the instance-exact Farming Browser capability exposed to this Agent.',
        `Open ${targetUrl}.`,
        'Perform this exact multi-step journey: click Step one; click Advance; fill the answer field with REAL_CODEX_7F3A; click Finish.',
        'Then return to the home URL, open its popup, and inspect both tabs. Do not manually close either tab; allow normal turn-end cleanup.',
        'Report the exact markers COMPOSED_HOME_7F3A, STEP_ONE_7F3A, STEP_TWO_7F3A, DONE_REAL_CODEX_7F3A, and POPUP_7F3A only after observing them.',
      ].join(' ')
      let agentId = existingAgentId
      if (agentId) {
        const staleResources = (await browserResources(page)).filter(resource => (
          resource.ownerAgentId === agentId && resource.status === 'failed'
        ))
        for (const resource of staleResources) {
          await jsonFetch(page, `/api/browsers/${resource.id}`, { method: 'DELETE' })
        }
      } else {
        const createdAgent = await jsonFetch<{ agentId?: string }>(page, '/api/control/agents', {
          method: 'POST',
          body: {
            agentRuntimeMode: 'chat',
            command: 'codex',
            requestId: `desktop-composed-${Date.now()}`,
            task: prompt,
            workspace,
          },
        })
        assert.ok(createdAgent.agentId, 'Real Codex Agent creation returned no Agent id')
        agentId = createdAgent.agentId
      }

      if (existingAgentId) {
        const stopped = (await browserResources(page)).filter(resource => (
          resource.ownerAgentId === agentId && resource.status === 'stopped'
        ))
        const restart = [
          stopped.find(resource => resource.url === targetUrl),
          stopped.find(resource => resource.url?.includes('/popup')),
        ].filter((resource): resource is BrowserResource => Boolean(resource))
        for (const resource of restart) {
          await jsonFetch(page, `/api/browsers/${resource.id}/start`, { method: 'POST' })
        }
      }

      const homeObserved = await poll(
        async () => ({
          resources: await browserResources(page),
          session: await acpSession(page, agentId),
        }),
        snapshot => {
          const nonUserEntries = (snapshot.session.entries || []).filter(entry => entry.role !== 'user')
          return JSON.stringify(nonUserEntries).includes('COMPOSED_HOME_7F3A')
            && snapshot.resources.some(resource => (
              resource.ownerAgentId === agentId && resource.status === 'running'
            ))
        },
        'Real Codex Agent did not open and observe the first Desktop Browser Resource',
        180_000,
      )
      const primary = homeObserved.resources.find(resource => (
        resource.ownerAgentId === agentId && resource.status === 'running'
      ))
      assert.ok(primary, 'Real Codex primary Browser Resource is missing')

      const viewer = await openBrowserViewer(page, agentId, primary.id)
      const beforeHandoff = (await browserResources(page)).find(resource => resource.id === primary.id)
      assert.ok(beforeHandoff, 'Primary Browser disappeared before handoff')
      await viewer.getByRole('button', { name: 'Take control' }).click()
      const userOwned = await poll(
        () => browserResources(page),
        resources => resources.find(resource => (
          resource.id === primary.id
          && resource.controlOwner === 'user'
          && resource.controlEpoch > beforeHandoff.controlEpoch
        )),
        'Desktop Browser did not commit user control',
      ) as BrowserResource[]
      const userResource = userOwned.find(resource => resource.id === primary.id)
      assert.ok(userResource, 'User-owned Browser Resource is missing')

      const blockedAgentAction = await page.evaluate(async id => {
        const response = await fetch(`/api/browsers/${encodeURIComponent(id)}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'navigate', url: 'about:blank' }),
        })
        return { body: await response.json().catch(() => null), status: response.status }
      }, primary.id)
      assert.equal(blockedAgentAction.status, 409)
      assert.match(
        JSON.stringify(blockedAgentAction.body),
        /BROWSER_(CONTROL|STALE)|control/i,
        'Agent action was not fenced while the user owned control',
      )

      await viewer.getByRole('button', { name: 'Return to Agent' }).click()
      const agentOwned = await poll(
        () => browserResources(page),
        resources => resources.find(resource => (
          resource.id === primary.id
          && resource.controlOwner === 'agent'
          && resource.controlEpoch > userResource.controlEpoch
        )),
        'Desktop Browser did not return control to the Agent',
      )
      const returned = agentOwned.find(resource => resource.id === primary.id)
      assert.ok(returned, 'Returned Browser Resource is missing')
      const staleNativeControl = await page.evaluate(async input => {
        try {
          await window.farmingDesktop?.nativeBrowser?.command({
            generation: input.generation,
            input: {
              controlEpoch: input.staleControlEpoch,
              controlOwner: 'agent',
            },
            operation: 'reload',
            resourceId: input.resourceId,
            sessionId: input.sessionId,
          })
          return { error: '', rejected: false }
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            rejected: true,
          }
        }
      }, {
        generation: returned.generation,
        resourceId: returned.id,
        sessionId: returned.sessionId,
        staleControlEpoch: userResource.controlEpoch,
      })
      assert.equal(staleNativeControl.rejected, true)
      assert.match(staleNativeControl.error, /BROWSER_STALE_CONTROL|control changed|stale/i)

      const observedSession = await poll(
        () => acpSession(page, agentId),
        session => {
          const nonUserEntries = (session.entries || []).filter(entry => entry.role !== 'user')
          const observedText = JSON.stringify(nonUserEntries)
          return [
            'COMPOSED_HOME_7F3A',
            'STEP_ONE_7F3A',
            'STEP_TWO_7F3A',
            'DONE_REAL_CODEX_7F3A',
            'POPUP_7F3A',
          ].every(marker => observedText.includes(marker))
        },
        'Real Codex Agent did not observe the complete multi-step Browser journey',
        300_000,
      )
      const modelOption = observedSession.configOptions?.find(option => option.category === 'model')
      const reasoningOption = observedSession.configOptions?.find(option => (
        option.category === 'thought_level'
        || option.id === 'reasoning_effort'
      ))
      assert.ok(modelOption?.currentValue, 'Real Codex transcript metadata is missing the actual model')
      assert.ok(reasoningOption?.currentValue, 'Real Codex transcript metadata is missing reasoning effort')

      const realAgentResources = (await browserResources(page)).filter(resource => (
        resource.ownerAgentId === agentId
      ))
      const homeResource = realAgentResources.find(resource => resource.url === targetUrl)
      const popupResource = realAgentResources.find(resource => resource.url?.includes('/popup'))
      assert.ok(homeResource && popupResource, 'ACP markers were not backed by home and popup Resources')
      assert.equal(homeResource.browserKind, 'desktop-native')
      assert.equal(popupResource.browserKind, 'desktop-native')
      assert.notEqual(homeResource.tabId, popupResource.tabId)
      const desktopEvidence = await page.evaluate(() => ({
        adapterId: window.farmingDesktop?.nativeBrowser?.adapterId || '',
        nativeSurfaceVisible: Boolean(document.querySelector(
          '[data-testid="farming-browser-native-surface"]',
        )),
        resourceIds: [...document.querySelectorAll('[data-testid="farming-browser-row"]')]
          .map(element => element.getAttribute('data-browser-id') || '')
          .filter(Boolean),
        viewerVisible: Boolean(document.querySelector('[data-testid="farming-browser-viewer"]')),
      }))
      assert.equal(desktopEvidence.adapterId, homeResource.desktopAdapterId)
      assert.equal(desktopEvidence.viewerVisible, true)
      assert.equal(desktopEvidence.nativeSurfaceVisible, true)
      assert.equal(desktopEvidence.resourceIds.includes(homeResource.id), true)
      assert.equal(desktopEvidence.resourceIds.includes(popupResource.id), true)
      const realAgentEvidence = {
        actualModel: String(modelOption.currentValue),
        actualReasoningEffort: String(reasoningOption.currentValue),
        agentId,
        configuredModel: model.value,
        configuredReasoningEffort: 'low',
        controlEpochs: {
          agentInitial: beforeHandoff.controlEpoch,
          agentReturned: returned.controlEpoch,
          user: userResource.controlEpoch,
        },
        popupEvidence: {
          acpMarker: true,
          desktop: desktopEvidence,
          resources: [homeResource, popupResource].map(resource => ({
            adapterId: resource.desktopAdapterId,
            id: resource.id,
            tabId: resource.tabId,
            url: resource.url,
          })),
        },
        staleNativeControl,
      }
      fs.writeFileSync(
        path.join(evidenceDir, 'phase-initial-real-agent.json'),
        `${JSON.stringify(realAgentEvidence, null, 2)}\n`,
      )

      const desktopAdapterId = (
        await page.evaluate(() => window.farmingDesktop?.nativeBrowser?.adapterId)
      ) || ''
      assert.ok(desktopAdapterId, 'Desktop native Browser adapter identity is missing')
      const parallelOwnerId = agentId
      const ownerSnapshot = await jsonFetch<{
        agents?: Array<{ cwd?: string; id?: string; projectWorkspace?: string }>
      }>(page, '/api/control/agents')
      const ownerAgent = ownerSnapshot.agents?.find(candidate => candidate.id === parallelOwnerId)
      const ownerWorkspace = ownerAgent?.projectWorkspace || ownerAgent?.cwd || ''
      assert.ok(ownerWorkspace, 'Parallel Browser Resource owner workspace is missing')
      const rootId = projectFilesWorkspaceId(ownerWorkspace)
      const createRunningResource = async (name: string, url: string) => {
        const created = await jsonFetch<BrowserResource>(page, '/api/browsers', {
          method: 'POST',
          body: {
            agentId: parallelOwnerId,
            desktopAdapterId,
            name,
            rootId,
            source: 'desktop',
            url,
          },
        })
        return jsonFetch<BrowserResource>(page, `/api/browsers/${created.id}/start`, {
          method: 'POST',
        })
      }
      const [firstRunning, secondRunning] = await Promise.all([
        createRunningResource('Parallel home 7F3A', targetUrl),
        createRunningResource('Parallel popup 7F3A', `${targetUrl}popup`),
      ])
      await jsonFetch(page, `/api/browsers/${firstRunning.id}/navigate`, {
        method: 'POST',
        body: { url: `${targetUrl}step-one` },
      })
      const isolated = await poll(
        () => browserResources(page),
        resources => {
          const running = resources.filter(resource => (
            resource.ownerAgentId === parallelOwnerId && resource.status === 'running'
          ))
          return running.some(resource => (
            resource.id === firstRunning.id && resource.url?.includes('/step-one')
          )) && running.some(resource => (
            resource.id === secondRunning.id && resource.url?.includes('/popup')
          ))
        },
        'Parallel Desktop Browser Resources crossed navigation state',
      )
      const firstIsolated = isolated.find(resource => resource.id === firstRunning.id)
      const secondIsolated = isolated.find(resource => resource.id === secondRunning.id)
      assert.ok(firstIsolated && secondIsolated)
      assert.notEqual(firstIsolated.tabId, secondIsolated.tabId)
      assert.notEqual(firstIsolated.id, secondIsolated.id)
      assert.notEqual(firstIsolated.sessionId, secondIsolated.sessionId)
      fs.writeFileSync(
        path.join(evidenceDir, 'phase-initial-parallel.json'),
        `${JSON.stringify({
          ownerAgentId: parallelOwnerId,
          resources: [firstIsolated, secondIsolated].map(resource => ({
            id: resource.id,
            sessionId: resource.sessionId,
            tabId: resource.tabId,
            url: resource.url,
          })),
        }, null, 2)}\n`,
      )

      await jsonFetch(page, `/api/control/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
      })
      const agentCleanup = await poll(
        () => browserResources(page),
        resources => resources
          .filter(resource => resource.ownerAgentId === agentId)
          .every(resource => resource.status === 'stopped' && resource.tabId === ''),
        'Ending the real Codex Agent did not release all native tabs',
        60_000,
      )
      const cleanedAgentResources = agentCleanup.filter(resource => resource.ownerAgentId === agentId)
      fs.writeFileSync(
        path.join(evidenceDir, 'phase-initial-agent-cleanup.json'),
        `${JSON.stringify({
          agentId,
          resources: cleanedAgentResources.map(resource => ({
            controlEpoch: resource.controlEpoch,
            generation: resource.generation,
            id: resource.id,
            status: resource.status,
            tabId: resource.tabId,
            url: resource.url,
          })),
        }, null, 2)}\n`,
      )

      const cdpPages = await Promise.all(
        browser.contexts().flatMap(context => context.pages()).map(async candidate => ({
          title: await candidate.title().catch(() => ''),
          url: candidate.url(),
        })),
      )
      const result = {
        agentId,
        browserIds: [firstIsolated.id, secondIsolated.id],
        capability: 'desktop',
        cdpPages,
        controlEpochs: {
          agentInitial: beforeHandoff.controlEpoch,
          agentReturned: returned.controlEpoch,
          user: userResource.controlEpoch,
        },
        configuredModel: model.value,
        configuredReasoningEffort: 'low',
        actualModel: String(modelOption.currentValue),
        actualReasoningEffort: String(reasoningOption.currentValue),
        agentCleanup: cleanedAgentResources.map(resource => ({
          controlEpoch: resource.controlEpoch,
          generation: resource.generation,
          id: resource.id,
          status: resource.status,
          tabId: resource.tabId,
          url: resource.url,
        })),
        popupEvidence: {
          acpMarker: true,
          desktop: desktopEvidence,
          resources: [homeResource, popupResource].map(resource => ({
            adapterId: resource.desktopAdapterId,
            id: resource.id,
            tabId: resource.tabId,
            url: resource.url,
          })),
        },
        staleNativeControl,
        parallel: [firstIsolated, secondIsolated].map(resource => ({
          generation: resource.generation,
          id: resource.id,
          sessionGeneration: resource.sessionGeneration,
          sessionId: resource.sessionId,
          tabId: resource.tabId,
          url: resource.url,
        })),
        phase,
        realCodex: true,
      }
      fs.writeFileSync(path.join(evidenceDir, 'phase-initial.json'), `${JSON.stringify(result, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    throw new Error(`Unknown composed Desktop phase: ${phase}`)
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
