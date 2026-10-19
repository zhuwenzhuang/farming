<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useData } from 'vitepress'

const { lang } = useData()
const chinese = computed(() => lang.value.startsWith('zh'))
const command = 'npm install --global farming-code@latest --registry=https://registry.npmjs.org\nfarming daemon'
const copied = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
async function copy() {
  try {
    await navigator.clipboard.writeText(command)
    copied.value = true
    failed.value = false
    clearTimeout(timer)
    timer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    failed.value = true
  }
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="home-install">
    <div class="home-install-panel">
      <div class="home-install-header">
        <span class="home-install-label">{{ chinese ? '安装并启动' : 'Install and start' }}</span>
        <div class="home-install-copy-area">
          <button class="home-install-copy" type="button" @click="copy" :aria-label="chinese ? '复制安装和启动命令' : 'Copy installation and startup commands'">
            {{ copied ? (chinese ? '已复制' : 'Copied') : (chinese ? '复制' : 'Copy') }}
          </button>
        </div>
      </div>
      <div class="home-install-command">
        <code>{{ command }}</code>
        <p v-if="failed" class="home-install-feedback" role="status">{{ chinese ? '请选中上方命令复制。' : 'Select the command above to copy it.' }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-install { margin-top: 24px; max-width: 620px; text-align: left; }
.home-install-panel { border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-elv); }
.home-install-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 48px; padding: 8px 10px; border-bottom: 1px solid var(--vp-c-divider); }
.home-install-label { padding-left: 6px; font-size: 13px; color: var(--vp-c-text-2); }
.home-install-copy-area { border-left: 1px solid var(--vp-c-divider); padding-left: 8px; }
.home-install-copy { width: 56px; }
.home-install-command { padding: 12px 16px 16px; }
code { display: block; padding: 0; font-family: var(--vp-font-family-mono); font-size: 14px; font-weight: 400; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vp-c-text-1); background: transparent; }
button { flex-shrink: 0; min-height: 32px; padding: 4px 8px; border-radius: 6px; font-family: var(--vp-font-family-base); font-size: 12px; font-weight: 500; line-height: 24px; color: var(--vp-c-text-2); }
button:hover { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.home-install-feedback { margin: 8px 0 0; font-size: 12px; color: var(--vp-c-text-2); }
@media (max-width: 959px) { .home-install { margin-left: auto; margin-right: auto; } }
@media (min-width: 960px) { code { font-size: 15px; line-height: 26px; } }
</style>
