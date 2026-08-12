<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'

const props = defineProps<{
  light: string
  dark: string
  paper: string
  alt: string
}>()

const lightSource = computed(() => withBase(props.light))
const darkSource = computed(() => withBase(props.dark))
const paperSource = computed(() => withBase(props.paper))
</script>

<template>
  <span class="theme-image">
    <img class="theme-image-light" :src="lightSource" :alt="alt">
    <img class="theme-image-dark" :src="darkSource" :alt="alt">
    <img class="theme-image-paper" :src="paperSource" :alt="alt">
  </span>
</template>
