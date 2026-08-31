import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import type { CodeCopy } from './copy'

const MAX_INSTANCE_NAME_LENGTH = 80

export function InstanceNameDialog({
  copy,
  instanceName,
  onClose,
  onSave,
  returnFocusRef,
}: {
  copy: CodeCopy
  instanceName: string
  onClose: () => void
  onSave: (name: string) => Promise<boolean>
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const [name, setName] = useState(instanceName)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useModalFocusScope<HTMLFormElement>({
    open: true,
    initialFocusRef: inputRef,
    returnFocusRef,
    onEscape: onClose,
    escapeEnabled: !saving,
    dismissOnPointerOutside: !saving,
  })

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setSaveFailed(false)
    if (await onSave(name)) {
      onClose()
      return
    }
    setSaving(false)
    setSaveFailed(true)
  }

  return createPortal(
    <div className="code-brand-backdrop" data-testid="code-instance-name-dialog" role="presentation">
      <form ref={dialogRef} className="code-brand-dialog code-instance-name-dialog" role="dialog" aria-modal="true" aria-labelledby="code-instance-name-title" onSubmit={submit}>
        <h2 id="code-instance-name-title">{copy.instanceNameTitle}</h2>
        <p>{copy.instanceNameDescription}</p>
        <input
          ref={inputRef}
          value={name}
          maxLength={MAX_INSTANCE_NAME_LENGTH}
          placeholder={copy.instanceNamePlaceholder}
          aria-label={copy.instanceNameTitle}
          onChange={event => setName(event.target.value)}
        />
        {saveFailed && <p className="code-instance-name-error" role="alert">{copy.instanceNameSaveFailed}</p>}
        <div className="code-instance-name-actions">
          <button type="button" onClick={onClose} disabled={saving}>{copy.cancel}</button>
          <button type="submit" className="primary" disabled={saving}>{copy.save}</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
