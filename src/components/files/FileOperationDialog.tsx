import { useRef, type RefObject } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
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
  const formRef = useRef<HTMLFormElement | null>(null)
  useInteractionLayer({
    enabled: Boolean(fileOperation && fileOperation.kind !== 'rename'),
    elements: () => [formRef.current],
    dismissOnPointerOutside: fileOperation?.kind === 'delete',
    dismissOnEscape: !fileOperation?.submitting,
    onDismiss: onCancel,
  })
  if (!fileOperation || fileOperation.kind === 'rename') return null

  return (
    <div
      className={fileOperation.kind === 'delete' ? 'code-file-operation-shell delete-confirm' : 'code-file-operation-shell'}
      data-testid="code-file-operation-backdrop"
      onMouseDown={event => {
        event.stopPropagation()
      }}
    >
      <form
        ref={formRef}
        className="code-file-operation-dialog"
        data-testid="code-file-operation-dialog"
        role="dialog"
        aria-modal={fileOperation.kind === 'delete' ? true : undefined}
        aria-busy={fileOperation.submitting}
        aria-labelledby="code-file-operation-title"
        autoComplete="off"
        onMouseDown={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        {fileOperation.kind === 'delete' ? (
          <h2 id="code-file-operation-title">
            {workspaceFileOperationTitle(fileOperation, copy)}
          </h2>
        ) : (
          <label id="code-file-operation-title" htmlFor="code-file-operation-input">
            {workspaceFileOperationTitle(fileOperation, copy)}
          </label>
        )}
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
            type="text"
            inputMode="text"
            ref={inputRef}
            value={fileOperation.name}
            disabled={fileOperation.submitting}
            autoComplete="off"
            aria-autocomplete="none"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            autoFocus
            onInput={event => {
              onInputName(event.currentTarget.value)
            }}
            onChange={event => {
              onUpdateName(event.target.value)
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.stopPropagation()
              onSubmit()
            }}
          />
        )}
        <div className="code-dialog-actions code-rename-actions">
          <button type="button" autoFocus={fileOperation.kind === 'delete'} onClick={onCancel}>{copy.cancel}</button>
          <button
            type="submit"
            className={fileOperation.kind === 'delete' ? 'danger' : 'primary'}
            disabled={fileOperation.submitting || (fileOperation.kind !== 'delete' && !fileOperation.name.trim())}
          >
            {fileOperation.kind === 'delete' ? copy.delete : copy.save}
          </button>
        </div>
      </form>
    </div>
  )
}
