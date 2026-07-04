import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { agentTitle, formatRelativeAge } from '@/lib/format'
import { formatWorkspaceForDisplay } from '@/lib/workspace-options'
import {
  agentSessionId,
  agentSessionUpdatedAt,
  effortLabel,
  formatAgentSessionWorkspace,
  projectWorkspaceForAgent,
} from './model'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem } from './types'

type HistoryAgentItem =
  | { kind: 'run'; historyKey: string; updatedAt: number; entry: TaskHistoryEntry }
  | { kind: 'agent'; historyKey: string; updatedAt: number; agent: Agent }
  | { kind: 'session'; historyKey: string; updatedAt: number; session: AgentSessionHistoryItem }

interface HistoryPanelProps {
  archivedRuns: TaskHistoryEntry[]
  archivedAgents: Agent[]
  agentSessions: AgentSessionHistoryItem[]
  now: number
  onResumeSession: (provider: string, sessionId: string) => void
  onContinueRun: (entry: TaskHistoryEntry) => void
  onOpenArchivedAgent: (agentId: string) => void
  onRestoreArchivedAgent: (agentId: string) => void
  copy: CodeCopy
}

function compactHistoryId(id: string) {
  const value = String(id || '').trim()
  if (!value) return ''
  if (value.length <= 16) return value
  return `${value.slice(0, 6)}...${value.slice(-6)}`
}

function historySessionIdentity(session: AgentSessionHistoryItem) {
  const provider = session.provider || 'agent'
  const id = compactHistoryId(session.id)
  if (!id) return null
  return {
    label: `resume ${provider}:${id}`,
    title: `resume ${provider}:${session.id}`,
  }
}

function resumedIdentityFromAgentSource(source?: string) {
  const match = /^([a-z]+)-history(?:-fork)?:(.+)$/.exec(source || '')
  if (!match) return null
  const provider = match[1]
  const sessionId = match[2]
  if (!provider || !sessionId) return null
  return {
    label: `resume ${provider}:${compactHistoryId(sessionId)}`,
    title: `resume ${provider}:${sessionId}`,
  }
}

function historyAgentIdentity(agent: Agent) {
  return resumedIdentityFromAgentSource(agent.source) ?? {
    label: `run ${compactHistoryId(agent.id)}`,
    title: `run ${agent.id}`,
  }
}

function historyRunTitle(entry: TaskHistoryEntry) {
  return entry.title || entry.task || entry.command || 'History agent'
}

function historyRunWorkspace(entry: TaskHistoryEntry) {
  return entry.projectWorkspace || entry.cwd || ''
}

function historyRunIdentity(entry: TaskHistoryEntry) {
  const resumed = resumedIdentityFromAgentSource(entry.source)
  if (resumed) return resumed
  return {
    label: `run ${compactHistoryId(entry.agentId || entry.id)}`,
    title: `run ${entry.agentId || entry.id}`,
  }
}

function historyRunUpdatedAt(entry: TaskHistoryEntry) {
  return Math.max(entry.archivedAt || 0, entry.lastActivity || 0, entry.startedAt || 0)
}

function historyAgentUpdatedAt(agent: Agent) {
  return Math.max(agent.archivedAt || 0, agent.lastActivity || 0, agent.startedAt || 0)
}

function buildHistoryAgentItems(
  archivedRuns: TaskHistoryEntry[],
  archivedAgents: Agent[],
  agentSessions: AgentSessionHistoryItem[]
): HistoryAgentItem[] {
  return [
    ...archivedRuns.map(entry => ({
      kind: 'run' as const,
      historyKey: `run:${entry.id}`,
      updatedAt: historyRunUpdatedAt(entry),
      entry,
    })),
    ...archivedAgents.map(agent => ({
      kind: 'agent' as const,
      historyKey: `agent:${agent.id}`,
      updatedAt: historyAgentUpdatedAt(agent),
      agent,
    })),
    ...agentSessions.map(session => ({
      kind: 'session' as const,
      historyKey: agentSessionId(session),
      updatedAt: agentSessionUpdatedAt(session),
      session,
    })),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function HistoryPanel({
  archivedRuns,
  archivedAgents,
  agentSessions,
  now,
  onResumeSession,
  onContinueRun,
  onOpenArchivedAgent,
  onRestoreArchivedAgent,
  copy,
}: HistoryPanelProps) {
  const historyAgents = buildHistoryAgentItems(archivedRuns, archivedAgents, agentSessions)
  const totalHistoryItems = historyAgents.length

  return (
    <div className="code-history-panel" data-testid="code-history-panel">
      <div className="code-history-panel-header">
        <h2>{copy.history}</h2>
        <span>{copy.historySummary(0, 0, totalHistoryItems, 0)}</span>
      </div>
      {totalHistoryItems === 0 ? (
        <div className="code-empty-workspace">
          <h2>{copy.noHistoryYet}</h2>
          <p>{copy.noHistoryDescription}</p>
        </div>
      ) : (
        <div className="code-history-list">
          <section className="code-history-section" data-testid="code-history-agents">
            <h3>{copy.historyAgents}</h3>
            {historyAgents.map(item => {
              if (item.kind === 'run') {
                const { entry } = item
                const identity = historyRunIdentity(entry)
                return (
                  <article key={item.historyKey} className="code-history-card archived" data-testid="code-archived-run-card">
                    <div>
                      <h3>{historyRunTitle(entry)}</h3>
                      <p>{entry.command || 'unknown command'}</p>
                      <p>{formatWorkspaceForDisplay(historyRunWorkspace(entry))}</p>
                      <p className="code-history-identity" title={identity.title}>{identity.label}</p>
                    </div>
                    <div className="code-history-actions">
                      <span>{formatRelativeAge(item.updatedAt, now)}</span>
                      <button
                        type="button"
                        data-testid="code-archived-run-continue"
                        onClick={() => onContinueRun(entry)}
                      >
                        {copy.continueRun}
                      </button>
                    </div>
                  </article>
                )
              }

              if (item.kind === 'agent') {
                const { agent } = item
                const identity = historyAgentIdentity(agent)
                return (
                  <article key={item.historyKey} className="code-history-card archived" data-testid="code-archived-agent-card">
                    <div>
                      <h3>{agentTitle(agent)}</h3>
                      <p>{agent.task || agent.command}</p>
                      <p>{formatWorkspaceForDisplay(projectWorkspaceForAgent(agent))}</p>
                      <p className="code-history-identity" title={identity.title}>{identity.label}</p>
                    </div>
                    <div className="code-history-actions">
                      <span>{formatRelativeAge(item.updatedAt, now)}</span>
                      <button
                        type="button"
                        data-testid="code-archived-agent-open"
                        onClick={() => onOpenArchivedAgent(agent.id)}
                      >
                        {copy.open}
                      </button>
                      <button
                        type="button"
                        data-testid="code-archived-agent-restore"
                        onClick={() => onRestoreArchivedAgent(agent.id)}
                      >
                        {copy.restore}
                      </button>
                    </div>
                  </article>
                )
              }

              const { session } = item
              const sessionTitle = session.title || copy.sessionFallbackTitle(session.providerName)
              const identity = historySessionIdentity(session)
              return (
                <article key={item.historyKey} className="code-history-card code-session" data-testid="code-session-history-card">
                  <div>
                    <h3>{sessionTitle}</h3>
                    <p>{session.model ? `${session.providerName || session.provider} · ${session.model}${session.effort ? ` · ${effortLabel(session.effort)}` : ''}` : (session.providerName || session.provider)}</p>
                    <p>{formatAgentSessionWorkspace(session)}</p>
                    {identity && (
                      <p className="code-history-identity" title={identity.title}>{identity.label}</p>
                    )}
                  </div>
                  <div className="code-history-actions">
                    <span>{formatRelativeAge(item.updatedAt, now)}</span>
                    <button
                      type="button"
                      aria-label={copy.resumeSessionAria(sessionTitle)}
                      onClick={() => onResumeSession(session.provider, session.id)}
                    >
                      {copy.restore}
                    </button>
                  </div>
                </article>
              )
            })}
          </section>
        </div>
      )}
    </div>
  )
}
