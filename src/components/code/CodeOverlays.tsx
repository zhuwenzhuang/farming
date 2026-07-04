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

interface RenameDialogState {
  agentId: string
  title: string
}

interface KillDialogState {
  agentId: string
  title: string
}

interface DeleteWorktreeDialogState {
  workspace: string
  dirtyEntries: string[]
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
  onCopyAgentWorkingDirectory: () => void
  onForkAgent: (mode: 'same-worktree' | 'new-worktree') => void
  onKillAgent: () => void
  onOpenSession: (provider: string, sessionId: string) => void
  onToggleSessionPinned: () => void
  onArchiveSession: () => void
  onCopySessionWorkingDirectory: () => void
  onStartAgentInProject: () => void
  onArchiveProject: () => void
  onDeleteWorktreeProject: () => void
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
  onCopyAgentWorkingDirectory,
  onForkAgent,
  onKillAgent,
  onOpenSession,
  onToggleSessionPinned,
  onArchiveSession,
  onCopySessionWorkingDirectory,
  onStartAgentInProject,
  onArchiveProject,
  onDeleteWorktreeProject,
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
      id: 'new-agent',
      label: copy.newAgent,
      onSelect: onStartAgentInProject,
    },
    {
      type: 'item',
      id: 'archive-project',
      label: copy.archiveProject,
      disabled: !canArchiveProject,
      onSelect: onArchiveProject,
    },
    {
      type: 'item',
      id: 'delete-worktree',
      label: copy.deleteWorktree,
      danger: true,
      hidden: !canDeleteWorktree,
      onSelect: onDeleteWorktreeProject,
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
          className="code-context-menu"
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
              {copy.renameAgent}
            </label>
            <input
              id="code-rename-input"
              ref={renameInputRef}
              data-testid="code-rename-input"
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
            <p>{copy.deleteWorktreeDirtyDescription(deleteWorktreeDialog.dirtyEntries.length)}</p>
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
            {entry.label}
          </button>
        )
      })}
    </>
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
