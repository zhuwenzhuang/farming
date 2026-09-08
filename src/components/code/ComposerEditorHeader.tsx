import { ChevronDownGlyph, ExpandEditorGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from './copy'

export function ComposerEditorHeader({ expanded, onToggle, copy }: {
  expanded: boolean
  onToggle: () => void
  copy: CodeCopy
}) {
  return (
    <div className="code-composer-editor-header">
      <button
        type="button"
        className="code-composer-editor-toggle"
        data-testid="code-composer-editor-toggle"
        aria-label={expanded ? copy.closeExpandedComposer : copy.expandComposer}
        title={expanded ? copy.closeExpandedComposer : copy.expandComposer}
        aria-expanded={expanded}
        onPointerDown={event => event.preventDefault()}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownGlyph /> : <ExpandEditorGlyph />}
        {expanded ? <span>{copy.closeExpandedComposer}</span> : null}
      </button>
      {expanded ? <span className="code-composer-editor-title">{copy.editMessage}</span> : null}
    </div>
  )
}
