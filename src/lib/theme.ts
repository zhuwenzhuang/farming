import { normalizeUiAppearance, resolveUiAppearance, type UiAppearance } from './ui-preferences'

export interface ThemeRuntimeSettings {
  crtEffects?: boolean
  appearance?: UiAppearance
}

export function applyThemeAppearance(
  themeId = 'terminal',
  settings: ThemeRuntimeSettings = {},
) {
  if (typeof document === 'undefined') return

  const body = document.body
  const crtEnabled = settings.crtEffects !== false
  const appearancePreference = normalizeUiAppearance(settings.appearance)
  const appearance = resolveUiAppearance(appearancePreference)

  body.dataset.theme = themeId
  body.dataset.crtEffects = crtEnabled ? 'on' : 'off'
  body.dataset.appearancePreference = appearancePreference
  body.dataset.appearance = appearance

  if (crtEnabled) {
    body.classList.remove('no-crt')
  } else {
    body.classList.add('no-crt')
  }
}
