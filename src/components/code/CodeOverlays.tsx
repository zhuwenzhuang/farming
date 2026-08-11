import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import type { Agent } from '@/types/agent'
import {
  agentMenuAvailability,
  isAgentTurnActive,
  projectCanArchive,
  projectCanDeleteWorktree,
} from './capabilities'
import {
  compactContextMenuEntries,
  type ContextMenuEntry,
  type ContextMenuIconKind,
} from './menu-model'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'
import {
  BrowserGlyph,
  ChatBubblesGlyph,
  CopyGlyph,
  DesktopGlyph,
  ForkGlyph,
  TerminalSquareGlyph,
} from '@/components/IconGlyphs'

type AgentMenuState = { agentId: string; x: number; y: number } | null
type ProjectMenuState = { projectId: string; x: number; y: number } | null
type AgentSessionMenuState = { provider: string; sessionId: string; x: number; y: number } | null

type RenameDialogState =
  | { kind: 'agent'; agentId: string; title: string }
  | { kind: 'project'; projectId: string; workspace: string; title: string }

interface ArchiveExitDialogState {
  agentId: string
  title: string
}

interface DeleteWorktreeDialogState {
  workspace: string
}

interface CopyNoticeState {
  id: number
  kind: 'success' | 'error'
  message: string
}

interface CodeOverlaysProps {
  contextMenuAgent: Agent | null
  contextMenuAgentSession: AgentSessionHistoryItem | null
  contextMenuProject: ProjectGroup | null
  agentMenu: AgentMenuState
  projectMenu: ProjectMenuState
  agentSessionMenu: AgentSessionMenuState
  renameDialog: RenameDialogState | null
  archiveExitDialog: ArchiveExitDialogState | null
  deleteWorktreeDialog: DeleteWorktreeDialogState | null
  copyNotice: CopyNoticeState | null
  contextMenuRef: RefObject<HTMLDivElement | null>
  renameDialogRef: RefObject<HTMLFormElement | null>
  renameInputRef: RefObject<HTMLInputElement | null>
  archiveExitDialogRef: RefObject<HTMLDivElement | null>
  archiveExitCancelButtonRef: RefObject<HTMLButtonElement | null>
  deleteWorktreeDialogRef: RefObject<HTMLDivElement | null>
  deleteWorktreeCancelButtonRef: RefObject<HTMLButtonElement | null>
  onContextMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  runtimeSwitchDisabled: boolean
  canCreateAgentBrowser: boolean
  canCreateAgentDesktop: boolean
  onSwitchAgentRuntime: (agentId: string, mode: 'terminal' | 'chat') => void
  onCreateAgentBrowser: () => void
  onCreateAgentDesktop: () => void
  onUpdateAgentFlags: (flags: Partial<Pick<Agent, 'pinned' | 'unread' | 'archived'>>) => void
  onArchiveAgent: () => void
  onRenameAgent: () => void
  onRenameProject: () => void
  onCopyAgentWorkingDirectory: () => void
  onForkAgent: (mode: 'same-worktree' | 'new-worktree') => void
  onOpenSession: (provider: string, sessionId: string) => void
  onToggleSessionPinned: () => void
  onArchiveSession: () => void
  onCopySessionWorkingDirectory: () => void
  onToggleProjectPinned: () => void
  onRevealProject: () => void
  onCreatePermanentWorktree: () => void
  onMarkProjectRead: () => void
  onArchiveProject: () => void
  onRemoveProject: () => void
  onDeleteWorktree: () => void
  onCloseRenameDialog: () => void
  onRenameDialogTitleChange: (title: string) => void
  onSubmitRenameDialog: () => void
  onCloseArchiveExitDialog: () => void
  onSubmitArchiveExitDialog: () => void
  onCloseDeleteWorktreeDialog: () => void
  onSubmitDeleteWorktreeDialog: () => void
  copy: CodeCopy
}

export function CodeOverlays({
  contextMenuAgent,
  contextMenuAgentSession,
  contextMenuProject,
  agentMenu,
  projectMenu,
  agentSessionMenu,
  renameDialog,
  archiveExitDialog,
  deleteWorktreeDialog,
  copyNotice,
  contextMenuRef,
  renameDialogRef,
  renameInputRef,
  archiveExitDialogRef,
  archiveExitCancelButtonRef,
  deleteWorktreeDialogRef,
  deleteWorktreeCancelButtonRef,
  onContextMenuKeyDown,
  runtimeSwitchDisabled,
  canCreateAgentBrowser,
  canCreateAgentDesktop,
  onSwitchAgentRuntime,
  onCreateAgentBrowser,
  onCreateAgentDesktop,
  onUpdateAgentFlags,
  onArchiveAgent,
  onRenameAgent,
  onRenameProject,
  onCopyAgentWorkingDirectory,
  onForkAgent,
  onOpenSession,
  onToggleSessionPinned,
  onArchiveSession,
  onCopySessionWorkingDirectory,
  onToggleProjectPinned,
  onRevealProject,
  onCreatePermanentWorktree,
  onMarkProjectRead,
  onArchiveProject,
  onRemoveProject,
  onDeleteWorktree,
  onCloseRenameDialog,
  onRenameDialogTitleChange,
  onSubmitRenameDialog,
  onCloseArchiveExitDialog,
  onSubmitArchiveExitDialog,
  onCloseDeleteWorktreeDialog,
  onSubmitDeleteWorktreeDialog,
  copy,
}: CodeOverlaysProps) {
  const agentMenuAvailabilityState = agentMenuAvailability(contextMenuAgent, {
    canCreateBrowser: canCreateAgentBrowser,
    canCreateDesktop: canCreateAgentDesktop,
  })
  const canArchiveProject = projectCanArchive(contextMenuProject)
  const canDeleteWorktree = projectCanDeleteWorktree(contextMenuProject)
  const canMarkProjectRead = Boolean(contextMenuProject?.agents.some(agent => agent.unread))
  const agentChatMode = contextMenuAgent?.runtimeBinding.kind !== 'terminal'
  const agentMenuEntries = compactContextMenuEntries([
    {
      type: 'item',
      id: 'create-agent-desktop',
      label: copy.createIsolatedDesktop,
      icon: 'desktop',
      hidden: !agentMenuAvailabilityState.createDesktop,
      onSelect: onCreateAgentDesktop,
    },
    { type: 'separator', id: 'agent-resource-separator' },
    {
      type: 'item',
      id: 'pin-agent',
      label: contextMenuAgent?.pinned ? copy.unpinAgent : copy.pinAgent,
      icon: contextMenuAgent?.pinned ? 'unpin' : 'pin',
      hidden: !agentMenuAvailabilityState.pin,
      onSelect: () => onUpdateAgentFlags({ pinned: !contextMenuAgent?.pinned }),
    },
    {
      type: 'item',
      id: 'rename-agent',
      label: copy.renameAgent,
      icon: 'rename',
      hidden: !agentMenuAvailabilityState.rename,
      onSelect: onRenameAgent,
    },
    {
      type: 'item',
      id: 'archive-agent',
      label: copy.archiveAgent,
      icon: 'archive',
      hidden: !agentMenuAvailabilityState.archive,
      onSelect: onArchiveAgent,
    },
    {
      type: 'item',
      id: 'toggle-agent-unread',
      label: copy.markAsUnread,
      icon: 'unread',
      hidden: !agentMenuAvailabilityState.markUnread,
      onSelect: () => onUpdateAgentFlags({ unread: true }),
    },
    { type: 'separator', id: 'agent-copy-separator' },
    {
      type: 'item',
      id: 'copy-agent-working-directory',
      label: copy.copyWorkingDirectory,
      icon: 'copy',
      hidden: !agentMenuAvailabilityState.copyWorkingDirectory,
      onSelect: onCopyAgentWorkingDirectory,
    },
    { type: 'separator', id: 'agent-fork-separator' },
    {
      type: 'item',
      id: 'fork-same-worktree',
      label: copy.forkSameWorktree,
      icon: 'fork',
      hidden: !agentMenuAvailabilityState.forkSameWorktree,
      onSelect: () => onForkAgent('same-worktree'),
    },
    {
      type: 'item',
      id: 'fork-new-worktree',
      label: copy.forkNewWorktree,
      icon: 'fork-plus',
      hidden: !agentMenuAvailabilityState.forkNewWorktree,
      onSelect: () => onForkAgent('new-worktree'),
    },
    { type: 'separator', id: 'agent-runtime-separator' },
    {
      type: 'item',
      id: 'switch-agent-runtime',
      label: agentChatMode ? copy.switchToTerminal : copy.switchToChat,
      icon: agentChatMode ? 'terminal' : 'chat',
      hidden: !agentMenuAvailabilityState.switchRuntime,
      disabled: runtimeSwitchDisabled || isAgentTurnActive(contextMenuAgent),
      onSelect: () => {
        if (!contextMenuAgent) return
        onSwitchAgentRuntime(contextMenuAgent.id, agentChatMode ? 'terminal' : 'chat')
      },
    },
    {
      type: 'item',
      id: 'create-agent-browser',
      label: copy.createBrowser,
      icon: 'browser',
      hidden: !agentMenuAvailabilityState.createBrowser,
      onSelect: onCreateAgentBrowser,
    },
  ])
  const sessionMenuEntries = compactContextMenuEntries([
    {
      type: 'item',
      id: 'open-session',
      label: copy.openSession,
      onSelect: () => {
        if (!contextMenuAgentSession) return
        onOpenSession(contextMenuAgentSession.provider, contextMenuAgentSession.id)
      },
    },
    {
      type: 'item',
      id: 'toggle-session-pinned',
      label: contextMenuAgentSession?.pinned ? copy.unpinChat : copy.pinChat,
      onSelect: onToggleSessionPinned,
    },
    {
      type: 'item',
      id: 'archive-session',
      label: copy.archiveChat,
      onSelect: onArchiveSession,
    },
    {
      type: 'item',
      id: 'copy-session-working-directory',
      label: copy.copyWorkingDirectory,
      onSelect: onCopySessionWorkingDirectory,
    },
  ])
  const projectMenuEntries = compactContextMenuEntries([
    {
      type: 'item',
      id: 'pin-project',
      label: contextMenuProject?.pinned ? copy.unpinProject : copy.pinProject,
      icon: contextMenuProject?.pinned ? 'unpin' : 'pin',
      hidden: !contextMenuProject?.workspace,
      onSelect: onToggleProjectPinned,
    },
    {
      type: 'item',
      id: 'reveal-project',
      label: copy.revealInFinder,
      icon: 'folder',
      hidden: !contextMenuProject?.workspace || contextMenuProject.workspace === '/' || contextMenuProject.hasMain,
      onSelect: onRevealProject,
    },
    {
      type: 'item',
      id: 'create-permanent-worktree',
      label: copy.createPermanentWorktree,
      icon: 'worktree',
      hidden: !contextMenuProject?.workspace || contextMenuProject.workspace === '/' || contextMenuProject.hasMain,
      onSelect: onCreatePermanentWorktree,
    },
    { type: 'separator', id: 'project-primary-separator' },
    {
      type: 'item',
      id: 'rename-project',
      label: copy.renameProject,
      icon: 'rename',
      hidden: !contextMenuProject?.workspace,
      onSelect: onRenameProject,
    },
    {
      type: 'item',
      id: 'mark-project-read',
      label: copy.markAllAsRead,
      icon: 'check',
      disabled: !canMarkProjectRead,
      onSelect: onMarkProjectRead,
    },
    {
      type: 'item',
      id: 'archive-project',
      label: copy.archiveChats,
      icon: 'archive',
      disabled: !canArchiveProject,
      onSelect: onArchiveProject,
    },
    { type: 'separator', id: 'project-destructive-separator' },
    {
      type: 'item',
      id: 'remove-project',
      label: copy.removeProject,
      removeIcon: true,
      hidden: !contextMenuProject?.workspace || contextMenuProject.hasMain,
      disabled: Boolean(
        contextMenuProject
        && (
          contextMenuProject.agents.length > 0
          || contextMenuProject.agentSessions.length > 0
          || contextMenuProject.hasOpenFile
        )
      ),
      onSelect: onRemoveProject,
    },
    {
      type: 'item',
      id: 'delete-worktree',
      label: copy.deleteWorktree,
      icon: 'trash',
      danger: true,
      hidden: !canDeleteWorktree,
      onSelect: onDeleteWorktree,
    },
  ])

  return (
    <>
      {contextMenuAgent && (
        <div
          className="code-context-menu"
          data-testid="code-agent-context-menu"
          style={{ left: agentMenu?.x ?? 0, top: agentMenu?.y ?? 0 }}
          role="menu"
          ref={contextMenuRef}
          onKeyDownCapture={onContextMenuKeyDown}
          onKeyDown={onContextMenuKeyDown}
        >
          <ContextMenuEntries entries={agentMenuEntries} />
        </div>
      )}
      {contextMenuAgentSession && (
        <div
          className="code-context-menu"
          data-testid="code-session-context-menu"
          style={{ left: agentSessionMenu?.x ?? 0, top: agentSessionMenu?.y ?? 0 }}
          role="menu"
          ref={contextMenuRef}
          onKeyDownCapture={onContextMenuKeyDown}
          onKeyDown={onContextMenuKeyDown}
        >
          <ContextMenuEntries entries={sessionMenuEntries} />
        </div>
      )}
      {contextMenuProject && (
        <div
          className="code-context-menu code-project-context-menu"
          data-testid="code-project-context-menu"
          style={{ left: projectMenu?.x ?? 0, top: projectMenu?.y ?? 0 }}
          role="menu"
          ref={contextMenuRef}
          onKeyDownCapture={onContextMenuKeyDown}
          onKeyDown={onContextMenuKeyDown}
        >
          <ContextMenuEntries entries={projectMenuEntries} />
        </div>
      )}
      {renameDialog && (
        <div className="code-rename-backdrop" data-testid="code-rename-backdrop" onMouseDown={onCloseRenameDialog}>
          <form
            className="code-rename-dialog"
            data-testid="code-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-rename-title"
            ref={renameDialogRef}
            onMouseDown={event => event.stopPropagation()}
            onKeyDownCapture={event => trapFocusInContainer(event, renameDialogRef.current)}
            onKeyDown={event => trapFocusInContainer(event, renameDialogRef.current)}
            onSubmit={event => {
              event.preventDefault()
              onSubmitRenameDialog()
            }}
          >
            <label id="code-rename-title" htmlFor="code-rename-input">
              {renameDialog.kind === 'project' ? copy.renameProject : copy.renameAgent}
            </label>
            <input
              id="code-rename-input"
              ref={renameInputRef}
              data-testid="code-rename-input"
              type="text"
              name="farming-rename-title"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              value={renameDialog.title}
              onChange={event => onRenameDialogTitleChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onCloseRenameDialog()
                }
              }}
            />
            <div className="code-rename-actions">
              <button type="button" onClick={onCloseRenameDialog}>{copy.cancel}</button>
              <button type="submit" className="primary" disabled={!renameDialog.title.trim()}>{copy.save}</button>
            </div>
          </form>
        </div>
      )}
      {archiveExitDialog && (
        <div className="code-rename-backdrop" data-testid="code-archive-exit-backdrop" onMouseDown={onCloseArchiveExitDialog}>
          <div
            className="code-rename-dialog code-kill-dialog"
            data-testid="code-archive-exit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-archive-exit-title"
            ref={archiveExitDialogRef}
            onMouseDown={event => event.stopPropagation()}
            onKeyDownCapture={event => trapFocusInContainer(event, archiveExitDialogRef.current)}
            onKeyDown={event => trapFocusInContainer(event, archiveExitDialogRef.current)}
          >
            <h2 id="code-archive-exit-title">{copy.archiveAgentQuestion}</h2>
            <p>{copy.acknowledgeUnprovenAcpExitDescription(archiveExitDialog.title)}</p>
            <div className="code-rename-actions">
              <button type="button" ref={archiveExitCancelButtonRef} onClick={onCloseArchiveExitDialog} autoFocus>{copy.cancel}</button>
              <button type="button" className="danger" onClick={onSubmitArchiveExitDialog}>
                {copy.acknowledgeUnprovenAcpExit}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteWorktreeDialog && (
        <div className="code-rename-backdrop" data-testid="code-delete-worktree-backdrop" onMouseDown={onCloseDeleteWorktreeDialog}>
          <div
            className="code-rename-dialog code-kill-dialog"
            data-testid="code-delete-worktree-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-delete-worktree-title"
            ref={deleteWorktreeDialogRef}
            onMouseDown={event => event.stopPropagation()}
            onKeyDownCapture={event => trapFocusInContainer(event, deleteWorktreeDialogRef.current)}
            onKeyDown={event => trapFocusInContainer(event, deleteWorktreeDialogRef.current)}
          >
            <h2 id="code-delete-worktree-title">{copy.deleteWorktreeQuestion}</h2>
            <p>{copy.deleteWorktreeDescription}</p>
            <div className="code-rename-actions">
              <button type="button" ref={deleteWorktreeCancelButtonRef} onClick={onCloseDeleteWorktreeDialog} autoFocus>{copy.cancel}</button>
              <button type="button" className="danger" onClick={onSubmitDeleteWorktreeDialog}>{copy.forceDelete}</button>
            </div>
          </div>
        </div>
      )}
      {copyNotice && (
        <div className={`code-copy-toast ${copyNotice.kind}`} data-testid="code-copy-toast" role="status">
          {copyNotice.message}
        </div>
      )}
    </>
  )
}

function ContextMenuEntries({ entries }: { entries: ContextMenuEntry[] }) {
  return (
    <>
      {entries.map(entry => {
        if (entry.type === 'separator') {
          return <div key={entry.id} className="code-context-menu-separator" role="separator" />
        }

        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={entry.danger ? 'danger' : undefined}
            disabled={entry.disabled}
            onClick={entry.onSelect}
          >
            {(entry.icon || entry.removeIcon) && (
              <span className="code-context-menu-icon" aria-hidden="true">
                {entry.removeIcon ? <RemoveProjectIcon /> : <ContextMenuIcon kind={entry.icon!} />}
              </span>
            )}
            <span>{entry.label}</span>
            {entry.trailingIcon && (
              <span className="code-context-menu-icon trailing" aria-hidden="true">
                <ContextMenuIcon kind={entry.trailingIcon} />
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}

function RemoveProjectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4.354 3.646a.5.5 0 0 0-.708.708L7.293 8l-3.647 3.646a.5.5 0 0 0 .708.708L8 8.707l3.646 3.647a.5.5 0 0 0 .708-.708L8.707 8l3.647-3.646a.5.5 0 0 0-.708-.708L8 7.293 4.354 3.646Z" />
    </svg>
  )
}

export function ContextMenuIcon({ kind }: { kind: ContextMenuIconKind }) {
  if (kind === 'browser') return <BrowserGlyph />
  if (kind === 'desktop') return <DesktopGlyph />
  if (kind === 'chat') return <ChatBubblesGlyph />
  if (kind === 'terminal') return <TerminalSquareGlyph />
  if (kind === 'copy') return <CopyGlyph />
  if (kind === 'fork') return <ForkGlyph />

  if (kind === 'unread') {
    return (
      <svg className="code-context-menu-unread-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="4" fill="currentColor" />
      </svg>
    )
  }

  if (kind === 'fork-plus') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="3.5" cy="3" r="1.5" />
        <circle cx="10.5" cy="4" r="1.5" />
        <circle cx="10.5" cy="11.5" r="1.5" />
        <path d="M3.5 4.5v3A4 4 0 0 0 7.5 11.5H9M5 4h4" />
        <path d="M13 7.5v3M11.5 9h3" />
      </svg>
    )
  }

  if (kind === 'pin') {
    return (
      <svg data-icon-kind="pin" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z" />
      </svg>
    )
  }

  if (kind === 'unpin') {
    return (
      <svg data-icon-kind="unpin" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M9.56016 10.2673L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L5.73223 6.43934L5.6526 6.58876L2.8419 7.52566C2.6775 7.58046 2.5532 7.71648 2.51339 7.88513C2.47357 8.05378 2.52392 8.23102 2.64646 8.35356L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5264 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L9.56016 10.2673ZM8.82138 9.52849L8.76403 9.5592C8.65137 9.61951 8.56608 9.72066 8.52567 9.84189L7.7815 12.0744L3.92562 8.21851L6.15812 7.47435C6.27966 7.43383 6.38101 7.34822 6.44126 7.23516L6.47143 7.17854L8.82138 9.52849ZM12.7178 7.4426L10.6636 8.54227L11.4024 9.28105L13.1897 8.32422C14.0759 7.84981 14.2538 6.65509 13.5443 5.94304L10.0589 2.44509C9.34701 1.73062 8.14697 1.90828 7.67261 2.79838L6.71556 4.59421L7.45476 5.33341L8.55511 3.26869C8.71323 2.97199 9.11324 2.91277 9.35055 3.15093L12.836 6.64888C13.0725 6.88623 13.0131 7.28446 12.7178 7.4426Z" />
      </svg>
    )
  }

  if (kind === 'folder') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M2 4.5V9.10022L2.92389 7.5C3.45979 6.5718 4.45017 6 5.52196 6L11.9146 6C11.7087 5.4174 11.1531 5 10.5 5H7C6.86739 5 6.74021 4.94732 6.64645 4.85355L4.93934 3.14645C4.84557 3.05268 4.71839 3 4.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM7.06895 13.9953C7.04641 13.9984 7.02339 14 7 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5C1 3.11929 2.11929 2 3.5 2H4.58579C4.98361 2 5.36514 2.15804 5.64645 2.43934L7.20711 4H10.5C11.724 4 12.7426 4.87965 12.958 6.04127C14.605 6.34148 15.5443 8.22106 14.6616 9.75L13.0766 12.4953C12.5407 13.4235 11.5503 13.9953 10.4785 13.9953H7.06895ZM5.52196 7C4.80743 7 4.14718 7.3812 3.78991 8L2.20492 10.7453C1.62757 11.7453 2.34926 12.9953 3.50396 12.9953L10.4785 12.9953C11.193 12.9953 11.8533 12.6141 12.2105 11.9953L13.7955 9.25C14.3729 8.25 13.6512 7 12.4965 7L5.52196 7Z" />
      </svg>
    )
  }

  if (kind === 'worktree') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M14 5.5C14 4.121 12.879 3 11.5 3C10.121 3 9 4.121 9 5.5C9 6.682 9.826 7.669 10.93 7.928C10.744 8.546 10.177 9 9.5 9H6.5C5.935 9 5.419 9.195 5 9.512V4.949C6.14 4.717 7 3.707 7 2.5C7 1.121 5.879 0 4.5 0C3.121 0 2 1.121 2 2.5C2 3.708 2.86 4.717 4 4.949V11.05C2.86 11.282 2 12.292 2 13.499C2 14.878 3.121 15.999 4.5 15.999C5.879 15.999 7 14.878 7 13.499C7 12.317 6.174 11.33 5.07 11.071C5.256 10.453 5.823 9.999 6.5 9.999H9.5C10.723 9.999 11.74 9.115 11.954 7.953C13.116 7.738 14 6.723 14 5.5ZM3 2.5C3 1.673 3.673 1 4.5 1C5.327 1 6 1.673 6 2.5C6 3.327 5.327 4 4.5 4C3.673 4 3 3.327 3 2.5ZM6 13.5C6 14.327 5.327 15 4.5 15C3.673 15 3 14.327 3 13.5C3 12.673 3.673 12 4.5 12C5.327 12 6 12.673 6 13.5ZM11.5 7C10.673 7 10 6.327 10 5.5C10 4.673 10.673 4 11.5 4C12.327 4 13 4.673 13 5.5C13 6.327 12.327 7 11.5 7Z" />
      </svg>
    )
  }

  if (kind === 'check') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z" />
      </svg>
    )
  }

  if (kind === 'archive') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6.5 8C6.22386 8 6 8.22386 6 8.5C6 8.77614 6.22386 9 6.5 9H9.5C9.77614 9 10 8.77614 10 8.5C10 8.22386 9.77614 8 9.5 8H6.5ZM1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V4.5C15 5.15311 14.5826 5.70873 14 5.91465V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V5.91465C1.4174 5.70873 1 5.15311 1 4.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V4.5C2 4.77614 2.22386 5 2.5 5H13.5C13.7761 5 14 4.77614 14 4.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5ZM3 6V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V6H3Z" />
      </svg>
    )
  }

  if (kind === 'trash') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6.25 2h3.5l.5 1H13v1H3V3h2.75l.5-1ZM4.2 5h7.6l-.48 8.1A1 1 0 0 1 10.32 14H5.68a1 1 0 0 1-1-.9L4.2 5Zm2.05 1 .35 7h.95L7.2 6h-.95Zm2.2 0v7h.95V6h-.95Z" />
      </svg>
    )
  }

  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11.3536 1.64645C10.963 1.25592 10.3299 1.25592 9.93934 1.64645L3.14645 8.43934C3.05268 8.53311 2.99999 8.66029 2.99999 8.79289V11.5C2.99999 11.7761 3.22385 12 3.49999 12H6.2071C6.33971 12 6.46689 11.9473 6.56066 11.8536L13.3536 5.06066C13.7441 4.67014 13.7441 4.037 13.3536 3.64645L11.3536 1.64645ZM3.99999 9L8.99999 4L11 6L6 11H3.99999V9ZM9.7071 3.29289L10.6464 2.35355L12.6464 4.35355L11.7071 5.29289L9.7071 3.29289ZM2.5 14C2.22386 14 2 14.2239 2 14.5C2 14.7761 2.22386 15 2.5 15H13.5C13.7761 15 14 14.7761 14 14.5C14 14.2239 13.7761 14 13.5 14H2.5Z" />
    </svg>
  )
}

function trapFocusInContainer(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return

  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
  )).filter(element => element.offsetParent !== null)
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
