import { useCallback, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Agent } from '@/types/agent'
import { isAcpRuntime } from '@/lib/agent-runtime'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { WorkspaceShareTarget } from '@/lib/workspace-share-target'
import { AgentTerminalPane } from '../AgentTerminalPane'
import { ChatBubblesGlyph, TerminalSquareGlyph } from '../IconGlyphs'
import { AcpTranscriptPane } from './acp/AcpTranscriptPane'
import type { AgentTranscriptProcessItem } from './acp/acp-entry-projection'
import { canForkAgentConversation, canSwitchAgentRuntime } from './capabilities'
import { isAgentTurnActive } from './agent-working-state'
import type { CodeCopy } from './copy'
import type { ShareNoticeAnchor } from './share-notice'
import { resumedAgentSessionSourceIdentity } from './session-display'

type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

interface AgentWorkPaneProps {
  agent: Agent
  mounted: boolean
  active: boolean
  runtimeSwitchVisible: boolean
  viewportLayoutKey: string
  switching: boolean
  switchingKind: 'permission' | 'runtime' | null
  focusSignal: number
  onActivate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolvePath?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onSearchTerminalWord?: (agentId: string, query: string) => void
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onCopyReadOnlyShareLink?: (target: WorkspaceShareTarget | null, anchor: ShareNoticeAnchor) => Promise<void> | void
  onOpenUrlInFarming?: (agentId: string, url: string) => void
  onFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  onReadLatest?: (agentId: string, readCut?: { runtimeEpoch: string; outputSeq: number } | null) => void
  onRuntimeModeChange?: (agentId: string, mode: 'terminal' | 'chat') => void
  onForkAgent?: (
    agentId: string,
    mode: 'same-worktree' | 'new-worktree',
    options?: { targetRuntime?: 'chat'; expectedRevision?: number }
  ) => Promise<void> | void
  onReviewAndCommit?: (agentId: string) => void
  onActivePlanChange?: (agentId: string, plan: AgentTranscriptProcessItem | undefined) => void
  copy: CodeCopy
}

export function agentWorkPaneModeStorageIdentity(agent: Agent) {
  return agent.restartedFromAgentIds?.[0] || agent.id
}

export function AgentWorkPane({
  agent,
  mounted,
  active,
  runtimeSwitchVisible,
  viewportLayoutKey,
  switching,
  switchingKind,
  focusSignal,
  onActivate,
  onSessionOutput,
  onOpenPath,
  onResolvePath,
  onSearchTerminalWord,
  onOpenWorkspaceFilePath,
  onCopyReadOnlyShareLink,
  onOpenUrlInFarming,
  onFollowOutputChange,
  onReadLatest,
  onRuntimeModeChange,
  onForkAgent,
  onReviewAndCommit,
  onActivePlanChange,
  copy,
}: AgentWorkPaneProps) {
  const acpRuntime = isAcpRuntime(agent) ? agent.runtimeBinding : null
  const reviewAndCommitRef = useRef(onReviewAndCommit)
  useLayoutEffect(() => {
    reviewAndCommitRef.current = onReviewAndCommit
  }, [onReviewAndCommit])
  const acpChat = Boolean(acpRuntime)
  const chatMode = acpChat
  const canSwitchRuntime = runtimeSwitchVisible && canSwitchAgentRuntime(agent)
  const runtimeSwitchDisabled = switching || isAgentTurnActive(agent)
  const canForkConversation = canForkAgentConversation(agent)
  const readLatestChat = useCallback(() => {
    const attentionSeq = Number.isFinite(agent.attentionSeq) ? Math.max(0, Number(agent.attentionSeq)) : 0
    const readAttentionSeq = Number.isFinite(agent.readAttentionSeq) ? Math.max(0, Number(agent.readAttentionSeq)) : 0
    if (attentionSeq <= readAttentionSeq && !agent.unread) return
    onReadLatest?.(agent.id)
  }, [agent.attentionSeq, agent.id, agent.readAttentionSeq, agent.unread, onReadLatest])
  const openChatUrlInFarming = useCallback((url: string) => {
    onOpenUrlInFarming?.(agent.id, url)
  }, [agent.id, onOpenUrlInFarming])
  const forkLatestChat = useCallback(() => {
    return onForkAgent?.(agent.id, 'same-worktree', {
      targetRuntime: 'chat',
      expectedRevision: acpRuntime?.sessionRevision || 0,
    })
  }, [acpRuntime?.sessionRevision, agent.id, onForkAgent])
  const reviewAndCommitChat = useCallback(() => {
    reviewAndCommitRef.current?.(agent.id)
  }, [agent.id])
  const publishActivePlan = useCallback((plan: AgentTranscriptProcessItem | undefined) => {
    onActivePlanChange?.(agent.id, plan)
  }, [agent.id, onActivePlanChange])

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
      {!chatMode && mounted ? (
        <div
          key="terminal"
          className={`code-agent-work-view terminal ${active ? 'active' : ''}`}
          data-testid="code-agent-terminal-view"
          aria-hidden={!active}
        >
          <AgentTerminalPane
            agent={agent}
            active={active}
            onActivate={onActivate}
            onOpenPath={onOpenPath}
            onResolvePath={onResolvePath}
            onSearchWord={onSearchTerminalWord}
            onOpenUrlInFarming={onOpenUrlInFarming}
            onFollowOutputChange={onFollowOutputChange}
            onReadLatest={onReadLatest}
            onSessionOutput={onSessionOutput}
            focusSignal={focusSignal}
            copy={copy}
          />
        </div>
      ) : null}
      {chatMode && mounted ? (
        <div
          key="chat"
          className={`code-agent-work-view transcript ${active ? 'active' : ''}`}
          data-testid="code-agent-chat-view"
          aria-hidden={!active}
          onPointerDown={activateChatView}
        >
          <AcpTranscriptPane agentId={agent.id} workspaceRootId={agent.workspaceRootId} readingIdentity={agentWorkPaneModeStorageIdentity(agent)} workspaceRoot={agent.projectWorkspace || agent.cwd} active={active} viewportLayoutKey={viewportLayoutKey} runtimeState={acpRuntime?.state || ''} expectHistory={Boolean(resumedAgentSessionSourceIdentity(agent.source)) || Number(acpRuntime?.sessionRevision || 0) > 0} forkedFromAgent={Boolean(agent.parentAgentId && agent.forkedFromProviderSessionId)} refreshSignal={acpRuntime?.sessionRevision || (acpRuntime?.sessionUpdatedAt ? Date.parse(acpRuntime.sessionUpdatedAt) : 0)} onOpenWorkspaceFilePath={onOpenWorkspaceFilePath} onCopyReadOnlyShareLink={onCopyReadOnlyShareLink} onOpenUrlInFarming={onOpenUrlInFarming ? openChatUrlInFarming : undefined} onReadLatest={readLatestChat} onForkLatest={canForkConversation ? forkLatestChat : undefined} onReviewAndCommit={onReviewAndCommit && !isAgentTurnActive(agent) ? reviewAndCommitChat : undefined} onActivePlanChange={publishActivePlan} copy={copy} />
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
