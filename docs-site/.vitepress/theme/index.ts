import DefaultTheme from 'vitepress/theme-without-fonts'
import '@fontsource-variable/fraunces/soft.css'
import '@fontsource-variable/noto-serif-sc'
import { h } from 'vue'
import AppearanceControl from './AppearanceControl.vue'
import HomeHeroVisual from './HomeHeroVisual.vue'
import ImageViewer from './ImageViewer.vue'
import IntegrationIcons from './IntegrationIcons.vue'
import PageActions from './PageActions.vue'
import ProviderIcons from './ProviderIcons.vue'
import ThemeImage from './ThemeImage.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-image': () => h(HomeHeroVisual),
    'aside-outline-after': () => h(PageActions, { variant: 'aside' }),
    'doc-footer-before': () => h(PageActions, { variant: 'footer' }),
    'layout-bottom': () => h(ImageViewer),
    'nav-bar-content-after': () => h(AppearanceControl),
    'nav-screen-content-after': () => h(AppearanceControl),
  }),
  enhanceApp({ app, router }) {
    app.component('IntegrationIcons', IntegrationIcons)
    app.component('ProviderIcons', ProviderIcons)
    app.component('ThemeImage', ThemeImage)

    if (typeof window === 'undefined') return
    const supported = new Set(['light', 'dark', 'paper'])
    const initialTheme = new URLSearchParams(window.location.search).get('theme')
    let storedTheme: string | null = null
    try {
      storedTheme = window.localStorage.getItem('farming-docs-appearance')
    } catch {
      // Storage is optional; URL and system appearance remain authoritative.
    }
    const preference = supported.has(initialTheme || '')
      ? initialTheme!
      : supported.has(storedTheme || '')
        ? storedTheme!
        : 'system'
    const resolvedTheme = preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : preference
    const root = document.documentElement
    root.dataset.appearance = resolvedTheme
    root.dataset.appearancePreference = preference
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'
    if (supported.has(initialTheme || '')) {
      try {
        window.localStorage.setItem('farming-docs-appearance', resolvedTheme)
      } catch {
        // Keep the explicit URL appearance even when storage is unavailable.
      }
    }
    let keepThemeInUrl = supported.has(initialTheme || '')
    const updateThemeUrl = () => {
      if (!keepThemeInUrl) return
      const theme = document.documentElement.dataset.appearance || 'light'
      const url = new URL(window.location.href)
      url.searchParams.set('theme', theme)
      window.history.replaceState(window.history.state, '', url)
    }
    window.addEventListener('farming-docs-appearance-change', () => {
      keepThemeInUrl = true
      updateThemeUrl()
    })
    const previousAfterRouteChange = router.onAfterRouteChange
    router.onAfterRouteChange = async (to) => {
      await previousAfterRouteChange?.(to)
      updateThemeUrl()
    }
  },
}
