<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{
  defaultTheme?: 'paper' | 'dark' | 'light'
}>(), {
  defaultTheme: 'paper',
})

const { lang } = useData()
const sectionRef = ref<HTMLElement | null>(null)
const iframeRef = ref<HTMLIFrameElement | null>(null)
const currentTheme = ref<'paper' | 'dark' | 'light'>(props.defaultTheme)
const iframeLoaded = ref(false)
const hasBecomeVisible = ref(false)
let visibilityObserver: IntersectionObserver | undefined

const isZh = computed(() => !lang.value || lang.value.startsWith('zh') || lang.value.startsWith('cn'))

const demoSrc = computed(() => {
  const l = isZh.value ? 'zh' : 'en'
  return withBase(`/interactive-demo/index.html?lang=${l}&theme=${props.defaultTheme}&waitVisible=1&chrome=0`)
})

const fullscreenSrc = computed(() => {
  const l = isZh.value ? 'zh' : 'en'
  return withBase(`/interactive-demo/index.html?lang=${l}&theme=${currentTheme.value}`)
})

function sendDemoAction(action: 'replay' | 'steer' | 'reset') {
  iframeRef.value?.contentWindow?.postMessage({ type: 'farming-demo-action', action }, '*')
}

function syncAppearanceFromDoc() {
  if (typeof document === 'undefined') return
  const docTheme = document.documentElement.dataset.appearance
  if (docTheme === 'paper' || docTheme === 'dark' || docTheme === 'light') {
    currentTheme.value = docTheme
    iframeRef.value?.contentWindow?.postMessage({
      type: 'farming-theme',
      theme: docTheme,
    }, '*')
  }
}

function notifyDemoVisibleIfReady() {
  if (iframeLoaded.value && hasBecomeVisible.value) {
    iframeRef.value?.contentWindow?.postMessage({ type: 'farming-demo-visible' }, '*')
  }
}

function onIframeLoad() {
  iframeLoaded.value = true
  syncAppearanceFromDoc()
  notifyDemoVisibleIfReady()
}

function onWindowMessage(event: MessageEvent) {
  if (!event.data || event.data.type !== 'farming-demo-theme') return
  const theme = event.data.theme
  if (theme === 'paper' || theme === 'dark' || theme === 'light') {
    currentTheme.value = theme
  }
}

onMounted(() => {
  syncAppearanceFromDoc()
  window.addEventListener('farming-docs-appearance-change', syncAppearanceFromDoc)
  window.addEventListener('message', onWindowMessage)
  if (typeof IntersectionObserver !== 'undefined' && sectionRef.value) {
    visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        hasBecomeVisible.value = true
        notifyDemoVisibleIfReady()
        visibilityObserver?.disconnect()
        visibilityObserver = undefined
      }
    }, { threshold: 0.2 })
    visibilityObserver.observe(sectionRef.value)
  } else {
    hasBecomeVisible.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('farming-docs-appearance-change', syncAppearanceFromDoc)
  window.removeEventListener('message', onWindowMessage)
  visibilityObserver?.disconnect()
  visibilityObserver = undefined
})
</script>

<template>
  <section id="interactive-demo" ref="sectionRef" class="farming-interactive-showcase">
    <div class="farming-interactive-showcase-header">
      <div class="farming-interactive-showcase-copy">
        <h2>
          {{ isZh ? '交互演示：桌面与手机共享同一个 Agent' : 'Interactive demo: Desktop and phone on the same Agent' }}
        </h2>
        <p>
          {{
            isZh
              ? '前端交互示意（未连接真实后端）：可在任一端输入框发送消息或运行中 Steer，也可点击左侧文件与预览。'
              : 'Simulated frontend walkthrough (no live backend): send a prompt or mid-turn Steer from either composer, or switch files and preview.'
          }}
        </p>
      </div>
      <div class="farming-interactive-showcase-actions">
        <button
          type="button"
          class="farming-interactive-showcase-btn"
          data-demo-control="replay"
          @click="sendDemoAction('replay')"
        >
          {{ isZh ? '重播' : 'Replay' }}
        </button>
        <button
          type="button"
          class="farming-interactive-showcase-btn"
          data-demo-control="steer"
          @click="sendDemoAction('steer')"
        >
          Steer
        </button>
        <button
          type="button"
          class="farming-interactive-showcase-btn"
          data-demo-control="reset"
          @click="sendDemoAction('reset')"
        >
          {{ isZh ? '重置' : 'Reset' }}
        </button>
        <a
          class="farming-interactive-showcase-btn"
          :href="fullscreenSrc"
          target="_blank"
          rel="noopener"
        >
          {{ isZh ? '新窗口 ↗' : 'Open ↗' }}
        </a>
      </div>
    </div>

    <div class="farming-interactive-showcase-frame-wrap">
      <iframe
        ref="iframeRef"
        class="farming-interactive-showcase-iframe"
        :src="demoSrc"
        :title="isZh ? 'Farming 桌面端与手机端交互演示' : 'Farming Desktop & Mobile Interactive Demo'"
        loading="lazy"
        @load="onIframeLoad"
      />
    </div>
  </section>
</template>

<style scoped>
.farming-interactive-showcase {
  margin: 28px 0 36px;
  padding: 20px;
  border-radius: 20px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
}

.farming-interactive-showcase-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.farming-interactive-showcase-copy {
  max-width: 720px;
}

.farming-interactive-showcase-copy h2 {
  margin: 0 0 6px !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 20px !important;
  line-height: 1.35 !important;
  color: var(--vp-c-text-1);
}

.farming-interactive-showcase-copy p {
  margin: 0 !important;
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.farming-interactive-showcase-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.farming-interactive-showcase-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2) !important;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none !important;
  white-space: nowrap;
  transition: border-color 150ms ease, color 150ms ease;
}

.farming-interactive-showcase-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1) !important;
}

.farming-interactive-showcase-frame-wrap {
  width: 100%;
  aspect-ratio: 1840 / 896;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.farming-interactive-showcase-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
</style>
