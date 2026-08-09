import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ComposerProviderCatalogLifecycle,
  requestClaudeSettings,
  requestSlashCommands,
  type ComposerProviderCatalogPorts,
} from '../src/components/code/useComposerProviderCatalogController'
import { DEFAULT_CLAUDE_SETTINGS, type ClaudeSettingsSummary } from '../src/components/code/composer-profile'
import type { SlashCommandOption } from '../src/components/code/capabilities'

const command = (name: string): SlashCommandOption => ({
  command: name,
  label: name,
  description: name,
  source: 'codex',
})

const settings = (effectiveModel: string): ClaudeSettingsSummary => ({
  ...DEFAULT_CLAUDE_SETTINGS,
  available: true,
  effectiveModel,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function createHarness() {
  const claudeRequests: Array<{ homeId: string; deferred: ReturnType<typeof deferred<ClaudeSettingsSummary>> }> = []
  const slashRequests: Array<{
    provider: string
    homeId: string
    workspace?: string
    deferred: ReturnType<typeof deferred<SlashCommandOption[]>>
  }> = []
  const publishedSettings: ClaudeSettingsSummary[] = []
  const publishedCommands: SlashCommandOption[][] = []
  const ports: ComposerProviderCatalogPorts = {
    fetchClaudeSettings: homeId => {
      const pending = deferred<ClaudeSettingsSummary>()
      claudeRequests.push({ homeId, deferred: pending })
      return pending.promise
    },
    fetchSlashCommands: (provider, homeId, workspace) => {
      const pending = deferred<SlashCommandOption[]>()
      slashRequests.push({ provider, homeId, workspace, deferred: pending })
      return pending.promise
    },
    publishClaudeSettings: next => publishedSettings.push(next),
    publishSlashCommands: next => publishedCommands.push(next),
  }
  return {
    lifecycle: new ComposerProviderCatalogLifecycle(ports),
    claudeRequests,
    slashRequests,
    publishedSettings,
    publishedCommands,
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('provider metadata requests preserve query encoding and normalize their payloads', async () => {
  const urls: string[] = []
  const claude = await requestClaudeSettings('home /one', async url => {
    urls.push(url)
    return {
      async json() {
        return {
          settings: {
            available: true,
            effectiveModel: ' opus ',
            effectiveEffort: 'high',
            modelOptions: [],
            effortOptions: [],
          },
        }
      },
    }
  })
  const commands = await requestSlashCommands('codex', 'home /one', '/repo path', async url => {
    urls.push(url)
    return { async json() { return { commands: [command('/review')] } } }
  })
  await requestSlashCommands('claude', 'default', undefined, async url => {
    urls.push(url)
    return { async json() { return { commands: [] } } }
  })

  assert.deepEqual(urls, [
    '/api/claude/settings?homeId=home+%2Fone',
    '/api/slash-commands?provider=codex&homeId=home+%2Fone&workspace=%2Frepo+path',
    '/api/slash-commands?provider=claude&homeId=default',
  ])
  assert.equal(claude.effectiveModel, 'opus')
  assert.equal(claude.available, true)
  assert.deepEqual(commands, [command('/review')])
})

test('Claude settings are requested only for the Claude provider and published normalized', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'default' })
  assert.deepEqual(harness.claudeRequests.map(request => request.homeId), ['default'])
  assert.deepEqual(harness.publishedSettings, [])

  harness.claudeRequests[0]!.deferred.resolve(settings('opus'))
  await settle()
  assert.deepEqual(harness.publishedSettings, [settings('opus')])
})

test('a non-Claude provider resolves the default settings without a request', () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'default' })
  assert.equal(harness.claudeRequests.length, 0)
  assert.deepEqual(harness.publishedSettings, [DEFAULT_CLAUDE_SETTINGS])
})

test('a failed Claude settings read falls back to the default settings', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'default' })
  harness.claudeRequests[0]!.deferred.reject(new Error('offline'))
  await settle()
  assert.deepEqual(harness.publishedSettings, [DEFAULT_CLAUDE_SETTINGS])
})

test('slash commands are requested for Codex and Claude and cleared for every other kind', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'home-a', workspace: '/repo' })
  assert.deepEqual(harness.slashRequests.map(request => [request.provider, request.homeId, request.workspace]), [
    ['codex', 'home-a', '/repo'],
  ])
  harness.slashRequests[0]!.deferred.resolve([command('/review')])
  await settle()
  assert.deepEqual(harness.publishedCommands, [[command('/review')]])

  harness.lifecycle.sync({ providerKind: 'shell', homeId: 'home-a' })
  assert.equal(harness.slashRequests.length, 1)
  assert.deepEqual(harness.publishedCommands.at(-1), [])
})

test('a missing workspace is omitted from the slash command request', () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a' })
  assert.equal(harness.slashRequests[0]!.workspace, undefined)
})

test('a failed slash command read clears the discovered commands', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'home-a' })
  harness.slashRequests[0]!.deferred.reject(new Error('offline'))
  await settle()
  assert.deepEqual(harness.publishedCommands, [[]])
})

test('a home switch fences the previous responses for both reads', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a' })
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-b' })

  harness.claudeRequests[0]!.deferred.resolve(settings('stale'))
  harness.slashRequests[0]!.deferred.resolve([command('/stale')])
  harness.claudeRequests[1]!.deferred.resolve(settings('fresh'))
  harness.slashRequests[1]!.deferred.resolve([command('/fresh')])
  await settle()

  assert.deepEqual(harness.publishedSettings, [settings('fresh')])
  assert.deepEqual(harness.publishedCommands, [[command('/fresh')]])
})

test('a stale failure cannot overwrite the newest target metadata', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a', workspace: '/repo-a' })
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-b', workspace: '/repo-b' })

  harness.claudeRequests[1]!.deferred.resolve(settings('fresh'))
  harness.slashRequests[1]!.deferred.resolve([command('/fresh')])
  await settle()
  harness.claudeRequests[0]!.deferred.reject(new Error('too late'))
  harness.slashRequests[0]!.deferred.reject(new Error('too late'))
  await settle()

  assert.deepEqual(harness.publishedSettings, [settings('fresh')])
  assert.deepEqual(harness.publishedCommands, [[command('/fresh')]])
})

test('rapid workspace switching only admits the newest request', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'home-a', workspace: '/one' })
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'home-a', workspace: '/two' })
  harness.lifecycle.sync({ providerKind: 'codex', homeId: 'home-b', workspace: '/three' })

  harness.slashRequests.forEach((request, index) => request.deferred.resolve([command(`/${index}`)]))
  await settle()
  assert.deepEqual(harness.publishedCommands, [[command('/2')]])
})

test('workspace switching does not restart the home-scoped Claude settings request', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a', workspace: '/one' })
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a', workspace: '/two' })

  assert.equal(harness.claudeRequests.length, 1)
  assert.equal(harness.slashRequests.length, 2)
  harness.claudeRequests[0]!.deferred.resolve(settings('same-home'))
  harness.slashRequests[0]!.deferred.resolve([command('/stale')])
  harness.slashRequests[1]!.deferred.resolve([command('/fresh')])
  await settle()
  assert.deepEqual(harness.publishedSettings, [settings('same-home')])
  assert.deepEqual(harness.publishedCommands, [[command('/fresh')]])
})

test('dispose rejects both in-flight provider metadata responses', async () => {
  const harness = createHarness()
  harness.lifecycle.sync({ providerKind: 'claude', homeId: 'home-a' })
  harness.lifecycle.dispose()
  harness.claudeRequests[0]!.deferred.resolve(settings('late'))
  harness.slashRequests[0]!.deferred.resolve([command('/late')])
  await settle()
  assert.deepEqual(harness.publishedSettings, [])
  assert.deepEqual(harness.publishedCommands, [])
})
