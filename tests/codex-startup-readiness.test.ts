import assert from 'node:assert/strict'
import test from 'node:test'
import { freshCodexSessionConfigured } from './e2e/internal/codex-startup-readiness'

test('fresh Codex waits for SessionConfigured help after the early idle Composer', () => {
  const header = '>_ OpenAI Codex (v0.163.0)\n  /workspace'
  const footer = '› Ask Codex to do anything\n\nGPT 6.0 Astra default · /workspace'
  const placeholder = `${header}\n\n${footer}`
  const configured = `${header}\n\nTo get started, describe a task or try one of these commands:\n\n/status - show current session configuration\n\n${footer}`
  const snapshots = [
    { rendered: '>_ OpenAI Codex (v0.163.0)\n loading', activity: 'unknown', ready: false },
    { rendered: placeholder, activity: 'idle', ready: false },
    { rendered: `• Model selection is disabled until startup completes.\n${placeholder}`, activity: 'idle', ready: false },
    { rendered: configured, activity: 'working', ready: false },
    { rendered: configured, activity: 'idle', ready: true },
  ]
  for (const snapshot of snapshots) {
    assert.equal(freshCodexSessionConfigured(snapshot.rendered, snapshot.activity), snapshot.ready)
  }
  // Fresh Terminal identity remains temporary until a user turn completes;
  // this prerequisite intentionally needs no /status probe or provider ID.
  assert.equal(freshCodexSessionConfigured(configured.replace(/\n/g, '\r\n'), 'idle'), true)
})
