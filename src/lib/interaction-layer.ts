export type InteractionDismissReason = 'outside-pointer' | 'escape'

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

  constructor(private readonly owner: Document) {
    owner.defaultView?.addEventListener('pointerdown', this.onPointerDown, true)
    owner.defaultView?.addEventListener('keydown', this.onKeyDown, true)
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
    const registration = { current }
    this.layers.push(registration)
    return () => {
      const index = this.layers.indexOf(registration)
      if (index >= 0) this.layers.splice(index, 1)
      if (this.layers.length > 0) return
      this.owner.defaultView?.removeEventListener('pointerdown', this.onPointerDown, true)
      this.owner.defaultView?.removeEventListener('keydown', this.onKeyDown, true)
      registries.delete(this.owner)
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
    layer.onDismiss('escape')
    const target = layer.returnFocus?.()
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true })
  }
}

export function registerInteractionLayer(owner: Document, current: () => InteractionLayer) {
  let registry = registries.get(owner)
  if (!registry) {
    registry = new InteractionLayerRegistry(owner)
    registries.set(owner, registry)
  }
  return registry.add(current)
}

/** Legacy global shortcuts must yield before their capture listener runs. */
export function interactionLayerOwnsEscape(event: KeyboardEvent, owner: Document = document) {
  return event.key === 'Escape' && Boolean(registries.get(owner)?.top())
}

export function isTopModalInteractionLayer(element: Element | null) {
  return Boolean(element && registries.get(element.ownerDocument)?.top(true)?.elements.includes(element))
}
