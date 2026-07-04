import type { RefObject } from 'react'
import {
  workspaceFileOperationTitle,
  type WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { CodeCopy } from '../code/copy'

interface FileOperationDialogProps {
  agentId: string
  copy: CodeCopy
  fileOperation: WorkspaceFileOperationState | null
  inputRef: RefObject<HTMLInputElement | null>
  onCancel: () => void
  onInputName: (name: string) => void
  onSubmit: () => void
  onUpdateName: (name: string) => void
}

export function FileOperationDialog({
  agentId,
  copy,
  fileOperation,
  inputRef,
  onCancel,
  onInputName,
  onSubmit,
  onUpdateName,
}: FileOperationDialogProps) {
  if (!fileOperation || fileOperation.kind === 'rename') return null

  return (
    <div
      className={fileOperation.kind === 'delete' ? 'code-file-operation-shell delete-confirm' : 'code-file-operation-shell'}
      data-testid="code-file-operation-backdrop"
      onMouseDown={event => {
        event.stopPropagation()
        if (fileOperation.kind === 'delete' && event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <form
        className="code-file-operation-dialog"
        data-testid="code-file-operation-dialog"
        role="dialog"
        aria-labelledby="code-file-operation-title"
        autoComplete="off"
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <label id="code-file-operation-title" htmlFor="code-file-operation-input">
          {workspaceFileOperationTitle(fileOperation, copy)}
        </label>
        {fileOperation.kind === 'delete' ? (
          <p className="code-file-operation-text">
            {fileOperation.item?.type === 'directory'
              ? copy.deleteFolderContents(fileOperation.item?.path)
              : copy.deleteFile(fileOperation.item?.path)}
          </p>
        ) : (
          <input
            id="code-file-operation-input"
            data-testid="code-file-operation-input"
            name={`farming-file-${agentId}-${fileOperation.kind}`}
            ref={inputRef}
            value={fileOperation.name}
            autoComplete="new-password"
            aria-autocomplete="none"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            onInput={event => {
              onInputName(event.currentTarget.value)
            }}
            onChange={event => {
              onUpdateName(event.target.value)
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.stopPropagation()
              onSubmit()
            }}
          />
        )}
        <div className="code-rename-actions">
          <button type="button" onClick={onCancel}>{copy.cancel}</button>
          <button
            type="submit"
            className={fileOperation.kind === 'delete' ? 'danger' : 'primary'}
            disabled={fileOperation.kind !== 'delete' && !fileOperation.name.trim()}
          >
            {fileOperation.kind === 'delete' ? copy.delete : copy.save}
          </button>
        </div>
      </form>
    </div>
  )
}
