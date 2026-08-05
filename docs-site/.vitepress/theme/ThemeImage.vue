<script setup lang="ts">
defineProps<{
  light: string
  dark: string
  alt: string
}>()
</script>

<template>
  <span class="theme-image">
    <img class="theme-image-light" :src="light" :alt="alt">
    <img class="theme-image-dark" :src="dark" :alt="alt">
  </span>
</template>
