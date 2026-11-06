import { InteractionHistory } from './interaction-history'
import { TOUCH_PRIMARY_INPUT_QUERY } from './responsive-mode'

export type InteractionDismissReason = 'outside-pointer' | 'escape' | 'browser-back'

export interface InteractionLayer {
  modal?: boolean
  /** Complete surfaces, including scroll containers, triggers and portals. */
  elements: () => readonly (Element | null | undefined)[]
  onDismiss: (reason: InteractionDismissReason) => void
  dismissOnPointerOutside?: boolean
  dismissOnEscape?: boolean
  returnFocus?: () => HTMLElement | null | undefined
}

interface Registration {
  current: () => InteractionLayer
}

const registries = new WeakMap<Document, InteractionLayerRegistry>()

function elementsFor(registration: Registration) {
  return registration.current().elements().filter((element): element is Element => (
    Boolean(element?.isConnected && !element.closest('[inert]') && element.getClientRects().length > 0)
  ))
}

function containsEvent(elements: readonly Element[], event: Event) {
  const path = event.composedPath()
  return elements.some(element => path.includes(element))
}

class InteractionLayerRegistry {
  private readonly layers: Registration[] = []
  private history: InteractionHistory | null = null
  private historySyncQueued = false

  constructor(private readonly owner: Document) {
    const view = owner.defaultView
    if (!view) return
    const touch = view.matchMedia(TOUCH_PRIMARY_INPUT_QUERY)
    this.history = new InteractionHistory({
      read: () => ({ state: view.history.state as unknown, url: view.location.href }),
      push: (state, url) => view.history.pushState(state, '', url),
      replace: (state, url) => view.history.replaceState(state, '', url),
      back: () => view.history.back(),
      defer: action => queueMicrotask(action),
      timeout: action => {
        const timer = view.setTimeout(action, 2000)
        return () => view.clearTimeout(timer)
      },
      report: error => console.warn('Farming interaction history:', error),
    }, Array.from(view.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'),
    () => touch.matches && Boolean(this.top()), () => {
      const top = this.top()
      if (top && top.layer.current().dismissOnEscape !== false) this.dismiss(top.layer.current(), 'browser-back')
    })
    // The bridge lives with the document so Forward/reload cannot revive a
    // dismissed layer. No global UI state or component references survive it.
    view.addEventListener('popstate', () => this.history?.pop())
    view.addEventListener('pageshow', () => this.refresh())
    touch.addEventListener('change', () => this.refresh())
  }

  refresh() {
    if (this.historySyncQueued) return
    this.historySyncQueued = true
    queueMicrotask(() => {
      this.historySyncQueued = false
      this.history?.sync()
    })
  }

  replaceState(state: unknown, url: string) {
    this.history?.replace(state, url)
  }

  top(modalOnly = false) {
    const candidates = this.layers.map(layer => ({ layer, elements: elementsFor(layer) }))
      .filter(candidate => candidate.elements.length > 0 && (!modalOnly || candidate.layer.current().modal))
    // A nested surface outranks its ancestor even when React mounts the child
    // first. Separate surfaces use activation order, never render order.
    const topLevel = candidates.filter(candidate => !candidates.some(other => (
      other !== candidate
      && candidate.elements.some(parent => other.elements.some(child => parent !== child && parent.contains(child)))
      && !other.elements.some(parent => candidate.elements.some(child => parent !== child && parent.contains(child)))
    )))
    return topLevel[topLevel.length - 1]
  }

  add(current: () => InteractionLayer) {
    if (this.layers.length === 0) {
      this.owner.defaultView?.addEventListener('pointerdown', this.onPointerDown, true)
      this.owner.defaultView?.addEventListener('keydown', this.onKeyDown, true)
    }
    const registration = { current }
    this.layers.push(registration)
    this.refresh()
    return () => {
      const index = this.layers.indexOf(registration)
      if (index >= 0) this.layers.splice(index, 1)
      this.refresh()
      if (this.layers.length === 0) {
        this.owner.defaultView?.removeEventListener('pointerdown', this.onPointerDown, true)
        this.owner.defaultView?.removeEventListener('keydown', this.onKeyDown, true)
      }
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    const top = this.top()
    if (!top || containsEvent(top.elements, event)) return
    const layer = top.layer.current()
    if (layer.dismissOnPointerOutside === false) return
    // Do not consume the pointer or restore focus: the destination still owns
    // its click, focus, scrollbar drag or resize gesture.
    layer.onDismiss('outside-pointer')
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    const top = this.top()
    if (!top) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const layer = top.layer.current()
    if (event.repeat || layer.dismissOnEscape === false) return
    this.dismiss(layer, 'escape')
  }

  private dismiss(layer: InteractionLayer, reason: 'escape' | 'browser-back') {
    layer.onDismiss(reason)
    const target = layer.returnFocus?.()
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true })
  }
}

export function refreshInteractionLayers(owner: Document) {
  registryFor(owner).refresh()
}

/** Workspace URL changes must survive any already-pending guard cleanup. */
export function replaceInteractionHistoryState(state: unknown, url: string | URL, owner: Document = document) {
  registryFor(owner).replaceState(state, String(url))
}

function registryFor(owner: Document) {
  let registry = registries.get(owner)
  if (!registry) {
    registry = new InteractionLayerRegistry(owner)
    registries.set(owner, registry)
  }
  return registry
}

export function registerInteractionLayer(owner: Document, current: () => InteractionLayer) {
  return registryFor(owner).add(current)
}

/** Legacy global shortcuts must yield before their capture listener runs. */
export function interactionLayerOwnsEscape(event: KeyboardEvent, owner: Document = document) {
  return event.key === 'Escape' && Boolean(registries.get(owner)?.top())
}

export function isTopModalInteractionLayer(element: Element | null) {
  return Boolean(element && registries.get(element.ownerDocument)?.top(true)?.elements.includes(element))
}
