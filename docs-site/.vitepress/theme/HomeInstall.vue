<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const chinese = computed(() => lang.value.startsWith('zh'))
const method = ref<'npm' | 'local'>('npm')
const command = computed(() => method.value === 'npm'
  ? 'npm install --global farming-code@latest\nfarming daemon'
  : [
      'curl -fLO https://zhuwenzhuang.github.io/farming/farming_install.sh',
      'bash farming_install.sh --dir ~/farming',
      'cd ~/farming',
      './farming daemon',
    ].join('\n'))
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
        <div class="home-install-tools" tabindex="0" :aria-label="chinese ? '安装选项和环境要求' : 'Installation options and requirements'">
          <div class="home-install-methods" role="group" :aria-label="chinese ? '安装方式' : 'Installation method'">
            <button type="button" :aria-pressed="method === 'npm'" @click="selectMethod('npm')">
              {{ chinese ? 'npm 安装' : 'npm install' }}
            </button>
            <button type="button" :aria-pressed="method === 'local'" @click="selectMethod('local')">
              {{ chinese ? '指定目录安装' : 'Directory install' }}
            </button>
          </div>
          <div class="home-install-context">
            <span class="home-install-requirement">{{ method === 'npm'
              ? (chinese ? 'Node.js 22.13+（22.x）或 24+' : 'Node.js 22.13+ (22.x) or 24+')
              : (chinese ? '支持旧版 glibc Linux x64' : 'Supports older glibc Linux x64') }}</span>
            <div v-if="method === 'local'" class="home-install-links">
              <a :href="withBase('/farming_install.sh')" download="farming_install.sh">{{ chinese ? '下载脚本' : 'Download script' }}</a>
            </div>
          </div>
        </div>
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
.home-install-tools { display: flex; align-items: center; gap: 16px; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.home-install-methods { display: flex; flex-shrink: 0; gap: 4px; }
.home-install-methods button { padding: 4px 10px; }
.home-install-methods button[aria-pressed="true"] { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.home-install-context { display: flex; align-items: center; flex-shrink: 0; gap: 12px; margin-left: auto; white-space: nowrap; }
.home-install-requirement { display: block; font-size: 11px; line-height: 18px; color: var(--vp-c-text-2); }
.home-install-links { display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
.home-install-links a { font-size: 12px; line-height: 24px; white-space: nowrap; }
.home-install-copy-area { border-left: 1px solid var(--vp-c-divider); padding-left: 8px; }
.home-install-copy { width: 56px; }
.home-install-command { padding: 12px 16px 16px; }
code { display: block; padding: 0; font-family: var(--vp-font-family-mono); font-size: 14px; font-weight: 400; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vp-c-text-1); background: transparent; }
button { flex-shrink: 0; min-height: 32px; padding: 4px 8px; border-radius: 6px; font-family: var(--vp-font-family-base); font-size: 12px; font-weight: 500; line-height: 24px; color: var(--vp-c-text-2); }
button:hover { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.home-install-tools:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; border-radius: 6px; }
button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
a { color: var(--vp-c-brand-1); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.home-install-feedback { margin: 8px 0 0; font-size: 12px; color: var(--vp-c-text-2); }
@media (max-width: 959px) { .home-install { margin-left: auto; margin-right: auto; } }
@media (min-width: 960px) { code { font-size: 15px; line-height: 26px; } }
</style>
