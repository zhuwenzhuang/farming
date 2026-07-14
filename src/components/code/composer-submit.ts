import type { TerminalInputPart } from '@/types/messages'

const TERMINAL_SUBMIT_SEQUENCE = '\r'

export const CODEX_TERMINAL_PROFILE_STEP_DELAY_MS = 220
export const CODEX_TERMINAL_PROFILE_PROMPT_DELAY_MS = 420

export interface PendingCodexTerminalProfile {
  model: string
  effort: string
  modelIndex: number
  reasoningIndex: number
  reasoningCount: number
  fast: boolean
  fastAvailable: boolean
  applyModel: boolean
  applyFast: boolean
}

export interface CodexTerminalProfileInputStep {
  delayMs: number
  input: string | TerminalInputPart[]
  kind: 'command' | 'selection' | 'message'
}

export function terminalInputPartsForComposerMessage(message: string): TerminalInputPart[] {
  return [{ type: 'paste', text: message }, TERMINAL_SUBMIT_SEQUENCE]
}

function pickerSelectionInput(index: number) {
  const oneBasedIndex = index + 1
  if (oneBasedIndex >= 1 && oneBasedIndex <= 9) return String(oneBasedIndex)
  return `\x1b[H${'\x1b[B'.repeat(Math.max(0, index))}\r`
}

export function codexTerminalProfileInputSteps(
  profile: PendingCodexTerminalProfile,
  message: string,
): CodexTerminalProfileInputStep[] {
  const steps: CodexTerminalProfileInputStep[] = []
  let delayMs = 0

  if (profile.applyModel && profile.modelIndex >= 0 && profile.reasoningIndex >= 0) {
    steps.push({
      delayMs,
      input: terminalInputPartsForComposerMessage('/model'),
      kind: 'command',
    })
    delayMs += CODEX_TERMINAL_PROFILE_STEP_DELAY_MS
    steps.push({
      delayMs,
      input: pickerSelectionInput(profile.modelIndex),
      kind: 'selection',
    })
    if (profile.reasoningCount > 1) {
      delayMs += CODEX_TERMINAL_PROFILE_STEP_DELAY_MS
      steps.push({
        delayMs,
        input: pickerSelectionInput(profile.reasoningIndex),
        kind: 'selection',
      })
    }
  }

  if (profile.applyFast && profile.fastAvailable) {
    delayMs += steps.length > 0 ? CODEX_TERMINAL_PROFILE_STEP_DELAY_MS : 0
    steps.push({
      delayMs,
      input: terminalInputPartsForComposerMessage('/fast'),
      kind: 'command',
    })
  }

  delayMs += steps.length > 0 ? CODEX_TERMINAL_PROFILE_PROMPT_DELAY_MS : 0
  steps.push({
    delayMs,
    input: terminalInputPartsForComposerMessage(message),
    kind: 'message',
  })
  return steps
}
