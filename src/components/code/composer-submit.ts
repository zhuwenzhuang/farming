import type { TerminalInputPart } from '@/types/messages'

const TERMINAL_SUBMIT_SEQUENCE = '\r'

export function terminalInputPartsForComposerMessage(message: string): TerminalInputPart[] {
  return [{ type: 'paste', text: message }, TERMINAL_SUBMIT_SEQUENCE]
}
