import type { Agent } from '@/types/agent'
import {
  agentSessionId,
  compactPath,
  formatAgentSessionWorkspace,
  projectWorkspaceForAgent,
} from './model'
import { buildAgentRowDisplayState } from './agent-row-state'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'

interface SearchPanelProps {
  displayedProjects: ProjectGroup[]
  hasQuery: boolean
  resultCount: number
  selectedAgentId: string | null
  selectedSessionHandle: string | null
  onOpenAgent: (agentId: string) => void
  onOpenSession: (session: AgentSessionHistoryItem) => void
  copy: CodeCopy
}

export function SearchPanel({
  displayedProjects,
  hasQuery,
  resultCount,
  selectedAgentId,
  selectedSessionHandle,
  onOpenAgent,
  onOpenSession,
  copy,
}: SearchPanelProps) {
  return (
    <div className="code-search-panel" data-testid="code-search-panel">
      <div className="code-search-panel-header">
        <h2>{copy.search}</h2>
        <span>{hasQuery ? copy.resultsCount(resultCount) : copy.searchHint}</span>
      </div>
      {!hasQuery ? (
        <div className="code-empty-workspace" data-testid="code-search-empty">
          <h2>{copy.searchEmptyTitle}</h2>
          <p>{copy.searchEmptyDescription}</p>
        </div>
      ) : resultCount === 0 ? (
        <div className="code-empty-workspace">
          <h2>{copy.noMatchingAgents}</h2>
          <p>{copy.searchHint}</p>
        </div>
      ) : (
        <div className="code-search-results">
          {displayedProjects.map(project => (
            <section key={project.id} className="code-search-result-group">
              <h3>{project.name}</h3>
              {project.agents.map(agent => (
                <AgentSearchResult
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onOpen={() => onOpenAgent(agent.id)}
                />
              ))}
              {project.agentSessions.map(session => {
                const sessionHandle = agentSessionId(session)
                return (
                  <button
                    key={sessionHandle}
                    type="button"
                    className={`code-search-result code-session-result ${sessionHandle === selectedSessionHandle ? 'active' : ''}`}
                    data-testid="code-session-search-result"
                    onClick={() => onOpenSession(session)}
                  >
                    <span className="code-search-result-copy">
                      <strong>{session.title || copy.sessionFallbackTitle(session.providerName)}</strong>
                      <span>{formatAgentSessionWorkspace(session)}</span>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentSearchResult({
  agent,
  selected,
  onOpen,
}: {
  agent: Agent
  selected: boolean
  onOpen: () => void
}) {
  const rowState = buildAgentRowDisplayState({ kind: 'agent', agent })

  return (
    <button
      type="button"
      className={`code-search-result ${rowState.statusIndicatorVisible ? '' : 'no-status'} ${selected ? 'active' : ''}`}
      data-testid="code-search-result"
      onClick={onOpen}
    >
      {rowState.statusIndicatorVisible && (
        <span className={`code-agent-dot ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} />
      )}
      <span className="code-search-result-copy">
        <strong>{rowState.title}</strong>
        <span>{compactPath(projectWorkspaceForAgent(agent))}</span>
      </span>
    </button>
  )
}
