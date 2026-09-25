import { useRef, useState } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { CloseGlyph, FileGlyph, FolderGlyph, SkillGlyph, SquareGlyph } from '@/components/IconGlyphs'
import type { ComposerContextReference } from './composer-message'

export interface ComposerAttachmentView {
  id: string
  kind: 'image' | 'audio'
  name: string
  status: 'uploading' | 'ready' | 'error'
  previewUrl?: string
  error?: string
}

interface ComposerAttachmentsProps {
  attachments: ComposerAttachmentView[]
  onRemove: (id: string) => void
  references?: ComposerContextReference[]
  onRemoveReference?: (id: string) => void
  unavailableReferenceIds?: string[]
}

export function ComposerAttachments({ attachments, onRemove, references = [], onRemoveReference, unavailableReferenceIds = [] }: ComposerAttachmentsProps) {
  const [expanded, setExpanded] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const preview = references.find(reference => reference.id === previewId)
  useInteractionLayer({
    enabled: Boolean(preview),
    elements: () => [stripRef.current],
    onDismiss: () => setPreviewId(null),
  })
  if (attachments.length === 0 && references.length === 0) return null
  const visibleReferences = expanded ? references : references.slice(0, 4)

  return (
    <div ref={stripRef} className={`code-composer-attachments ${references.length > 0 ? 'has-context' : ''} ${expanded ? 'expanded' : ''}`} data-testid="code-composer-attachments">
      {attachments.map(attachment => {
        const hasImagePreview = attachment.kind === 'image' && Boolean(attachment.previewUrl)
        const attachmentClassName = [
          'code-composer-attachment',
          hasImagePreview ? 'image' : 'chip',
          attachment.status,
        ].join(' ')

        return (
          <div
            key={attachment.id}
            className={attachmentClassName}
            data-testid="code-composer-attachment"
          >
            {hasImagePreview ? (
              <div className="code-composer-attachment-preview" data-testid="code-composer-attachment-preview">
                <img src={attachment.previewUrl} alt={attachment.name} />
              </div>
            ) : (
              <span className="code-composer-attachment-fallback" aria-hidden="true"><SquareGlyph /></span>
            )}
            {!hasImagePreview ? (
              <span className="code-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
            ) : null}
            {attachment.status !== 'ready' && (
              <span
                className="code-composer-attachment-status"
                role={attachment.status === 'error' ? 'alert' : 'status'}
                title={attachment.status === 'error' ? 'Remove this attachment and try again' : undefined}
              >
                {attachment.status === 'uploading' ? 'Uploading' : 'Upload failed'}
              </span>
            )}
            <button
              type="button"
              className="code-composer-attachment-remove"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => onRemove(attachment.id)}
            >
              <CloseGlyph />
            </button>
          </div>
        )
      })}
      {visibleReferences.map(reference => (
        <div key={reference.id} className={`code-composer-attachment chip context ${unavailableReferenceIds.includes(reference.id) ? 'error' : ''}`} data-testid="code-composer-context-chip">
          <button type="button" className="code-composer-context-preview-button" onClick={() => setPreviewId(current => current === reference.id ? null : reference.id)}
            title={reference.path || reference.command || reference.label} aria-label={`Inspect ${reference.label}`}>
            <span aria-hidden="true">{reference.kind === 'skill' ? <SkillGlyph /> : reference.kind === 'directory' ? <FolderGlyph /> : <FileGlyph />}</span>
            <span className="code-composer-attachment-name">{reference.label}</span>
          </button>
          <button type="button" className="code-composer-attachment-remove" aria-label={`Remove ${reference.label}`}
            onClick={() => { setPreviewId(null); onRemoveReference?.(reference.id) }}><CloseGlyph /></button>
        </div>
      ))}
      {references.length > 4 ? <button type="button" className="code-composer-context-overflow" onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show less' : `+${references.length - 4}`}
      </button> : null}
      {preview ? <div className="code-menu-surface code-composer-context-preview" role="dialog" aria-label={preview.label}>
        <strong>{preview.label}</strong>
        <span>{preview.kind === 'skill' ? preview.command : `${preview.workspace}/${preview.path}`}</span>
        {preview.kind === 'selection' ? <pre>{preview.text}</pre> : null}
        {unavailableReferenceIds.includes(preview.id) ? <small>This reference is unavailable. Remove it or restore access before sending.</small> : null}
      </div> : null}
    </div>
  )
}
