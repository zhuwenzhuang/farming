import { ContentViewerDialog } from '@/components/ContentViewerDialog'
import { attachmentPreviewUrl } from './composer-intake'
import { useRef, useState } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { CloseGlyph, FileGlyph, FolderGlyph, SkillGlyph, SquareGlyph } from '@/components/IconGlyphs'
import type { ComposerContextReference } from './composer-message'

export interface ComposerAttachmentView {
  id: string
  kind: 'image' | 'audio'
  name: string
  status: 'uploading' | 'ready' | 'error'
  path?: string
  previewUrl?: string
  error?: string
}

interface ComposerAttachmentsProps {
  attachments: ComposerAttachmentView[]
  onRemove: (id: string) => void
  references?: ComposerContextReference[]
  onRemoveReference?: (id: string) => void
  onRestorePastedText?: (id: string) => void
  restorePastedTextLabel?: string
  extractedTextLabel?: string
  downloadOriginalLabel?: string
  unavailableReferenceIds?: string[]
}

export function ComposerAttachments({ attachments, onRemove, references = [], onRemoveReference, onRestorePastedText, restorePastedTextLabel = 'Show in text field', extractedTextLabel = 'Extracted text', downloadOriginalLabel = 'Download original', unavailableReferenceIds = [] }: ComposerAttachmentsProps) {
  const [imagePreview, setImagePreview] = useState<ComposerAttachmentView | null>(null)
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null)
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
    <div ref={stripRef} className={`code-composer-attachments ${references.length > 0 ? 'has-context' : ''} ${expanded ? 'expanded' : ''} ${references.some(reference => (reference.kind === 'quote' || reference.kind === 'pasted-text' || reference.kind === 'document')) ? 'has-quotes' : ''}`} data-testid="code-composer-attachments">
      {attachments.map(attachment => {
        const previewUrl = attachment.previewUrl || attachmentPreviewUrl(attachment.path)
        const hasImagePreview = attachment.kind === 'image' && Boolean(previewUrl)
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
              <button type="button" className="code-composer-attachment-preview" data-testid="code-composer-attachment-preview" aria-label={`Preview ${attachment.name}`} onClick={event => { imageTriggerRef.current = event.currentTarget; setImagePreview({ ...attachment, previewUrl }) }}>
                <img src={previewUrl} alt={attachment.name} />
              </button>
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
                title={attachment.error}
              >
                {attachment.status === 'uploading' ? 'Uploading' : attachment.error || 'Upload failed'}
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
      {visibleReferences.map(reference => (reference.kind === 'quote' || reference.kind === 'pasted-text' || reference.kind === 'document') ? (
        <div key={reference.id} className="code-composer-quote" data-testid={reference.kind === 'document' ? 'code-composer-document' : reference.kind === 'pasted-text' ? 'code-composer-pasted-text' : 'code-composer-quote'}>
          {reference.kind === 'document' && reference.status !== 'ready' ? <span className="code-composer-document-status" role={reference.status === 'error' ? 'alert' : 'status'}>{reference.status === 'error' ? reference.error : 'Processing document…'}</span> : null}
          <details>
            <summary>{reference.label}<span className="code-composer-quote-excerpt">{reference.text}</span></summary>
            {reference.kind === 'document' && reference.text ? <small>{extractedTextLabel}</small> : null}
            <pre>{reference.text}</pre>
            {reference.kind === 'document' && reference.path ? <a href={attachmentPreviewUrl(reference.path)} download={reference.label}>{downloadOriginalLabel}</a> : null}
          </details>
          {reference.kind === 'pasted-text' && onRestorePastedText ? (
            <button type="button" className="code-composer-context-overflow" onClick={() => onRestorePastedText(reference.id)}>
              {restorePastedTextLabel}
            </button>
          ) : null}
          <button type="button" className="code-composer-attachment-remove" aria-label={`Remove ${reference.label}`}
            onClick={() => onRemoveReference?.(reference.id)}><CloseGlyph /></button>
        </div>
      ) : (
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
      {imagePreview ? <ContentViewerDialog title={imagePreview.name} closeLabel="Close preview" onClose={() => setImagePreview(null)} returnFocusRef={imageTriggerRef} testId="composer-image-viewer">
        <div className="code-content-viewer-image"><img src={imagePreview.previewUrl} alt={imagePreview.name} /></div>
      </ContentViewerDialog> : null}
      {preview ? <div className="code-menu-surface code-composer-context-preview" role="dialog" aria-label={preview.label}>
        <strong>{preview.label}</strong>
        <span>{preview.kind === 'skill' ? preview.command : `${preview.workspace}/${preview.path}`}</span>
        {preview.kind === 'selection' ? <pre>{preview.text}</pre> : null}
        {unavailableReferenceIds.includes(preview.id) ? <small>This reference is unavailable. Remove it or restore access before sending.</small> : null}
      </div> : null}
    </div>
  )
}
