import { useEffect, useState } from 'react'
import {
  resolveUiAppearance,
  type UiAppearance,
} from '@/lib/ui-preferences'
import type { PetAppearance } from '@/lib/pet/rest-reminder'

function petAppearanceForUi(preference: UiAppearance): PetAppearance {
  return resolveUiAppearance(preference) === 'dark' ? 'black-hole' : 'glass'
}

export function usePetDefaultAppearance(preference: UiAppearance) {
  const [appearance, setAppearance] = useState<PetAppearance>(() => (
    petAppearanceForUi(preference)
  ))

  useEffect(() => {
    const updateAppearance = () => setAppearance(petAppearanceForUi(preference))
    updateAppearance()
    if (preference !== 'system') return undefined

    const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)')
    systemAppearance.addEventListener('change', updateAppearance)
    return () => systemAppearance.removeEventListener('change', updateAppearance)
  }, [preference])

  return appearance
}
