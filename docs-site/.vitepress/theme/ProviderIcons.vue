<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
import agyIcon from '../../../src/assets/agent-icons/color/agy.svg'
import bashIcon from '../../../src/assets/agent-icons/color/bash.svg'
import zshDarkIcon from '../../../src/assets/agent-icons/dark/zsh.svg'
import zshIcon from '../../../src/assets/agent-icons/color/zsh.svg'

const providers = [
  { name: 'Codex', icon: 'codex' },
  { name: 'Claude Code', icon: 'claude-code' },
  { name: 'Pi', icon: 'pi' },
  { name: 'OpenCode', icon: 'opencode' },
  { name: 'Qoder', icon: 'qoder' },
  { name: 'Qwen Code', icon: 'qwen' },
  { name: 'Antigravity', icon: 'agy', warm: agyIcon, dark: agyIcon },
  { name: 'Bash', icon: 'bash', warm: bashIcon, dark: bashIcon },
  { name: 'Zsh', icon: 'zsh', warm: zshIcon, dark: zshDarkIcon },
]
const { lang } = useData()
const label = computed(() => `${lang.value.startsWith('zh') ? '支持' : 'Supported:'} ${providers.map(provider => provider.name).join(', ')}`)
</script>

<template>
  <span class="docs-card-provider-icons" :aria-label="label">
    <template v-for="provider in providers" :key="provider.icon">
      <img
        :class="`provider-icon provider-icon-${provider.icon} provider-icon-warm`"
        :src="provider.warm || withBase(`/agent-icons/warm/${provider.icon}.svg`)"
        :alt="provider.name"
      >
      <img
        :class="`provider-icon provider-icon-${provider.icon} provider-icon-dark`"
        :src="provider.dark || withBase(`/agent-icons/dark/${provider.icon}.svg`)"
        :alt="provider.name"
      >
    </template>
  </span>
</template>
