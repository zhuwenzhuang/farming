import type { FormEvent, KeyboardEvent } from 'react'
import { useEffect, useState } from 'react'
import { ChevronDownGlyph, ChevronRightGlyph, CloseGlyph, LoadingGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../code/copy'
import type {
  LanguageNavigatorDirection,
  LanguageNavigatorNode,
  LanguageNavigatorState,
} from './useLanguageServerController'
import { languageNavigatorLocationLabel } from './language-navigator-tree'

function symbolKindPresentation(kind: number) {
  if (kind === 5) return { label: 'C', className: 'class' }
  if (kind === 11) return { label: 'I', className: 'interface' }
  if (kind === 6 || kind === 9 || kind === 12) return { label: 'ƒ', className: 'function' }
  if (kind === 7 || kind === 8 || kind === 10) return { label: 'p', className: 'property' }
  if (kind === 13 || kind === 14) return { label: 'v', className: 'variable' }
  return { label: '·', className: 'symbol' }
}

function LanguageNode({
  node,
  depth,
  lazyHierarchy,
  copy,
  focusedKey,
  onFocus,
  onToggle,
  onOpen,
}: {
  node: LanguageNavigatorNode
  depth: number
  lazyHierarchy: boolean
  copy: CodeCopy
  focusedKey: string
  onFocus: (key: string) => void
  onToggle: (node: LanguageNavigatorNode) => void
  onOpen: (node: LanguageNavigatorNode) => void
}) {
  const kind = symbolKindPresentation(node.kind)
  const loadedEmpty = node.children !== undefined && node.children.length === 0
  const expanded = Boolean(node.expanded)
  const canToggle = lazyHierarchy || Boolean(node.children?.length)
  const statusPadding = '38px'
  const locationLabel = languageNavigatorLocationLabel(node.path, node.lineNumber)
  return <li>
    <div
      className={`code-language-server-node ${depth === 0 ? 'root' : ''}`}
      style={{ paddingLeft: '8px' }}
      role="treeitem"
      data-node-key={node.key}
      data-node-depth={depth}
      tabIndex={node.key === focusedKey ? 0 : -1}
      aria-label={`${node.name}${node.detail ? `, ${node.detail}` : ''}, ${locationLabel}`}
      aria-selected={node.key === focusedKey}
      aria-expanded={canToggle ? expanded : undefined}
      aria-busy={node.loading || undefined}
      onFocus={() => onFocus(node.key)}
    >
      {canToggle ? (
        <button
          type="button"
          tabIndex={-1}
          className="code-language-server-expand"
          aria-label={expanded ? copy.collapseHierarchyNode(node.name) : copy.expandHierarchyNode(node.name)}
          title={expanded ? copy.collapseHierarchyNode(node.name) : copy.expandHierarchyNode(node.name)}
          onClick={event => {
            event.currentTarget.parentElement?.focus()
            onToggle(node)
          }}
        >
          {node.loading ? <LoadingGlyph className="code-language-server-loading-glyph" />
            : expanded ? <ChevronDownGlyph /> : <ChevronRightGlyph />}
        </button>
      ) : <span className="code-language-server-expand" />}
      <button
        type="button"
        tabIndex={-1}
        className="code-language-server-location"
        title={`${node.name}${node.detail ? ` : ${node.detail}` : ''}\n${node.path}:${node.lineNumber}`}
        onClick={event => {
          event.currentTarget.parentElement?.focus()
          onOpen(node)
        }}
      >
        <span className={`code-language-server-symbol-kind ${kind.className}`} aria-hidden="true">{kind.label}</span>
        <span className="code-language-server-node-content">
          <span className="code-language-server-node-title">
            <strong>{node.name}</strong>
            {node.detail ? <span>{node.detail}</span> : null}
            {lazyHierarchy && depth === 0 ? <em>{copy.hierarchyRoot}</em> : null}
          </span>
          <small>{locationLabel}</small>
        </span>
      </button>
    </div>
    {lazyHierarchy && node.loading && expanded ? (
      <div className="code-language-server-node-state" style={{ paddingLeft: statusPadding }}>{copy.hierarchyLoadingChildren}</div>
    ) : null}
    {lazyHierarchy && node.error ? (
      <div className="code-language-server-node-error" style={{ paddingLeft: statusPadding }}>
        <span>{node.error}</span>
        <button type="button" onClick={() => onToggle(node)}>{copy.retry}</button>
      </div>
    ) : null}
    {lazyHierarchy && !node.loading && !node.error && expanded && loadedEmpty ? (
      <div className="code-language-server-node-state empty" style={{ paddingLeft: statusPadding }}>{copy.hierarchyNoChildren}</div>
    ) : null}
    {node.expanded && node.children?.length ? (
      <ul role="group">{node.children.map(child => (
        <LanguageNode
          key={child.key}
          node={child}
          depth={depth + 1}
          lazyHierarchy={lazyHierarchy}
          copy={copy}
          focusedKey={focusedKey}
          onFocus={onFocus}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}</ul>
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
  const [focusedKey, setFocusedKey] = useState('')
  const title = state.mode === 'call' ? copy.callHierarchy
    : state.mode === 'type' ? copy.typeHierarchy
      : state.mode === 'document' ? copy.documentSymbols
        : state.mode === 'workspace' ? copy.workspaceSymbols
          : state.mode === 'definition' ? copy.goToDefinition
            : state.mode === 'references' ? copy.findReferences
              : copy.goToImplementation
  const lazyHierarchy = state.mode === 'call' || state.mode === 'type'
  useEffect(() => {
    setQuery(state.query)
  }, [state.mode, state.query, state.source?.generation])
  useEffect(() => {
    const includesKey = (nodes: LanguageNavigatorNode[], key: string): boolean => nodes.some(node => (
      node.key === key || Boolean(node.children?.length && includesKey(node.children, key))
    ))
    setFocusedKey(current => current && includesKey(state.nodes, current) ? current : state.nodes[0]?.key || '')
  }, [state.nodes])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const normalizedQuery = query.trim()
    if (normalizedQuery) onSearch(normalizedQuery)
  }
  const handleTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
    if (!current || !event.currentTarget.contains(current)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const index = items.indexOf(current)
    if (index < 0) return
    const currentDepth = Number(current.dataset.nodeDepth || 0)
    const focusItem = (item: HTMLElement | undefined) => {
      if (!item) return
      setFocusedKey(item.dataset.nodeKey || '')
      item.focus()
    }
    if (event.key === 'ArrowDown') focusItem(items[index + 1])
    else if (event.key === 'ArrowUp') focusItem(items[index - 1])
    else if (event.key === 'Home') focusItem(items[0])
    else if (event.key === 'End') focusItem(items[items.length - 1])
    else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'false') {
        current.querySelector<HTMLButtonElement>('.code-language-server-expand')?.click()
      }
      else if (current.getAttribute('aria-expanded') === 'true') {
        const next = items[index + 1]
        if (next && Number(next.dataset.nodeDepth || 0) > currentDepth) focusItem(next)
      }
    }
    else if (event.key === 'ArrowLeft') {
      if (current.getAttribute('aria-expanded') === 'true') {
        current.querySelector<HTMLButtonElement>('.code-language-server-expand')?.click()
      }
      else {
        for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
          const candidate = items[parentIndex]
          if (candidate && Number(candidate.dataset.nodeDepth || 0) < currentDepth) {
            focusItem(candidate)
            break
          }
        }
      }
    }
    else if (event.key === 'Enter') {
      current.querySelector<HTMLButtonElement>('.code-language-server-location')?.click()
    }
    else if (event.key === ' ' && current.hasAttribute('aria-expanded')) {
      current.querySelector<HTMLButtonElement>('.code-language-server-expand')?.click()
    }
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return <aside className="code-language-server-panel" data-testid="code-language-server-panel" aria-label={title}>
    <header>
      <strong>{title}</strong>
      <button type="button" aria-label={copy.close} title={copy.close} onClick={onClose}><CloseGlyph /></button>
    </header>
    {state.mode === 'call' ? <div className="code-language-server-directions">
      <button type="button" aria-pressed={state.direction === 'incoming'} className={state.direction === 'incoming' ? 'active' : ''} onClick={() => onDirection('incoming')}>{copy.incomingCalls}</button>
      <button type="button" aria-pressed={state.direction === 'outgoing'} className={state.direction === 'outgoing' ? 'active' : ''} onClick={() => onDirection('outgoing')}>{copy.outgoingCalls}</button>
    </div> : null}
    {state.mode === 'type' ? <div className="code-language-server-directions">
      <button type="button" aria-pressed={state.direction === 'supertypes'} className={state.direction === 'supertypes' ? 'active' : ''} onClick={() => onDirection('supertypes')}>{copy.supertypes}</button>
      <button type="button" aria-pressed={state.direction === 'subtypes'} className={state.direction === 'subtypes' ? 'active' : ''} onClick={() => onDirection('subtypes')}>{copy.subtypes}</button>
    </div> : null}
    {state.mode === 'workspace' ? <form className="code-language-server-search" onSubmit={submit}>
      <input
        type="search"
        value={query}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        aria-label={copy.languageServerSearchSymbols}
        placeholder={copy.languageServerSearchSymbols}
        onChange={event => {
          const value = event.target.value
          setQuery(value)
          if (!value.trim() && state.searched) onSearch('')
        }}
      />
      <button type="submit" disabled={!query.trim() || state.loading}>{copy.search}</button>
    </form> : null}
    <div className="code-language-server-results">
      {state.loading ? <p>{copy.loading}</p>
        : state.error ? <p className="error">{state.error}</p>
          : state.mode === 'workspace' && !state.searched ? <p>{copy.languageServerSearchPrompt}</p>
            : state.nodes.length === 0 ? <p>{copy.languageServerNoResults}</p> : (
        <>
          <ul role="tree" onKeyDown={handleTreeKeyDown}>{state.nodes.map(node => (
            <LanguageNode
              key={node.key}
              node={node}
              depth={0}
              lazyHierarchy={lazyHierarchy}
              copy={copy}
              focusedKey={focusedKey}
              onFocus={setFocusedKey}
              onToggle={onToggleNode}
              onOpen={onOpenNode}
            />
          ))}</ul>
          {state.truncated ? <p className="code-language-server-truncated">{copy.languageServerResultsTruncated(500)}</p> : null}
        </>
      )}
    </div>
  </aside>
}
