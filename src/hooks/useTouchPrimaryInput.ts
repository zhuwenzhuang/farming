import { useEffect, useState } from 'react'
import { isTouchPrimaryInput, TOUCH_PRIMARY_INPUT_QUERY } from '@/lib/responsive-mode'

// Input semantics follow device capabilities independently of layout width.
export function useTouchPrimaryInput() {
  const [touchInput, setTouchInput] = useState(isTouchPrimaryInput)
  useEffect(() => {
    const query = window.matchMedia(TOUCH_PRIMARY_INPUT_QUERY)
    const update = () => setTouchInput(isTouchPrimaryInput())
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return touchInput
}
