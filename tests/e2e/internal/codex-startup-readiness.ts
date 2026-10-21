// Only for a freshly launched Codex fixture, before any user turn or /clear.
// Codex 0.163 renders its Composer before SessionConfigured. Its completed
// new-session help is published after that event assigns the TUI thread ID.
export function freshCodexSessionConfigured(rendered: string, activity: string | undefined): boolean {
  return activity === 'idle'
    && /^\s*>_ OpenAI Codex \(v[^\n]+\)/m.test(rendered)
    && rendered.includes('To get started, describe a task or try one of these commands:')
    && /^\s*\/status - show current session configuration\s*$/m.test(rendered)
}
