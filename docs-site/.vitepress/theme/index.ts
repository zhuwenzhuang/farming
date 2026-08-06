import DefaultTheme from 'vitepress/theme-without-fonts'
import '@fontsource-variable/fraunces/soft.css'
import '@fontsource-variable/noto-serif-sc'
import { h } from 'vue'
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
  }),
  enhanceApp({ app, router }) {
    app.component('IntegrationIcons', IntegrationIcons)
    app.component('ProviderIcons', ProviderIcons)
    app.component('ThemeImage', ThemeImage)

    if (typeof window === 'undefined') return

    const initialTheme = new URLSearchParams(window.location.search).get('theme')
    let keepThemeInUrl = initialTheme === 'dark' || initialTheme === 'light'
    let isDark = document.documentElement.classList.contains('dark')

    const updateThemeUrl = () => {
      if (!keepThemeInUrl) return
      const url = new URL(window.location.href)
      url.searchParams.set('theme', isDark ? 'dark' : 'light')
      window.history.replaceState(window.history.state, '', url)
    }

    new MutationObserver(() => {
      const nextIsDark = document.documentElement.classList.contains('dark')
      if (nextIsDark === isDark) return
      isDark = nextIsDark
      keepThemeInUrl = true
      updateThemeUrl()
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    const previousAfterRouteChange = router.onAfterRouteChange
    router.onAfterRouteChange = async (to) => {
      await previousAfterRouteChange?.(to)
      updateThemeUrl()
    }
  },
}
