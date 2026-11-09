import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Link, PhrasingContent, Root, RootContent } from 'mdast'
import type { Plugin } from 'unified'
import type { NativeAgentReference } from './acp/acp-entry-projection'
import type { CodeCopy } from './copy'
import { RelatedSessionNavigation } from './related-session-navigation'
import { relatedSessionIndicator, relatedSessionStatusLabel } from './related-session-status'
import { AgentStatusIndicator } from './AgentStatusIndicator'

function indexReferences(references: NativeAgentReference[]) {
  const aliases = new Map<string, NativeAgentReference | null>()
  for (const child of references) {
    for (const alias of [child.title, child.name]) {
      if (!alias || alias.length > 256) continue
      if (!aliases.has(alias)) aliases.set(alias, child)
      else if (aliases.get(alias)?.sessionId !== child.sessionId) aliases.set(alias, null)
    }
  }
  for (const child of references) aliases.set(child.sessionId, child)
  const names = [...aliases.keys()].filter(key => aliases.get(key)).sort((a, b) => b.length - a.length)
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return { aliases, matcher: pattern ? new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, 'gu') : null }
}

const AgentLinks = createContext<{ index: ReturnType<typeof indexReferences>; agentId: string; epoch: string; copy: CodeCopy; live: boolean } | null>(null)
const EMPTY: NativeAgentReference[] = []

export function TranscriptAgentLinks({ references = EMPTY, agentId, epoch = '', copy, live, children }: {
  references?: NativeAgentReference[]; agentId: string; epoch?: string; copy: CodeCopy; live: boolean; children: ReactNode
}) {
  const index = useMemo(() => indexReferences(references), [references])
  const value = useMemo(() => ({ index, agentId, epoch, copy, live }), [index, agentId, epoch, copy, live])
  return <AgentLinks.Provider value={references.length ? value : null}>{children}</AgentLinks.Provider>
}

export function useAgentLinkIndex() {
  return useContext(AgentLinks)?.index
}

export function TranscriptAgentLink({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const links = useContext(AgentLinks)
  const navigate = useContext(RelatedSessionNavigation)
  const child = links?.index.aliases.get(sessionId)
  if (!links || !child || !navigate) return <>{children}</>
  const state = links.live ? child.state : 'unknown'
  const status = relatedSessionStatusLabel(state, links.copy)
  return <button type="button" className="code-agent-transcript-file-link" data-agent-reference={sessionId}
    title={`${child.title} · ${status}`}
    onClick={() => navigate({ parentAgentId: links.agentId, sessionId, title: child.title, runtimeEpoch: links.epoch, readable: true })}>
    {children}<AgentStatusIndicator decorative className="code-agent-dot" state={relatedSessionIndicator(sessionId, state, links.copy)} />
  </button>
}

// Transform only assistant prose and exact inline-code identifiers. Existing
// Markdown links, fenced code, and ambiguous display names retain their meaning.
export const remarkAgentLinks: Plugin<[ReturnType<typeof indexReferences> | undefined], Root> = index => tree => {
  const pattern = index?.matcher
  if (!index || !pattern) return
  const { aliases } = index
  function link(label: string, child: NativeAgentReference): Link {
    return { type: 'link', url: '#', data: { hProperties: { 'data-agent-reference': child.sessionId } },
      children: [{ type: 'text', value: label }] }
  }
  const visit = (node: Root | RootContent) => {
    if (!('children' in node) || node.type === 'link' || node.type === 'linkReference') return
    for (let i = 0; i < node.children.length; i++) {
      const item = node.children[i]
      if (!item) continue
      const parts: PhrasingContent[] = []
      if (item.type === 'inlineCode') {
        const child = aliases.get(item.value)
        if (child) parts.push(link(item.value, child))
      } else if (item.type === 'text') {
        let offset = 0
        for (const match of item.value.matchAll(pattern)) {
          if (match.index > offset) parts.push({ type: 'text', value: item.value.slice(offset, match.index) })
          parts.push(link(match[0], aliases.get(match[0])!))
          offset = match.index + match[0].length
        }
        if (offset && offset < item.value.length) parts.push({ type: 'text', value: item.value.slice(offset) })
      } else visit(item)
      if (parts.length) {
        (node.children as RootContent[]).splice(i, 1, ...parts)
        i += parts.length - 1
      }
    }
  }
  visit(tree)
}
