import type { FormEvent } from 'react'
import { useState } from 'react'
import type { CodeCopy } from '../code/copy'
import type {
  LanguageNavigatorDirection,
  LanguageNavigatorNode,
  LanguageNavigatorState,
} from './useLanguageServerController'

function LanguageNode({
  node,
  depth,
  expandable,
  onToggle,
  onOpen,
}: {
  node: LanguageNavigatorNode
  depth: number
  expandable: boolean
  onToggle: (node: LanguageNavigatorNode) => void
  onOpen: (node: LanguageNavigatorNode) => void
}) {
  return <li>
    <div className="code-language-server-node" style={{ paddingLeft: `${8 + depth * 16}px` }}>
      {expandable ? (
        <button type="button" className="code-language-server-expand" aria-label={node.expanded ? 'Collapse' : 'Expand'} onClick={() => onToggle(node)}>
          {node.loading ? '…' : node.expanded ? '⌄' : '›'}
        </button>
      ) : <span className="code-language-server-expand" />}
      <button type="button" className="code-language-server-location" onClick={() => onOpen(node)}>
        <strong>{node.name}</strong>
        <span>{node.detail || node.path}</span>
        <small>{node.path}:{node.lineNumber}</small>
      </button>
    </div>
    {node.error ? <div className="code-language-server-node-error">{node.error}</div> : null}
    {node.expanded && node.children?.length ? (
      <ul>{node.children.map(child => <LanguageNode key={child.key} node={child} depth={depth + 1} expandable={expandable} onToggle={onToggle} onOpen={onOpen} />)}</ul>
    ) : null}
  </li>
}

export function LanguageServerPanel({
  state,
  copy,
  onClose,
  onDirection,
  onToggleNode,
  onOpenNode,
  onSearch,
}: {
  state: LanguageNavigatorState
  copy: CodeCopy
  onClose: () => void
  onDirection: (direction: LanguageNavigatorDirection) => void
  onToggleNode: (node: LanguageNavigatorNode) => void
  onOpenNode: (node: LanguageNavigatorNode) => void
  onSearch: (query: string) => void
}) {
  const [query, setQuery] = useState(state.query)
  const title = state.mode === 'call' ? copy.callHierarchy
    : state.mode === 'type' ? copy.typeHierarchy
      : state.mode === 'document' ? copy.documentSymbols
        : copy.workspaceSymbols
  const expandable = state.mode === 'call' || state.mode === 'type'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSearch(query.trim())
  }

  return <aside className="code-language-server-panel" data-testid="code-language-server-panel" aria-label={title}>
    <header>
      <strong>{title}</strong>
      <button type="button" aria-label={copy.close} title={copy.close} onClick={onClose}>×</button>
    </header>
    {state.mode === 'call' ? <div className="code-language-server-directions">
      <button type="button" className={state.direction === 'incoming' ? 'active' : ''} onClick={() => onDirection('incoming')}>{copy.incomingCalls}</button>
      <button type="button" className={state.direction === 'outgoing' ? 'active' : ''} onClick={() => onDirection('outgoing')}>{copy.outgoingCalls}</button>
    </div> : null}
    {state.mode === 'type' ? <div className="code-language-server-directions">
      <button type="button" className={state.direction === 'supertypes' ? 'active' : ''} onClick={() => onDirection('supertypes')}>{copy.supertypes}</button>
      <button type="button" className={state.direction === 'subtypes' ? 'active' : ''} onClick={() => onDirection('subtypes')}>{copy.subtypes}</button>
    </div> : null}
    {state.mode === 'workspace' ? <form className="code-language-server-search" onSubmit={submit}>
      <input value={query} autoFocus aria-label={copy.languageServerSearchSymbols} placeholder={copy.languageServerSearchSymbols} onChange={event => setQuery(event.target.value)} />
      <button type="submit">{copy.search}</button>
    </form> : null}
    <div className="code-language-server-results">
      {state.loading ? <p>{copy.loading}</p> : state.error ? <p className="error">{state.error}</p> : state.nodes.length === 0 ? <p>{copy.languageServerNoResults}</p> : (
        <ul>{state.nodes.map(node => <LanguageNode key={node.key} node={node} depth={0} expandable={expandable} onToggle={onToggleNode} onOpen={onOpenNode} />)}</ul>
      )}
    </div>
  </aside>
}
