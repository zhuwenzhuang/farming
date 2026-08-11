import { normalizeUiAppearance, resolveUiAppearance, type UiAppearance } from './ui-preferences'
import { appearanceTheme } from '../../shared/appearance-themes'

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
  const root = document.documentElement
  const crtEnabled = settings.crtEffects !== false
  const appearancePreference = normalizeUiAppearance(settings.appearance)
  const appearance = resolveUiAppearance(appearancePreference)
  const { metadata } = appearanceTheme(appearance)

  root.dataset.appearancePreference = appearancePreference
  root.dataset.appearance = appearance
  body.dataset.theme = themeId
  body.dataset.crtEffects = crtEnabled ? 'on' : 'off'
  body.dataset.appearancePreference = appearancePreference
  body.dataset.appearance = appearance
  document.querySelector('meta[name="color-scheme"]')?.setAttribute(
    'content',
    metadata.colorScheme,
  )
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    metadata.themeColor,
  )

  if (crtEnabled) {
    body.classList.remove('no-crt')
  } else {
    body.classList.add('no-crt')
  }
}
