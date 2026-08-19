import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  SESSION_TERMINAL_FONT_DESKTOP,
  SESSION_TERMINAL_FONT_MOBILE,
  createXtermTerminalInstance,
} from '@/lib/xterm'
import type { XtermBackedTerminal, XtermFitAddon } from '@/lib/xterm'
import type { ILinkProvider } from '@xterm/xterm'

export {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  SESSION_TERMINAL_FONT_DESKTOP,
  SESSION_TERMINAL_FONT_MOBILE,
}

export type TerminalLinkProvider = ILinkProvider
export type FarmingTerminal = XtermBackedTerminal
export type FarmingFitAddon = XtermFitAddon

export async function createTerminalInstance(options?: {
  fontSize?: number
}): Promise<{
  terminal: FarmingTerminal
  fitAddon: FarmingFitAddon
} | null> {
  return await createXtermTerminalInstance(options)
}
