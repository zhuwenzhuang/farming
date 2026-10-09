import { useEffect, useRef, useState } from 'react'
import { CheckGlyph, ChevronDownGlyph } from '@/components/IconGlyphs'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { loadReviewComparisonSources, type ReviewComparisonSources } from '@/lib/review/api'
import '@/components/CodeSelect.css'

type Props = {
  disabled: boolean
  label: string
  revision: string
  root: string
  side: 'base' | 'head'
  onSelect: (revision: string) => void
}

export function ReviewEndpointPicker({ disabled, label, revision, root, side, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<ReviewComparisonSources | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const boundaryRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const name = side === 'base' ? 'Base (left)' : 'Candidate (right)'
  useInteractionLayer({
    enabled: open,
    elements: () => [boundaryRef.current],
    onDismiss: () => setOpen(false),
    returnFocus: () => triggerRef.current,
  })
  useEffect(() => {
    if (!open) return
    let active = true
    setSources(null)
    setError('')
    void loadReviewComparisonSources({ root })
      .then(result => { if (active) setSources(result) })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load versions') })
    return () => { active = false }
  }, [open, root, retry])
  useEffect(() => {
    if (open && sources && document.activeElement === triggerRef.current) {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    }
  }, [open, sources])
  const toggle = () => { setSources(null); setError(''); setOpen(current => !current) }
  const select = (value: string) => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
    onSelect(value)
  }
  const option = (value: string, text: string) => (
    <button type="button" role="menuitemradio" key={`${value}:${text}`} title={text} aria-checked={value === revision} onClick={() => select(value)}>
      <span>{text}</span>{value === revision ? <CheckGlyph /> : null}
    </button>
  )
  return (
    <div className={`code-select toolbar ${open ? 'open' : ''} review-source-control review-endpoint-picker ${side}`} ref={boundaryRef}>
      <span className="code-select-label">{name}</span>
      <button ref={triggerRef} type="button" className="code-field code-select-trigger" aria-label={`Change ${name}`} title={`${label}\n${revision}`} aria-expanded={open} aria-haspopup="menu" disabled={disabled} onClick={toggle} onKeyDown={event => {
        if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); toggle() }
      }}>
        <span className="code-select-value">{label}</span><span className="code-select-chevron" aria-hidden="true"><ChevronDownGlyph /></span>
      </button>
      {open ? <div ref={menuRef} className="code-menu-surface code-menu-list review-source-menu review-endpoint-menu" role="menu" aria-label={`Choose ${name}`} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if (!items.length) return
        event.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
        items[next]?.focus({ preventScroll: true })
      }}>
        {error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>RETRY</button></p> : !sources ? <p role="status">Loading versions…</p> : <>
          {option(revision, `Current · ${label}`)}
          {side === 'head' ? option('now', 'Latest working tree · capture now') : null}
          {sources.staged.head ? option(sources.staged.head, `Index snapshot · ${sources.staged.head.slice(0, 12)}`) : <p>{sources.staged.unavailableReason}</p>}
          <div className="review-source-submenu"><div tabIndex={0} aria-label={`${name} commits`}>
            {sources.commits.flatMap(source => source.head ? [option(source.head, source.label)] : [])}
          </div></div>
        </>}
      </div> : null}
    </div>
  )
}
