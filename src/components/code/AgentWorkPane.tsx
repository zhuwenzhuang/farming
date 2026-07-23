import { useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Agent } from '@/types/agent'
import { isAcpRuntime, isJsonRuntime } from '@/lib/agent-runtime'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import { AgentTerminalPane } from '../AgentTerminalPane'
import { ChatBubblesGlyph, TerminalSquareGlyph } from '../IconGlyphs'
import { JsonCliTranscriptPane } from './JsonCliTranscriptPane'
import { AcpTranscriptPane } from './acp/AcpTranscriptPane'
import { canSwitchAgentRuntime } from './capabilities'
import { isAgentTurnActive } from './agent-working-state'
import type { CodeCopy } from './copy'

type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

interface AgentWorkPaneProps {
  agent: Agent
  active: boolean
  viewportLayoutKey: string
  switching: boolean
  switchingKind: 'permission' | 'runtime' | null
  focusSignal: number
  onActivate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolvePath?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  onReadLatest?: (agentId: string, readCut?: { runtimeEpoch: string; outputSeq: number } | null) => void
  onRuntimeModeChange?: (agentId: string, mode: 'terminal' | 'chat') => void
  copy: CodeCopy
}

export function agentWorkPaneModeStorageIdentity(agent: Agent) {
  return agent.restartedFromAgentIds?.[0] || agent.id
}

export function AgentWorkPane({
  agent,
  active,
  viewportLayoutKey,
  switching,
  switchingKind,
  focusSignal,
  onActivate,
  onSessionOutput,
  onOpenPath,
  onResolvePath,
  onOpenWorkspaceFilePath,
  onFollowOutputChange,
  onReadLatest,
  onRuntimeModeChange,
  copy,
}: AgentWorkPaneProps) {
  const jsonRuntime = isJsonRuntime(agent) ? agent.runtimeBinding : null
  const acpRuntime = isAcpRuntime(agent) ? agent.runtimeBinding : null
  const jsonChat = Boolean(jsonRuntime)
  const acpChat = Boolean(acpRuntime)
  const chatMode = jsonChat || acpChat
  const canSwitchRuntime = canSwitchAgentRuntime(agent)
  const runtimeSwitchDisabled = switching || isAgentTurnActive(agent)

  const activateChatView = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return
    if (!active) onActivate(agent.id, { focusTerminal: false })
  }, [active, agent.id, onActivate])

  return (
    <section
      className={`code-agent-work-pane ${active ? 'active' : ''} ${canSwitchRuntime ? 'runtime-switchable' : ''}`}
      data-testid="code-agent-work-pane"
      data-agent-id={agent.id}
      hidden={!active}
      aria-busy={switching}
    >
      {canSwitchRuntime ? (
        <div className="code-terminal-mode-toggle" data-testid="code-terminal-mode-toggle" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
          <button type="button" className={chatMode ? 'active' : ''} aria-pressed={chatMode} aria-label={copy.transcriptView} title={copy.transcriptView} disabled={runtimeSwitchDisabled} onClick={() => !chatMode && onRuntimeModeChange?.(agent.id, 'chat')}>
            <ChatBubblesGlyph />
          </button>
          <button type="button" className={!chatMode ? 'active' : ''} aria-pressed={!chatMode} aria-label={copy.terminalView} title={copy.terminalView} disabled={runtimeSwitchDisabled} onClick={() => chatMode && onRuntimeModeChange?.(agent.id, 'terminal')}>
            <TerminalSquareGlyph />
          </button>
        </div>
      ) : null}
      {!chatMode && active ? (
        <div
          key="terminal"
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
            onReadLatest={onReadLatest}
            onSessionOutput={onSessionOutput}
            focusSignal={focusSignal}
            copy={copy}
          />
        </div>
      ) : null}
      {chatMode ? (
        <div
          key="chat"
          className="code-agent-work-view transcript active"
          data-testid="code-agent-chat-view"
          aria-hidden={false}
          onPointerDown={activateChatView}
        >
          {acpChat ? (
            <AcpTranscriptPane agentId={agent.id} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} viewportLayoutKey={viewportLayoutKey} runtimeState={acpRuntime?.state || ''} expectHistory={(agent.source || '').startsWith('codex-history:')} refreshSignal={acpRuntime?.sessionRevision || (acpRuntime?.sessionUpdatedAt ? Date.parse(acpRuntime.sessionUpdatedAt) : 0)} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onReadLatest={() => onReadLatest?.(agent.id)} copy={copy} />
          ) : (
            <JsonCliTranscriptPane agentId={agent.id} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} viewportLayoutKey={viewportLayoutKey} refreshSignal={jsonRuntime?.transcriptUpdatedAt ? Date.parse(jsonRuntime.transcriptUpdatedAt) : 0} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onReadLatest={() => onReadLatest?.(agent.id)} copy={copy} />
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
