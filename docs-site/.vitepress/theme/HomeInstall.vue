<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useData } from 'vitepress'

const { lang } = useData()
const chinese = computed(() => lang.value.startsWith('zh'))
const method = ref<'npm' | 'local'>('npm')
const command = computed(() => method.value === 'npm'
  ? 'npm install --global farming-code@latest\nfarming daemon'
  : 'curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | FARMING_INSTALL_ROOT="$HOME/farming" bash\n"$HOME/farming/farming" daemon')
const copied = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
function selectMethod(value: 'npm' | 'local') {
  method.value = value
  copied.value = false
  failed.value = false
  clearTimeout(timer)
}
async function copy() {
  const requestedCommand = command.value
  try {
    await navigator.clipboard.writeText(requestedCommand)
    if (requestedCommand !== command.value) return
    copied.value = true
    failed.value = false
    clearTimeout(timer)
    timer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    if (requestedCommand === command.value) failed.value = true
  }
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="home-install">
    <div class="home-install-panel">
      <div class="home-install-header">
        <div class="home-install-methods" role="group" :aria-label="chinese ? '安装方式' : 'Installation method'">
          <button type="button" :aria-pressed="method === 'npm'" @click="selectMethod('npm')">
            {{ chinese ? 'npm 安装' : 'npm install' }}
          </button>
          <button type="button" :aria-pressed="method === 'local'" @click="selectMethod('local')">
            {{ chinese ? '指定目录安装' : 'Directory install' }}
          </button>
        </div>
        <button class="home-install-copy" type="button" @click="copy" :aria-label="chinese ? '复制安装和启动命令' : 'Copy installation and startup commands'">
          {{ copied ? (chinese ? '已复制' : 'Copied') : (chinese ? '复制' : 'Copy') }}
        </button>
      </div>
      <div class="home-install-command">
        <code>{{ command }}</code>
      </div>
    </div>
    <p aria-live="polite">{{ failed
      ? (chinese ? '请选中上方命令复制。' : 'Select the command above to copy it.')
      : method === 'npm'
        ? (chinese ? 'Node.js 22.13+（22.x）或 24+' : 'Node.js 22.13+ (22.x) or 24+')
        : (chinese ? '自带 Node.js · 支持旧版 glibc Linux x64' : 'Includes Node.js · Supports older glibc Linux x64') }}</p>
  </div>
</template>

<style scoped>
.home-install { margin-top: 24px; max-width: 620px; text-align: left; }
.home-install-panel { border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-elv); }
.home-install-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--vp-c-divider); }
.home-install-methods { display: flex; gap: 4px; }
.home-install-methods button { padding: 4px 10px; }
.home-install-methods button[aria-pressed="true"] { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.home-install-command { padding: 12px 16px 16px; }
code { display: block; padding: 0; font-family: var(--vp-font-family-mono); font-size: 14px; font-weight: 400; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vp-c-text-1); background: transparent; }
button { flex-shrink: 0; min-height: 32px; padding: 4px 8px; border-radius: 6px; font-family: var(--vp-font-family-base); font-size: 12px; font-weight: 500; line-height: 24px; color: var(--vp-c-text-2); }
button:hover { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
p { margin: 8px 0 0; font-size: 12px; color: var(--vp-c-text-2); }
@media (max-width: 959px) { .home-install { margin-left: auto; margin-right: auto; } }
@media (min-width: 960px) { code { font-size: 15px; line-height: 26px; } }
</style>
