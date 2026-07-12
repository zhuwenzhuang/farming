import { useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Agent } from '@/types/agent'
import type { TerminalInputPart } from '@/types/messages'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import { AgentTerminalPane } from '../AgentTerminalPane'
import { ChatBubblesGlyph, TerminalSquareGlyph } from '../IconGlyphs'
import { CodexAppServerTranscriptPane } from './CodexAppServerTranscriptPane'
import { JsonCliTranscriptPane } from './JsonCliTranscriptPane'
import { AcpTranscriptPane } from './acp/AcpTranscriptPane'
import type { CodeCopy } from './copy'

type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

interface AgentWorkPaneProps {
  agent: Agent
  active: boolean
  switching: boolean
  switchingKind: 'permission' | 'runtime' | null
  focusSignal: number
  onActivate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  sendInput: (input: string | TerminalInputPart[], agentId?: string) => boolean
  resizeAgent: (agentId: string, cols: number, rows: number) => boolean
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => () => void
  onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolvePath?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  onReadLatest?: (agentId: string) => void
  onRuntimeModeChange?: (agentId: string, mode: 'terminal' | 'acp') => void
  copy: CodeCopy
}

function isCodexAppServerAgent(agent: Agent) {
  return agent.providerSessionProvider === 'codex'
    && agent.codexRuntimeMode === 'app-server'
}

export function agentWorkPaneModeStorageIdentity(agent: Agent) {
  if (!isCodexAppServerAgent(agent)) return agent.restartedFromAgentIds?.[0] || agent.id
  const providerSessionKey = String(agent.providerSessionKey || '').trim()
  if (providerSessionKey) return `session:${providerSessionKey}`
  return `session:${agent.providerSessionProvider}:${agent.providerHomeId || 'default'}:${agent.providerSessionId}`
}

export function AgentWorkPane({
  agent,
  active,
  switching,
  switchingKind,
  focusSignal,
  onActivate,
  sendInput,
  resizeAgent,
  onSessionOutput,
  onOpenPath,
  onResolvePath,
  onOpenWorkspaceFilePath,
  onFollowOutputChange,
  onReadLatest,
  onRuntimeModeChange,
  copy,
}: AgentWorkPaneProps) {
  const appServerChat = isCodexAppServerAgent(agent)
  const jsonChat = agent.agentRuntimeMode === 'json'
  const acpChat = agent.agentRuntimeMode === 'acp'
  const chatMode = appServerChat || jsonChat || acpChat
  const canSwitchRuntime = ['codex', 'claude', 'opencode'].includes(agent.providerSessionProvider || '')
    && agent.providerSessionTemporary !== true
    && Boolean(agent.providerSessionId)

  const activateChatView = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return
    if (!active) onActivate(agent.id, { focusTerminal: false })
  }, [active, agent.id, onActivate])

  return (
    <section
      className={`code-agent-work-pane ${active ? 'active' : ''}`}
      data-testid="code-agent-work-pane"
      data-agent-id={agent.id}
      aria-busy={switching}
    >
      {canSwitchRuntime ? (
        <div className="code-terminal-mode-toggle" data-testid="code-terminal-mode-toggle" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
          <button type="button" className={chatMode ? 'active' : ''} aria-pressed={chatMode} aria-label={copy.transcriptView} title={copy.transcriptView} disabled={switching} onClick={() => !chatMode && onRuntimeModeChange?.(agent.id, 'acp')}>
            <ChatBubblesGlyph />
          </button>
          <button type="button" className={!chatMode ? 'active' : ''} aria-pressed={!chatMode} aria-label={copy.terminalView} title={copy.terminalView} disabled={switching} onClick={() => chatMode && onRuntimeModeChange?.(agent.id, 'terminal')}>
            <TerminalSquareGlyph />
          </button>
        </div>
      ) : null}
      {!chatMode ? (
        <div
          className="code-agent-work-view terminal active"
          data-testid="code-agent-terminal-view"
          aria-hidden={false}
        >
          <AgentTerminalPane
            agent={agent}
            active={active}
            onActivate={onActivate}
            onOpenPath={onOpenPath}
            onResolvePath={onResolvePath}
            onFollowOutputChange={onFollowOutputChange}
            sendInput={sendInput}
            resizeAgent={resizeAgent}
            onSessionOutput={onSessionOutput}
            focusSignal={focusSignal}
            copy={copy}
          />
        </div>
      ) : null}
      {chatMode ? (
        <div
          className="code-agent-work-view transcript active"
          data-testid="code-agent-chat-view"
          aria-hidden={false}
          onPointerDown={activateChatView}
        >
          {acpChat ? (
            <AcpTranscriptPane agentId={agent.id} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onReadLatest={() => onReadLatest?.(agent.id)} copy={copy} />
          ) : appServerChat ? (
            <CodexAppServerTranscriptPane agentId={agent.id} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onReadLatest={() => onReadLatest?.(agent.id)} copy={copy} />
          ) : (
            <JsonCliTranscriptPane agentId={agent.id} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} refreshSignal={agent.jsonCliTranscriptUpdatedAt ? Date.parse(agent.jsonCliTranscriptUpdatedAt) : 0} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onReadLatest={() => onReadLatest?.(agent.id)} copy={copy} />
          )}
        </div>
      ) : null}
      {switching ? (
        <div className="code-permission-switching" data-testid="code-permission-switching" role="status" aria-live="polite">
          <span className="code-permission-switching-spinner" aria-hidden="true" />
          <span>{switchingKind === 'runtime' ? copy.runtimeModeRestarting : copy.permissionProfileRestarting}</span>
        </div>
      ) : null}
    </section>
  )
}
