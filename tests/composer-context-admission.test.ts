import assert from 'node:assert/strict'
import test from 'node:test'
import { validateComposerReferences } from '../src/components/code/composer-context-admission'
import { projectFilesWorkspaceId } from '../src/lib/project-workspaces'
import { composerMessageWithContext } from '../src/components/code/composer-message'
import type { Agent } from '../src/types/agent'

const agent = { id: 'fixture', command: 'codex', runtimeBinding: { kind: 'acp' }, runtimeObservation: { kind: 'codex' }, providerSessionProvider: 'codex', cwd: '/workspace', providerCapabilities: { slashCommandDiscovery: true } } as Agent
const file = { id: 'file', kind: 'file' as const, label: 'code.ts', path: 'code.ts', workspace: agent.cwd, rootId: projectFilesWorkspaceId(agent.cwd) }
const skill = { id: 'skill', kind: 'skill' as const, label: 'Review', command: '$review', source: 'Repo', path: '/workspace/.agents/skills/review/SKILL.md' }

test('each dispatch revalidates location access and exact skill identity', async () => {
  let reads = 0
  const readers = {
    locations: async () => { reads++; return { valid: true as const } },
    commands: async () => [{ command: '$review', source: 'skill' as const, label: 'Review', scope: 'Repo', description: '', skillPath: skill.path }],
  }
  await validateComposerReferences(agent, [file, skill], readers)
  await validateComposerReferences(agent, [file, skill], readers)
  assert.equal(reads, 2, 'queue dispatch must not reuse admission-time access')
  await assert.rejects(validateComposerReferences(agent, [{ ...skill, path: '/other/SKILL.md' }], readers), /unavailable or changed/)
  await assert.rejects(validateComposerReferences(agent, [file], { ...readers, locations: async () => { throw new Error('missing file') } }), /missing file/)
  await assert.rejects(validateComposerReferences(agent, [{ ...file, workspace: '/other' }], readers), /different workspace/)
  await validateComposerReferences(agent, [{ ...file, kind: 'selection', text: 'captured' }], { ...readers, locations: async () => { throw new Error('selection should not reread') } })
  const text = composerMessageWithContext('Review this', [skill])
  assert.ok(text.includes(skill.path))
  assert.ok(text.includes('Read that exact SKILL.md'))
})

test('context preparation shares the submission fence across Composer surfaces', async () => {
  const { prepareComposerSubmission } = await import('../src/components/code/composer-submission-state')
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  let sends = 0
  const first = prepareComposerSubmission('shared-agent', () => paused, () => { sends++; return true })
  assert.equal(await prepareComposerSubmission('shared-agent', async () => {}, () => { sends++; return true }), false)
  release()
  assert.equal(await first, true)
  assert.equal(sends, 1)
  await assert.rejects(prepareComposerSubmission('shared-agent', async () => { throw new Error('missing') }, () => { sends++; return true }), /missing/)
  assert.equal(await prepareComposerSubmission('shared-agent', async () => {}, () => true), true)
  assert.equal(sends, 1)
})


test('chat quote snapshots need no filesystem or provider catalog lookup', async () => {
  await validateComposerReferences(agent, [{ id: 'quote', kind: 'quote', label: 'Quote', text: 'captured answer' }], {
    locations: async () => { throw new Error('Unexpected filesystem read') },
    commands: async () => { throw new Error('Unexpected catalog read') },
  })
})

test('pasted documents require no workspace path or provider catalog', async () => {
  await validateComposerReferences(agent, [{ id: 'paste', kind: 'pasted-text', label: 'Document', text: 'x'.repeat(1001) }], {
    locations: async () => { throw new Error('Unexpected filesystem read') },
    commands: async () => { throw new Error('Unexpected catalog read') },
  })
})
