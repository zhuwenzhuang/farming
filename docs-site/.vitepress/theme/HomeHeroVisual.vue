<script setup lang="ts">
import { withBase } from 'vitepress'
import { ref } from 'vue'

// Re-keying the CRT panel restarts every CSS ident animation.
const replayKey = ref(0)
</script>

<template>
  <div class="farming-home-visual">
    <img
      class="farming-home-illustration"
      :src="withBase('/farming-hero.png')"
      alt="Farming Code"
    >

    <div class="farming-home-crt-streams" aria-hidden="true">
      <span>AGENT 03
RUNNING
12:48:07
TOKENS 486K
FILES READY
PROMPT &gt;</span>
      <span>PROJECT
NORTHSTAR
CHAT LIVE
REV 184
STATUS OK
_</span>
      <span>CODEX
CLAUDE
OPENCODE
QODER
QWEN
CONNECTED</span>
      <span>TERMINAL
PTY 04
INPUT READY
EXIT 0
CHECKPOINT
SYNC</span>
      <span>HISTORY
SESSION 17
RESTORED
FILES 42
DIFF +18
_</span>
      <span>USAGE
1D 1.3M
7D 1.8M
CACHE 50%
LIVE
_</span>
    </div>

    <div
      :key="replayKey"
      class="farming-home-crt"
      role="img"
      aria-label="Farming CRT，使用方向键移动、Enter 选择、Escape 返回"
      @click="replayKey++"
    >
      <span class="farming-home-crt-bootline" aria-hidden="true" />
      <div class="farming-home-crt-lockup">
        <div class="farming-home-crt-mark" aria-hidden="true">
          <svg viewBox="0 0 64 52" focusable="false">
            <rect class="farming-home-crt-case" x="2" y="2" width="60" height="43" rx="8" />
            <rect class="farming-home-crt-pane farming-home-crt-pane-main" x="9" y="9" width="19" height="29" rx="3" />
            <rect class="farming-home-crt-pane farming-home-crt-pane-worker-a" x="33" y="9" width="22" height="12" rx="3" />
            <rect class="farming-home-crt-pane farming-home-crt-pane-worker-b" x="33" y="26" width="22" height="12" rx="3" />
            <path class="farming-home-crt-prompt farming-home-crt-prompt-main" d="M13 17l4 3-4 3m6 0h4" />
            <path class="farming-home-crt-prompt farming-home-crt-prompt-worker-a" d="M37 13l3 2-3 2m5 0h4" />
            <path class="farming-home-crt-prompt farming-home-crt-prompt-worker-b" d="M37 30l3 2-3 2m5 0h4" />
            <path class="farming-home-crt-stand" d="M11 50h38m5 0h2" />
          </svg>
        </div>

        <div class="farming-home-crt-wordmark" aria-hidden="true">
          <span class="farming-home-crt-name"><span>F</span><span>A</span><span>R</span><span>M</span><span>I</span><span>N</span><span>G</span></span>
          <span class="farming-home-crt-model">CRT</span>
        </div>
      </div>

      <div class="farming-home-crt-keyboard" aria-hidden="true">
        <svg viewBox="0 0 172 38" focusable="false">
          <defs>
            <filter id="farming-home-keyboard-soft-phosphor" x="-20%" y="-20%" width="140%" height="150%">
              <feGaussianBlur stdDeviation="0.45" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#farming-home-keyboard-soft-phosphor)">
            <text class="farming-home-keyboard-hint" x="2" y="9">USE</text>
            <text class="farming-home-keyboard-hint" x="2" y="27">KEYBOARD</text>
            <g transform="translate(92 2)">
              <rect class="farming-home-keycap-side" x="0.5" y="2.5" width="18" height="14" rx="1.5" />
              <rect class="farming-home-keycap-top" x="0.5" y="0.5" width="18" height="14" rx="1.5" />
              <text class="farming-home-keycap-label" x="9.5" y="7.5">↑</text>
            </g>
            <g transform="translate(73 20)">
              <rect class="farming-home-keycap-side" x="0.5" y="2.5" width="18" height="14" rx="1.5" />
              <rect class="farming-home-keycap-top" x="0.5" y="0.5" width="18" height="14" rx="1.5" />
              <text class="farming-home-keycap-label" x="9.5" y="7.5">←</text>
            </g>
            <g transform="translate(92 20)">
              <rect class="farming-home-keycap-side" x="0.5" y="2.5" width="18" height="14" rx="1.5" />
              <rect class="farming-home-keycap-top" x="0.5" y="0.5" width="18" height="14" rx="1.5" />
              <text class="farming-home-keycap-label" x="9.5" y="7.5">↓</text>
            </g>
            <g transform="translate(111 20)">
              <rect class="farming-home-keycap-side" x="0.5" y="2.5" width="18" height="14" rx="1.5" />
              <rect class="farming-home-keycap-top" x="0.5" y="0.5" width="18" height="14" rx="1.5" />
              <text class="farming-home-keycap-label" x="9.5" y="7.5">→</text>
            </g>
            <g transform="translate(62 2)">
              <rect class="farming-home-keycap-side" x="0.5" y="2.5" width="28" height="14" rx="1.5" />
              <rect class="farming-home-keycap-top" x="0.5" y="0.5" width="28" height="14" rx="1.5" />
              <text class="farming-home-keycap-label farming-home-keycap-label-small" x="14.5" y="7.5">ESC</text>
            </g>
            <g transform="translate(113 2)">
              <path class="farming-home-keycap-side" d="M.5 2.5h56v32h-18v-18h-38z" />
              <path class="farming-home-keycap-top" d="M.5.5h56v32h-18v-18h-38z" />
              <text class="farming-home-keycap-label farming-home-keycap-label-small" x="25" y="7.5">ENTER</text>
              <text class="farming-home-keycap-label farming-home-keycap-return" x="47.5" y="24">↵</text>
            </g>
          </g>
        </svg>
      </div>
    </div>
  </div>
</template>
