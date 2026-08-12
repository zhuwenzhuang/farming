<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

type Appearance = 'light' | 'dark' | 'paper'
const STORAGE_KEY = 'farming-docs-appearance'
const options: Array<{ value: Appearance; en: string; zh: string }> = [
  { value: 'light', en: 'Light', zh: '浅色' },
  { value: 'dark', en: 'Dark', zh: '深色' },
  { value: 'paper', en: 'Paper', zh: '纸张' },
]
const appearance = ref<Appearance>('light')
const chinese = ref(false)
let media: MediaQueryList | undefined

const read = (): Appearance => {
  const value = document.documentElement.dataset.appearance
  return value === 'dark' || value === 'paper' ? value : 'light'
}
const apply = (value: Appearance) => {
  const root = document.documentElement
  appearance.value = value
  root.dataset.appearance = value
  root.dataset.appearancePreference = value
  root.classList.toggle('dark', value === 'dark')
  root.style.colorScheme = value === 'dark' ? 'dark' : 'light'
  localStorage.setItem(STORAGE_KEY, value)
  const url = new URL(window.location.href)
  url.searchParams.set('theme', value)
  window.history.replaceState(window.history.state, '', url)
  window.dispatchEvent(new CustomEvent('farming-docs-appearance-change', { detail: value }))
}
const sync = (event: Event) => {
  const value = (event as CustomEvent<Appearance>).detail
  if (value) appearance.value = value
}
const followSystem = (event: MediaQueryListEvent) => {
  if (document.documentElement.dataset.appearancePreference !== 'system') return
  const value: Appearance = event.matches ? 'dark' : 'light'
  const root = document.documentElement
  appearance.value = value
  root.dataset.appearance = value
  root.classList.toggle('dark', value === 'dark')
  root.style.colorScheme = value === 'dark' ? 'dark' : 'light'
}
onMounted(() => {
  chinese.value = document.documentElement.lang.toLowerCase().startsWith('zh')
    || window.location.pathname.includes('/cn/')
  appearance.value = read()
  media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', followSystem)
  window.addEventListener('farming-docs-appearance-change', sync)
})
onBeforeUnmount(() => {
  media?.removeEventListener('change', followSystem)
  window.removeEventListener('farming-docs-appearance-change', sync)
})
</script>

<template>
  <div class="docs-appearance" role="group" :aria-label="chinese ? '外观' : 'Appearance'">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-label="chinese ? `使用${option.zh}外观` : `Use ${option.en} appearance`"
      :aria-pressed="appearance === option.value"
      :title="chinese ? option.zh : option.en"
      @click="apply(option.value)"
    >
      <span :class="`docs-appearance-swatch docs-appearance-swatch--${option.value}`" aria-hidden="true" />
    </button>
  </div>
</template>
