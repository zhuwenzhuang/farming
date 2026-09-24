import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { isTouchInputViewport } from '@/lib/responsive-mode'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import { workspaceFileHeaderDirectory, workspaceFileHeaderLabel, workspaceFileHeaderParents } from '@/lib/workspace-file-header-context'

export interface FileHeaderPathProps {
  treeData: WorkspaceFileTreeNode[]
  openDirectoryPaths: ReadonlySet<string>
  treeViewportRef: RefObject<HTMLDivElement | null>
  rowHeight: number
}

export function FileHeaderPath({ treeData, openDirectoryPaths, treeViewportRef, rowHeight, label }: FileHeaderPathProps & { label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState('')
  const parents = useMemo(() => workspaceFileHeaderParents(treeData, openDirectoryPaths), [treeData, openDirectoryPaths])
  // The tree is a later sibling of the header. Wait until the whole commit has
  // attached its ref, including when Files reopens with unchanged cached data.
  useEffect(() => {
    const viewport = treeViewportRef.current
    const header = host.current?.closest<HTMLElement>('.code-files-header')
    const scroller = header?.closest<HTMLElement>('.code-project-list')
    if (!viewport || !header || !scroller) {
      setPath('')
      return
    }
    let frame = 0
    const refresh = () => {
      frame = 0
      const bounds = scroller.getBoundingClientRect()
      const heading = header.getBoundingClientRect()
      const next = heading.bottom <= bounds.top ? '' : workspaceFileHeaderDirectory(
        parents, viewport.getBoundingClientRect().top,
        Math.max(bounds.top, heading.bottom), bounds.bottom, rowHeight,
      )
      setPath(current => current === next ? current : next)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh)
    }
    refresh()
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    observer.observe(scroller)
    const project = header.closest('.code-project-group')
    if (project) observer.observe(project)
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [parents, rowHeight, treeViewportRef])
  return <div ref={host} className="code-file-header-context">
    {path && <PathLabel key={path} path={path} label={label} />}
  </div>
}

function PathLabel({ path, label }: { path: string; label: string }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const id = useId()
  const [text, setText] = useState(path)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = anchor.current
    if (!element) return
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    const fit = () => {
      context.font = getComputedStyle(element).font
      setText(workspaceFileHeaderLabel(path, element.clientWidth, value => context.measureText(value).width))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [path])
  useInteractionLayer({
    enabled: open,
    elements: () => [anchor.current, tip.current],
    onDismiss: () => setOpen(false),
  })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!anchor.current || !tip.current) return
      const rect = anchor.current.getBoundingClientRect()
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      tip.current.style.maxWidth = `${Math.min(400, width - 16)}px`
      tip.current.style.maxHeight = `${height - 16}px`
      const bounds = tip.current.getBoundingClientRect()
      tip.current.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - bounds.width - 8))}px`
      tip.current.style.top = `${Math.max(top + 8, Math.min(rect.bottom, top + height - bounds.height - 8))}px`
    }
    const close = (event: Event) => {
      if (event.target instanceof Node && tip.current?.contains(event.target)) return
      setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', close, true)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', close, true)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [open])
  return <>
    <button ref={anchor} type="button" className="code-file-header-path" data-testid="code-file-header-path"
      data-path={path} aria-label={`${label}: ${path}`} aria-describedby={open ? id : undefined}
      onPointerDown={event => {
        if (!isTouchInputViewport()) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
      }}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true) }}
      onPointerLeave={event => { if (!(event.relatedTarget instanceof Node && tip.current?.contains(event.relatedTarget))) setOpen(false) }}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }}
      onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      {text}
    </button>
    {open && createPortal(<div ref={tip} id={id} role="tooltip" className="code-file-header-path-tooltip"
      data-testid="code-file-header-path-tooltip"
      onPointerLeave={event => { if (!(event.relatedTarget instanceof Node && anchor.current?.contains(event.relatedTarget))) setOpen(false) }}>
      <div>{label}</div><span>{path}</span>
    </div>, document.body)}
  </>
}
