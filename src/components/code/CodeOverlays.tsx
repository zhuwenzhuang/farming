import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import type { Agent } from '@/types/agent'
import {
  agentSessionWorkingDirectory,
  projectWorkspaceForAgent,
} from './model'
import {
  capabilitiesForAgent,
  projectCanArchive,
  projectCanDeleteWorktree,
} from './capabilities'
import {
  compactContextMenuEntries,
  type ContextMenuEntry,
} from './menu-model'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'

type AgentMenuState = { agentId: string; x: number; y: number } | null
type ProjectMenuState = { projectId: string; x: number; y: number } | null
type AgentSessionMenuState = { provider: string; sessionId: string; x: number; y: number } | null

type RenameDialogState =
  | { kind: 'agent'; agentId: string; title: string }
  | { kind: 'project'; projectId: string; workspace: string; title: string }

interface KillDialogState {
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
  killDialog: KillDialogState | null
  deleteWorktreeDialog: DeleteWorktreeDialogState | null
  copyNotice: CopyNoticeState | null
  contextMenuRef: RefObject<HTMLDivElement | null>
  renameDialogRef: RefObject<HTMLFormElement | null>
  renameInputRef: RefObject<HTMLInputElement | null>
  killDialogRef: RefObject<HTMLDivElement | null>
  killCancelButtonRef: RefObject<HTMLButtonElement | null>
  deleteWorktreeDialogRef: RefObject<HTMLDivElement | null>
  deleteWorktreeCancelButtonRef: RefObject<HTMLButtonElement | null>
  onContextMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onUpdateAgentFlags: (flags: Partial<Pick<Agent, 'pinned' | 'unread' | 'archived'>>) => void
  onRenameAgent: () => void
  onRenameProject: () => void
  onCopyAgentWorkingDirectory: () => void
  onForkAgent: (mode: 'same-worktree' | 'new-worktree') => void
  onKillAgent: () => void
  onOpenSession: (provider: string, sessionId: string) => void
  onToggleSessionPinned: () => void
  onArchiveSession: () => void
  onCopySessionWorkingDirectory: () => void
  onArchiveProject: () => void
  onRemoveProject: () => void
  onDeleteWorktree: () => void
  onCloseRenameDialog: () => void
  onRenameDialogTitleChange: (title: string) => void
  onSubmitRenameDialog: () => void
  onCloseKillDialog: () => void
  onSubmitKillDialog: () => void
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
  killDialog,
  deleteWorktreeDialog,
  copyNotice,
  contextMenuRef,
  renameDialogRef,
  renameInputRef,
  killDialogRef,
  killCancelButtonRef,
  deleteWorktreeDialogRef,
  deleteWorktreeCancelButtonRef,
  onContextMenuKeyDown,
  onUpdateAgentFlags,
  onRenameAgent,
  onRenameProject,
  onCopyAgentWorkingDirectory,
  onForkAgent,
  onKillAgent,
  onOpenSession,
  onToggleSessionPinned,
  onArchiveSession,
  onCopySessionWorkingDirectory,
  onArchiveProject,
  onRemoveProject,
  onDeleteWorktree,
  onCloseRenameDialog,
  onRenameDialogTitleChange,
  onSubmitRenameDialog,
  onCloseKillDialog,
  onSubmitKillDialog,
  onCloseDeleteWorktreeDialog,
  onSubmitDeleteWorktreeDialog,
  copy,
}: CodeOverlaysProps) {
  const agentCapabilities = capabilitiesForAgent(contextMenuAgent)
  const canArchiveProject = projectCanArchive(contextMenuProject)
  const canDeleteWorktree = projectCanDeleteWorktree(contextMenuProject)
  const agentMenuEntries = compactContextMenuEntries([
    {
      type: 'item',
      id: 'pin-agent',
      label: contextMenuAgent?.pinned ? copy.unpinAgent : copy.pinAgent,
      hidden: !agentCapabilities.actions.pin,
      onSelect: () => onUpdateAgentFlags({ pinned: !contextMenuAgent?.pinned }),
    },
    {
      type: 'item',
      id: 'rename-agent',
      label: copy.renameAgent,
      hidden: !agentCapabilities.actions.rename,
      onSelect: onRenameAgent,
    },
    {
      type: 'item',
      id: 'archive-agent',
      label: copy.archiveAgent,
      hidden: !agentCapabilities.actions.archive,
      onSelect: () => onUpdateAgentFlags({ archived: true }),
    },
    {
      type: 'item',
      id: 'toggle-agent-unread',
      label: contextMenuAgent?.unread ? copy.markAsRead : copy.markAsUnread,
      hidden: !agentCapabilities.actions.markUnread,
      onSelect: () => onUpdateAgentFlags({ unread: !contextMenuAgent?.unread }),
    },
    { type: 'separator', id: 'agent-copy-separator' },
    {
      type: 'item',
      id: 'copy-agent-working-directory',
      label: copy.copyWorkingDirectory,
      hidden: !agentCapabilities.actions.copyWorkingDirectory,
      onSelect: onCopyAgentWorkingDirectory,
    },
    { type: 'separator', id: 'agent-fork-separator' },
    {
      type: 'item',
      id: 'fork-same-worktree',
      label: copy.forkSameWorktree,
      hidden: !agentCapabilities.actions.forkSameWorktree,
      onSelect: () => onForkAgent('same-worktree'),
    },
    {
      type: 'item',
      id: 'fork-new-worktree',
      label: copy.forkNewWorktree,
      hidden: !agentCapabilities.actions.forkNewWorktree,
      onSelect: () => onForkAgent('new-worktree'),
    },
    {
      type: 'item',
      id: 'kill-agent',
      label: copy.killAgent,
      danger: true,
      hidden: !agentCapabilities.actions.kill,
      onSelect: onKillAgent,
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
      id: 'rename-project',
      label: copy.renameProject,
      icon: 'rename',
      hidden: !contextMenuProject?.workspace,
      onSelect: onRenameProject,
    },
    {
      type: 'item',
      id: 'archive-project',
      label: copy.archiveChats,
      icon: 'archive',
      disabled: !canArchiveProject,
      onSelect: onArchiveProject,
    },
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
      {killDialog && (
        <div className="code-rename-backdrop" data-testid="code-kill-backdrop" onMouseDown={onCloseKillDialog}>
          <div
            className="code-rename-dialog code-kill-dialog"
            data-testid="code-kill-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-kill-title"
            ref={killDialogRef}
            onMouseDown={event => event.stopPropagation()}
            onKeyDownCapture={event => trapFocusInContainer(event, killDialogRef.current)}
            onKeyDown={event => trapFocusInContainer(event, killDialogRef.current)}
          >
            <h2 id="code-kill-title">{copy.killAgentQuestion}</h2>
            <p>{copy.stopAgentDescription(killDialog.title)}</p>
            <div className="code-rename-actions">
              <button type="button" ref={killCancelButtonRef} onClick={onCloseKillDialog} autoFocus>{copy.cancel}</button>
              <button type="button" className="danger" onClick={onSubmitKillDialog}>{copy.killAgent}</button>
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

function ContextMenuIcon({ kind }: { kind: 'rename' | 'archive' | 'trash' }) {
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

export function agentContextWorkingDirectory(agent: Agent) {
  return projectWorkspaceForAgent(agent)
}

export function sessionContextWorkingDirectory(session: AgentSessionHistoryItem) {
  return agentSessionWorkingDirectory(session)
}
