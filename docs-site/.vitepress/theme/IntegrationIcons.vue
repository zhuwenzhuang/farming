<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <span class="docs-card-integration-icons" aria-label="集成 Agent Browser 与 CUA Driver">
    <img
      class="integration-icon integration-icon-agent-browser"
      :src="withBase('/integration-icons/agent-browser.svg')"
      alt="Agent Browser"
    >
    <img
      class="integration-icon integration-icon-cua-driver"
      :src="withBase('/integration-icons/cua-driver.svg')"
      alt="CUA Driver"
    >
  </span>
</template>
