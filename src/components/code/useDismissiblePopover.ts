import type { RefObject } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'

export function useDismissiblePopover(
  open: boolean,
  popoverRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  dismissEnabled = true,
) {
  useInteractionLayer({
    enabled: open,
    elements: () => [popoverRef.current, anchorRef.current],
    onDismiss,
    dismissOnPointerOutside: dismissEnabled,
    dismissOnEscape: dismissEnabled,
    returnFocus: () => anchorRef.current,
  })
}
