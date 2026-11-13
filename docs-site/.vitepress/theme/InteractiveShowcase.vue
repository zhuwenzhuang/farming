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
  return withBase(`/interactive-demo/index.html?lang=${l}&theme=${props.defaultTheme}&waitVisible=1`)
})

const fullscreenSrc = computed(() => {
  const l = isZh.value ? 'zh' : 'en'
  return withBase(`/interactive-demo/index.html?lang=${l}&theme=${currentTheme.value}`)
})

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
        <span class="farming-interactive-showcase-badge">
          {{ isZh ? '交互式真机体验 · 免安装' : 'Interactive Live Sandbox · Zero Install' }}
        </span>
        <h2>
          {{ isZh ? '桌面端与手机端实时连接同一个 Agent 会话' : 'Desktop and Phone Connected to the Same Live Agent Session' }}
        </h2>
        <p>
          {{
            isZh
              ? '左侧可试玩实时渲染的 HTML 游戏与 Git Diff 视图，右侧为手机端。页面自动演示手机发指令、桌面实时同步、运行中 Steer 与代码热更新，也支持你随时在任意一端直接输入或手动操控。'
              : 'Left: Desktop with a playable live HTML game preview, Files, and Git Diff. Right: iPhone on the same Agent. Watch the live Phone ↔ Desktop sync, mid-turn Steer, and hot-reload in action, or play and type directly in either Composer.'
          }}
        </p>
      </div>
      <a
        class="farming-interactive-showcase-open"
        :href="fullscreenSrc"
        target="_blank"
        rel="noopener"
      >
        {{ isZh ? '↗ 全屏打开交互沙盒' : '↗ Open Fullscreen Sandbox' }}
      </a>
    </div>

    <div class="farming-interactive-showcase-frame-wrap">
      <iframe
        ref="iframeRef"
        class="farming-interactive-showcase-iframe"
        :src="demoSrc"
        :title="isZh ? 'Farming 桌面端与手机端交互式示例' : 'Farming Desktop & Mobile Interactive Demo'"
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
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.farming-interactive-showcase-copy {
  max-width: 760px;
}

.farming-interactive-showcase-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  margin-bottom: 6px;
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

.farming-interactive-showcase-open {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1) !important;
  font-size: 12.5px;
  font-weight: 600;
  text-decoration: none !important;
  white-space: nowrap;
}

.farming-interactive-showcase-open:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1) !important;
}

.farming-interactive-showcase-frame-wrap {
  width: 100%;
  aspect-ratio: 1840 / 960;
  min-height: 460px;
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
