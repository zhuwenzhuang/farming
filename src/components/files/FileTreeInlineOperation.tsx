import type { RefObject } from 'react'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import type { CodeCopy } from '../code/copy'

interface FileTreeInlineOperationProps {
  agentId: string
  copy: CodeCopy
  fileOperation: { name: string }
  inputRef: RefObject<HTMLInputElement | null>
  item: WorkspaceFileTreeNode
  onCancel: () => void
  onInputName: (name: string) => void
  onSubmit: () => Promise<void>
  onUpdateName: (name: string) => void
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
  onUpdateName,
}: FileTreeInlineOperationProps) {
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
        ref={inputRef}
        value={fileOperation.name}
        aria-label={copy.renameEntry(item.name)}
        autoComplete="new-password"
        aria-autocomplete="none"
        autoCapitalize="none"
        autoFocus
        spellCheck={false}
        onInput={event => {
          onInputName(event.currentTarget.value)
        }}
        onChange={event => {
          onUpdateName(event.target.value)
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
