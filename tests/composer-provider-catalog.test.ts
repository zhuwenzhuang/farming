import assert from 'node:assert/strict'
import test from 'node:test'
import type { discoverSlashCommands } from '../backend/slash-command-discovery.cjs'
import type { SlashCommandOption, SlashCommandSource } from '../src/components/code/capabilities'
import {
  requestClaudeSettings,
  requestSlashCommands,
} from '../src/components/code/useComposerProviderCatalog'

type DiscoveredSlashCommandSource = Awaited<
  ReturnType<typeof discoverSlashCommands>
>[number]['source']
const slashCommandSourceParity:
  Exclude<DiscoveredSlashCommandSource, SlashCommandSource> extends never ? true : false = true

test('provider metadata requests preserve query encoding and normalize their payloads', async () => {
  assert.equal(slashCommandSourceParity, true)
  const urls: string[] = []
  const pluginCommand = {
    command: 'plugin:pdf',
    label: 'PDF',
    description: 'PDF plugin',
    source: 'plugin',
    scope: 'Plugin',
  } satisfies SlashCommandOption
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
    return { async json() { return { commands: [pluginCommand] } } }
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
  assert.deepEqual(commands, [pluginCommand])
})
