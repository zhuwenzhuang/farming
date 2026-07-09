export const TERMINAL_INPUT_FALLBACK_DELAY_MS = 80
export const TERMINAL_INPUT_FALLBACK_SUPPRESSION_MS = 120

export interface TerminalTextInputTarget {
  paste?: (text: string) => void
  input?: (text: string, fromPaste?: boolean) => void
}

export interface TerminalPasteDestination {
  terminal: TerminalTextInputTarget
  inputHandler: (text: string) => void
}

export function isTerminalEventInsideHost(hostEl: HTMLElement, event: Event) {
  const target = event.target
  return target instanceof Node && hostEl.contains(target)
}

export function shouldBlockDetachedTerminalPaste(hostEl: HTMLElement, event: ClipboardEvent, isAttached: boolean) {
  return !isAttached && isTerminalEventInsideHost(hostEl, event)
}

export function shouldHandleTerminalPasteEvent(hostEl: HTMLElement, event: ClipboardEvent, isAttached: boolean) {
  return isAttached && isTerminalEventInsideHost(hostEl, event)
}

export function pasteTerminalText(destination: TerminalPasteDestination, text: string) {
  if (!text) return false
  if (typeof destination.terminal.paste === 'function') {
    destination.terminal.paste(text)
    return true
  }
  if (typeof destination.terminal.input === 'function') {
    destination.terminal.input(text, true)
    return true
  }
  destination.inputHandler(text)
  return true
}

export function isXtermHelperTextareaTarget(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')
}

export function shouldUseTerminalInputFallback(options: {
  isXterm: boolean
  imeComposing: boolean
  text?: string
  terminal: TerminalTextInputTarget
}) {
  if (options.imeComposing || typeof options.terminal.input !== 'function') return false
  if (!options.isXterm) return true
  return Boolean(options.text && /[^\x00-\x7F]/.test(options.text))
}

export function shouldSuppressTerminalInputFallback(lastTerminalDataAt: number, inputEventAt: number) {
  return Math.abs(lastTerminalDataAt - inputEventAt) < TERMINAL_INPUT_FALLBACK_SUPPRESSION_MS
}
