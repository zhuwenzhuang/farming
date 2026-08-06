<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'

const imageSelector = '.VPDoc .vp-doc img'
const route = useRoute()
const isOpen = ref(false)
const imageSource = ref('')
const imageAlt = ref('')
const closeButton = ref<HTMLButtonElement | null>(null)
let trigger: HTMLImageElement | null = null
let previousOverflow = ''

const isEligibleImage = (target: EventTarget | null): target is HTMLImageElement => {
  return target instanceof HTMLImageElement
    && target.matches(imageSelector)
    && !target.closest('a')
}

const viewerLabel = () => route.path.startsWith('/cn/') ? '图片预览' : 'Image preview'
const openLabel = () => route.path.startsWith('/cn/') ? '点击放大图片' : 'Open enlarged image'
const closeLabel = () => route.path.startsWith('/cn/') ? '关闭图片预览' : 'Close image preview'

const prepareImages = () => {
  document.querySelectorAll<HTMLImageElement>(imageSelector).forEach((image) => {
    if (image.closest('a')) return
    image.dataset.imageViewer = ''
    image.tabIndex = 0
    image.setAttribute('role', 'button')
    image.setAttribute('aria-label', image.alt ? `${openLabel()}：${image.alt}` : openLabel())
    image.setAttribute('aria-haspopup', 'dialog')
  })
}

const open = async (image: HTMLImageElement) => {
  trigger = image
  imageSource.value = image.currentSrc || image.src
  imageAlt.value = image.alt
  previousOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  isOpen.value = true
  await nextTick()
  closeButton.value?.focus()
}

const close = () => {
  if (!isOpen.value) return
  isOpen.value = false
  document.documentElement.style.overflow = previousOverflow
  trigger?.focus()
  trigger = null
}

const onClick = (event: MouseEvent) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (isEligibleImage(event.target)) open(event.target)
}

const onKeydown = (event: KeyboardEvent) => {
  if (isOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      closeButton.value?.focus()
    }
    return
  }

  if ((event.key === 'Enter' || event.key === ' ') && isEligibleImage(event.target)) {
    event.preventDefault()
    open(event.target)
  }
}

watch(() => route.path, async () => {
  close()
  await nextTick()
  prepareImages()
}, { flush: 'post' })

onMounted(async () => {
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  prepareImages()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClick)
  document.removeEventListener('keydown', onKeydown)
  document.documentElement.style.overflow = previousOverflow
})
</script>

<template>
  <Teleport to="body">
    <Transition name="image-viewer">
      <div
        v-if="isOpen"
        class="image-viewer-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="viewerLabel()"
        @click.self="close"
      >
        <button
          ref="closeButton"
          class="image-viewer-close"
          type="button"
          :aria-label="closeLabel()"
          :title="closeLabel()"
          @click="close"
        >
          <span aria-hidden="true">&times;</span>
        </button>
        <figure class="image-viewer-figure">
          <img :src="imageSource" :alt="imageAlt">
          <figcaption v-if="imageAlt">{{ imageAlt }}</figcaption>
        </figure>
      </div>
    </Transition>
  </Teleport>
</template>
