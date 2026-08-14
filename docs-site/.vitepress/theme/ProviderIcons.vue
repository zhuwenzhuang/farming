<script setup lang="ts">
import { withBase } from 'vitepress'
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
  { name: 'Bash', icon: 'bash', warm: bashIcon, dark: bashIcon },
  { name: 'Zsh', icon: 'zsh', warm: zshIcon, dark: zshDarkIcon },
]
</script>

<template>
  <span class="docs-card-provider-icons" aria-label="支持 Codex、Claude Code、Pi、OpenCode、Qoder、Qwen Code、Bash 和 Zsh">
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
