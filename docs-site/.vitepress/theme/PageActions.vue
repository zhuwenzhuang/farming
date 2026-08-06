<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useData } from 'vitepress'

defineProps<{
  variant: 'aside' | 'footer'
}>()

const markdownFiles = import.meta.glob('../../{cn,en}/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

const { page } = useData()
const copyStatus = ref<'idle' | 'copied' | 'failed'>('idle')
let resetTimer: ReturnType<typeof setTimeout> | undefined

const isUserDoc = computed(() => /^(cn|en)\//.test(page.value.relativePath))
const isChinese = computed(() => page.value.relativePath.startsWith('cn/'))
const copyLabel = computed(() => {
  if (copyStatus.value === 'copied') return isChinese.value ? '已复制 Markdown' : 'Markdown copied'
  if (copyStatus.value === 'failed') return isChinese.value ? '复制失败' : 'Copy failed'
  return isChinese.value ? '复制 Markdown' : 'Copy Markdown'
})
const feedbackLabel = computed(() => isChinese.value ? '反馈文档问题' : 'Report a docs issue')

const canonicalPageUrl = computed(() => {
  if (typeof document !== 'undefined') {
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href
    if (canonical) return canonical
  }

  const path = page.value.relativePath
    .replace(/index\.md$/, '')
    .replace(/\.md$/, '')
  return `https://zhuwenzhuang.github.io/farming/${path}`
})

const feedbackUrl = computed(() => {
  const sourceUrl = `https://github.com/zhuwenzhuang/farming/blob/main/docs-site/${page.value.relativePath}`
  const body = [
    '## Page',
    '',
    canonicalPageUrl.value,
    '',
    `Source: ${sourceUrl}`,
    '',
    '## Problem',
    '',
    '',
    '## Suggested change',
    '',
  ].join('\n')
  const params = new URLSearchParams({
    title: `[Docs] ${page.value.title}`,
    body,
  })
  return `https://github.com/zhuwenzhuang/farming/issues/new?${params}`
})

const resetCopyStatus = () => {
  if (resetTimer) clearTimeout(resetTimer)
  resetTimer = setTimeout(() => {
    copyStatus.value = 'idle'
  }, 2200)
}

const copyMarkdown = async () => {
  try {
    const loadMarkdown = markdownFiles[`../../${page.value.relativePath}`]
    if (!loadMarkdown || !navigator.clipboard) throw new Error('Markdown source is unavailable')
    await navigator.clipboard.writeText(await loadMarkdown())
    copyStatus.value = 'copied'
  } catch {
    copyStatus.value = 'failed'
  }
  resetCopyStatus()
}

watch(() => page.value.relativePath, () => {
  copyStatus.value = 'idle'
})

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
})
</script>

<template>
  <div v-if="isUserDoc" :class="['docs-page-actions', `docs-page-actions--${variant}`]">
    <button type="button" @click="copyMarkdown">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 7.5V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2.5M6 7h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      </svg>
      <span aria-live="polite">{{ copyLabel }}</span>
    </button>
    <a :href="feedbackUrl" target="_blank" rel="noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 15a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9Z" />
      </svg>
      <span>{{ feedbackLabel }}</span>
    </a>
  </div>
</template>
