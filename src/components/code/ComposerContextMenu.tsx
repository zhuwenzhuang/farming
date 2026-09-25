import { useEffect, useRef } from 'react'
import { FileGlyph, FolderGlyph } from '@/components/IconGlyphs'
import type { ComposerContextCandidate } from './useComposerContextCompletion'

export function ComposerContextMenu({ candidates, status, truncated, activeIndex, onActiveIndexChange, onChoose }: {
  candidates: ComposerContextCandidate[]
  status: 'loading' | 'ready' | 'error'
  truncated: boolean
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onChoose: (candidate: ComposerContextCandidate) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, candidates])
  return (
    <div ref={menuRef} className="code-menu-surface code-slash-menu code-composer-menu" data-testid="code-composer-context-menu" role="listbox" aria-label="Files and folders">
      <div className="code-slash-menu-header">Files and folders</div>
      {status !== 'ready' || candidates.length === 0 ? (
        <div className="code-slash-command-loading" role={status === 'error' ? 'alert' : 'status'}>
          {status === 'loading' ? 'Searching files…' : status === 'error' ? 'File search unavailable' : 'No matching files or folders'}
        </div>
      ) : null}
      {candidates.map((candidate, index) => (
        <button key={`${candidate.kind}:${candidate.path}`} type="button" role="option"
          className={`code-menu-item code-slash-command ${index === activeIndex ? 'active' : ''}`}
          data-testid="code-composer-context-option" aria-selected={index === activeIndex}
          onMouseDown={event => event.preventDefault()}
          onMouseMove={() => onActiveIndexChange(index)}
          onClick={() => onChoose(candidate)}>
          <span className="code-slash-command-icon" aria-hidden="true">{candidate.kind === 'directory' ? <FolderGlyph /> : <FileGlyph />}</span>
          <span className="code-slash-command-copy"><span className="code-slash-command-title"><strong>{candidate.path}</strong></span></span>
          <span className="code-slash-command-source">{candidate.kind === 'directory' ? 'Folder' : 'File'}</span>
        </button>
      ))}
      {truncated ? <div className="code-slash-command-loading" role="status">More matches. Narrow the query.</div> : null}
    </div>
  )
}
