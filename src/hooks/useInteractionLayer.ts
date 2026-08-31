import { useLayoutEffect, useRef } from 'react'
import { registerInteractionLayer, type InteractionLayer } from '@/lib/interaction-layer'

export function useInteractionLayer({
  enabled,
  ...layer
}: InteractionLayer & { enabled: boolean }) {
  const current = useRef(layer)
  current.current = layer

  useLayoutEffect(() => {
    if (!enabled) return
    const owner = current.current.elements().find(element => element)?.ownerDocument ?? document
    return registerInteractionLayer(owner, () => current.current)
  }, [enabled])
}
