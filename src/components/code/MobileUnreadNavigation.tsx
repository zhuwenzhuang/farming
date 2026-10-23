import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { agentWithCurrentLiveState, useDynamicPinProjectionRevision } from '@/lib/agent-live-state'
import { isCompactViewport, isTouchInputViewport } from '@/lib/responsive-mode'
import { ArrowLeftGlyph, BackToAgentGlyph } from '../IconGlyphs'
import { canStartUnreadSwipe, unreadAgentTargets, unreadSwipeThreshold, type UnreadAgentTarget } from './mobile-unread-navigation'
import type { ProjectGroup } from './types'

interface Props {
  projects: ProjectGroup[]
  activeAgentId: string
  enabled: boolean
  surfaceRef: RefObject<HTMLDivElement | null>
  onOpen: (target: UnreadAgentTarget) => void
  onBack: (agentId: string) => void
  language: 'en' | 'zh'
}

export function MobileUnreadNavigation({ projects, activeAgentId, enabled, surfaceRef, onOpen, onBack, language }: Props) {
  const revision = useDynamicPinProjectionRevision()
  const targets = useMemo(() => {
    void revision
    return unreadAgentTargets(projects.map(project => ({
      ...project, agents: project.agents.map(agentWithCurrentLiveState),
    })), activeAgentId)
  }, [projects, activeAgentId, revision])
  const [preview, setPreview] = useState<{ target: UnreadAgentTarget; ready: boolean } | null>(null)
  const [previousId, setPreviousId] = useState('')
  const latest = useRef({ targets, onOpen, activeAgentId, enabled })
  latest.current = { targets, onOpen, activeAgentId, enabled }
  const open = (target: UnreadAgentTarget) => {
    const current = latest.current
    const fresh = current.targets.find(candidate => candidate.key === target.key)
    if (!current.enabled || !fresh) return
    if (fresh.kind === 'agent') {
      const agent = agentWithCurrentLiveState(fresh.agent)
      if (!agent.unread || agent.archived) return
    }
    setPreviousId(current.activeAgentId)
    current.onOpen(fresh)
  }
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!previousId) return
    const timer = window.setTimeout(() => setPreviousId(''), 8000)
    return () => window.clearTimeout(timer)
  }, [previousId])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !enabled) return
    let gesture: { x: number; y: number; id: number; distance: number; locked: boolean; threshold: number; target: UnreadAgentTarget } | null = null
    const reset = () => {
      gesture = null
      surface.style.removeProperty('--unread-swipe-offset')
      surface.removeAttribute('data-unread-swipe')
      setPreview(null)
    }
    const start = (event: TouchEvent) => {
      reset()
      if (event.touches.length !== 1 || !isCompactViewport() || !isTouchInputViewport()
        || !canStartUnreadSwipe(event.target, surface)) return
      const target = latest.current.targets[0]
      const touch = event.touches[0]
      const box = surface.getBoundingClientRect()
      if (!target || !touch || touch.clientX < box.left + 24 || touch.clientX > box.right - 24) return
      gesture = { x: touch.clientX, y: touch.clientY, id: touch.identifier, distance: 0,
        locked: false, threshold: unreadSwipeThreshold(box.width), target }
    }
    const move = (event: TouchEvent) => {
      if (!gesture) return
      if (event.touches.length !== 1 || String(window.getSelection()).length
        || !latest.current.targets.some(target => target.key === gesture?.target.key)) { reset(); return }
      const touch = event.touches[0]
      if (!touch || touch.identifier !== gesture.id) { reset(); return }
      const dx = gesture.x - touch.clientX
      const dy = Math.abs(gesture.y - touch.clientY)
      if (!gesture.locked) {
        if (dy > 10 && dy >= Math.abs(dx) || dx < -10) { reset(); return }
        if (dx < 12 || dx < dy * 1.5) return
        gesture.locked = true
      }
      if (!event.cancelable) { reset(); return }
      event.preventDefault()
      gesture.distance = Math.max(0, dx)
      surface.setAttribute('data-unread-swipe', '')
      surface.style.setProperty('--unread-swipe-offset', `${-Math.min(160, gesture.distance)}px`)
      setPreview({ target: gesture.target, ready: gesture.distance >= gesture.threshold })
    }
    const end = (event: TouchEvent) => {
      const target = gesture?.locked && gesture.distance >= gesture.threshold && event.touches.length === 0
        ? gesture.target : null
      reset()
      if (target && !String(window.getSelection()).length) openRef.current(target)
    }
    surface.addEventListener('touchstart', start, { passive: true })
    surface.addEventListener('touchmove', move, { passive: false })
    surface.addEventListener('touchend', end)
    surface.addEventListener('touchcancel', reset)
    const resize = new ResizeObserver(reset)
    resize.observe(surface)
    return () => {
      surface.removeEventListener('touchstart', start)
      surface.removeEventListener('touchmove', move)
      surface.removeEventListener('touchend', end)
      surface.removeEventListener('touchcancel', reset)
      resize.disconnect()
      reset()
    }
  }, [activeAgentId, enabled, surfaceRef])

  const previousExists = projects.some(project => project.agents.some(agent => agent.id === previousId && !agent.archived))
  const showBack = previousId !== activeAgentId && previousExists
  if (!enabled || (!targets.length && !showBack)) return null
  const zh = language === 'zh'
  const next = targets[0]
  return <>
    <nav className="code-mobile-unread-nav code-content-toolbar" data-testid="code-mobile-unread-nav"
      aria-label={zh ? '未读 Agent 导航' : 'Unread Agent navigation'}>
      {showBack && <button type="button" className="code-content-toolbar-text code-mobile-unread-back"
        onClick={() => { onBack(previousId); setPreviousId('') }}>
        <BackToAgentGlyph /><span>{zh ? '返回上一个' : 'Go back'}</span>
      </button>}
      {next && <button type="button" className="code-content-toolbar-text" data-testid="code-mobile-next-unread"
        aria-label={`${zh ? '下一未读' : 'Next unread'}: ${next.title} · ${next.project}`}
        onClick={() => open(next)}>
        <ArrowLeftGlyph /><span>{zh ? '下一未读' : 'Next unread'} · {targets.length}</span>
      </button>}
    </nav>
    {preview && surfaceRef.current && createPortal(
      <aside className="code-mobile-unread-preview" data-testid="code-mobile-unread-preview" aria-live="polite">
        <span>{zh ? '下一个未读 Agent' : 'Next unread Agent'}</span>
        <strong>{preview.target.title}</strong><span>{preview.target.project}</span>
        <span className={preview.ready ? 'ready' : ''}>{preview.ready
          ? (zh ? '松开切换' : 'Release to switch') : (zh ? '继续左滑' : 'Swipe further')}</span>
      </aside>, surfaceRef.current,
    )}
  </>
}
