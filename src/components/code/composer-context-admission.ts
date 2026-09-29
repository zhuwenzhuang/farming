import type { Agent } from '@/types/agent'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { validateWorkspaceContext } from '@/lib/workspace-files'
import { capabilitiesForAgent } from './capabilities'
import type { ComposerContextReference } from './composer-message'
import { requestSlashCommands } from './useComposerProviderCatalog'

/** Fresh read immediately before each dispatch, including queued sends. A
 * failed read preserves the complete message; it never falls back to prose. */
export async function validateComposerReferences(agent: Agent, references: ComposerContextReference[],
  readers = { locations: validateWorkspaceContext, commands: requestSlashCommands }) {
  if (!references.length) return
  if (references.length > 64) throw new Error('Too many context references. Remove some before sending.')
  const locations: Array<{ path: string; kind: 'file' | 'directory' }> = []
  for (const reference of references) {
    if (reference.kind === 'document') {
      if (reference.status !== 'ready' || !reference.text || !reference.path) throw new Error(`Attachment is not ready: ${reference.label}`)
      continue
    }
    if (reference.kind === 'skill' || (reference.kind === 'pasted-text')) continue
    if (reference.workspace !== agent.cwd || reference.rootId !== projectFilesWorkspaceId(agent.cwd)
      || !reference.path || reference.path.startsWith('/') || reference.path.split('/').includes('..')) {
      throw new Error(`Context belongs to a different workspace: ${reference.label}`)
    }
    // Selections intentionally retain captured text after the source changes.
    if (reference.kind !== 'selection') locations.push({ path: reference.path, kind: reference.kind })
  }
  const skills = references.filter(reference => reference.kind === 'skill')
  await Promise.all([
    locations.length ? readers.locations(projectFilesWorkspaceId(agent.cwd), locations, AbortSignal.timeout(8000)) : undefined,
    skills.length ? (async () => {
      if (!agent.providerCapabilities?.slashCommandDiscovery) throw new Error('Skills are unavailable for this Agent.')
      const commands = await readers.commands(capabilitiesForAgent(agent).kind || '', agent.providerHomeId || 'default', agent.cwd)
      for (const skill of skills) {
        if (!skill.path || !commands.some(command => command.source === 'skill' && command.command === skill.command
          && command.scope === skill.source && command.skillPath === skill.path)) {
          throw new Error(`Skill is unavailable or changed: ${skill.label}. Remove it and select it again.`)
        }
      }
    })() : undefined,
  ])
}
