import type { Page } from '@playwright/test'

type MockComputer = {
  id: string
  ownerAgentId: string
  projectRootId: string
  workspace: string
  name: string
  status: 'running' | 'stopped'
  generation: number
  revision: number
  collectionRevision: number
  controlOwner: 'agent' | 'human'
  controlEpoch: number
  needsObserve: boolean
  containerId: string
  containerName: string
  viewerPort: number
  sessionId: string
  error: string
  createdAt: number
  updatedAt: number
}


export function setupComputerRoutes(page: Page, workspace: string) {
  const state = { resource: null as MockComputer | null }
  const routes = {
    async install() {
      // Computer inventory is authoritative on the WebSocket, including reload.
      await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
        const server = socket.connectToServer()
        server.onMessage(payload => {
          const message = JSON.parse(String(payload)) as { type?: string }
          if (message.type === 'computer-resource-snapshot') {
            socket.send(JSON.stringify({
              type: 'computer-resource-snapshot',
              snapshot: {
                collectionRevision: state.resource?.collectionRevision ?? 1,
                resources: state.resource ? [state.resource] : [],
              },
            }))
          } else socket.send(payload)
        })
      })
      await page.route('**/api/browsers/capability', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          available: true,
          browser: { kind: 'chrome', path: '/mock/chrome' },
          message: 'Browser is available',
        }),
      }))
      await page.route('**/api/computers/capability', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          enabled: true,
          dockerAvailable: true,
          imageReady: true,
          image: 'trycua/xfce-cua@sha256:test',
          imageDigest: 'sha256:test',
          driverVersion: '0.12.4',
          compatibilityMode: false,
          error: '',
        }),
      }))
      await page.route('**/api/computers', async route => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON() as { agentId?: string }
          const now = Date.now()
          state.resource = {
            id: 'computer_surface_hierarchy_test',
            ownerAgentId: body.agentId || '',
            projectRootId: 'root_surface_hierarchy_test',
            workspace,
            name: 'Hierarchy Desktop',
            status: 'stopped',
            generation: 0,
            revision: 1,
            collectionRevision: 2,
            controlOwner: 'agent',
            controlEpoch: 0,
            needsObserve: false,
            containerId: '',
            containerName: 'farming-computer-surface-hierarchy',
            viewerPort: 0,
            sessionId: '',
            error: '',
            createdAt: now,
            updatedAt: now,
          }
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.resource) })
          return
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            collectionRevision: state.resource?.collectionRevision ?? 1,
            resources: state.resource ? [state.resource] : [],
          }),
        })
      })
      await page.route('**/api/computers/*/start', async route => {
        if (!state.resource) throw new Error('Start route requires the mock Computer')
        state.resource = {
          ...state.resource,
          status: 'running',
          generation: state.resource.generation + 1,
          revision: state.resource.revision + 1,
          collectionRevision: state.resource.collectionRevision + 1,
          controlEpoch: 1,
          viewerPort: 6901,
          sessionId: 'computer_surface_hierarchy_test-g1',
          updatedAt: Date.now(),
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.resource) })
      })
      await page.route('**/api/computers/*/viewer-config', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          password: 'viewer-test-password',
          viewOnly: state.resource?.controlOwner !== 'human',
          generation: state.resource?.generation ?? 1,
          controlEpoch: state.resource?.controlEpoch ?? 1,
        }),
      }))
      await page.route('**/api/computers/*/control', async route => {
        if (!state.resource) throw new Error('Control route requires the mock Computer')
        const body = route.request().postDataJSON() as { owner?: 'agent' | 'human' }
        state.resource = {
          ...state.resource,
          controlOwner: body.owner === 'human' ? 'human' : 'agent',
          controlEpoch: state.resource.controlEpoch + 1,
          revision: state.resource.revision + 1,
          collectionRevision: state.resource.collectionRevision + 1,
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.resource) })
      })
      await page.route('**/api/computers/*/viewer/vnc.html*', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Mock Computer desktop</title><main>Mock Computer desktop</main>',
      }))
    },
  }
  return { state, routes }
}
