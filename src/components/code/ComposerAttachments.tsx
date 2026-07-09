import { CloseGlyph, SquareGlyph } from '@/components/IconGlyphs'

export interface ComposerAttachmentView {
  id: string
  kind: 'image'
  name: string
  status: 'uploading' | 'ready' | 'error'
  previewUrl?: string
  error?: string
}

interface ComposerAttachmentsProps {
  attachments: ComposerAttachmentView[]
  onRemove: (id: string) => void
}

export function ComposerAttachments({ attachments, onRemove }: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <div className="code-composer-attachments" data-testid="code-composer-attachments">
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
            <span className="code-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
            {attachment.status !== 'ready' && (
              <span className="code-composer-attachment-status">
                {attachment.status === 'uploading' ? 'Uploading' : 'Failed'}
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
    </div>
  )
}
