import { useLayoutEffect, type RefObject } from 'react'
import {
  workspaceFileOperationSelectionEnd,
  type WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import type { CodeCopy } from '../code/copy'

interface FileTreeInlineOperationProps {
  agentId: string
  copy: CodeCopy
  fileOperation: WorkspaceFileOperationState
  inputRef: RefObject<HTMLInputElement | null>
  item: WorkspaceFileTreeNode
  onCancel: () => void
  onInputName: (name: string) => void
  onSubmit: () => Promise<void>
}

export function FileTreeInlineOperation({
  agentId,
  copy,
  fileOperation,
  inputRef,
  item,
  onCancel,
  onInputName,
  onSubmit,
}: FileTreeInlineOperationProps) {
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    if (document.activeElement === input) {
      input.setSelectionRange(0, workspaceFileOperationSelectionEnd(fileOperation))
    }
  }, [fileOperation.item?.path, inputRef])

  return (
    <form
      className="code-file-inline-operation"
      data-testid="code-file-inline-operation"
      style={{ gridColumn: '3 / -1' }}
      autoComplete="off"
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault()
        event.stopPropagation()
        void onSubmit()
      }}
    >
      <input
        id="code-file-operation-input"
        data-testid="code-file-operation-input"
        name={`farming-file-${agentId}-rename`}
        type="text"
        inputMode="text"
        ref={inputRef}
        defaultValue={fileOperation.name}
        aria-label={copy.renameEntry(item.name)}
        autoComplete="off"
        aria-autocomplete="none"
        autoCapitalize="none"
        autoCorrect="off"
        autoFocus
        spellCheck={false}
        enterKeyHint="done"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        onInput={event => {
          onInputName(event.currentTarget.value)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          void onSubmit()
        }}
      />
    </form>
  )
}
