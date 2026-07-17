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
