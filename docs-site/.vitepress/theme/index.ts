import DefaultTheme from 'vitepress/theme-without-fonts'
import '@fontsource-variable/fraunces/soft.css'
import '@fontsource-variable/noto-serif-sc'
import { h } from 'vue'
import HomeHeroVisual from './HomeHeroVisual.vue'
import IntegrationIcons from './IntegrationIcons.vue'
import ProviderIcons from './ProviderIcons.vue'
import ThemeImage from './ThemeImage.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-image': () => h(HomeHeroVisual),
  }),
  enhanceApp({ app }) {
    app.component('IntegrationIcons', IntegrationIcons)
    app.component('ProviderIcons', ProviderIcons)
    app.component('ThemeImage', ThemeImage)
  },
}
