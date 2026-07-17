import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  SESSION_TERMINAL_FONT_DESKTOP,
  SESSION_TERMINAL_FONT_MOBILE,
  createTerminalInstance as createGhosttyTerminalInstance,
} from '@/lib/ghostty'
import type { GhosttyFitAddon, GhosttyTerminal } from '@/lib/ghostty'
import { createXtermTerminalInstance } from '@/lib/xterm'
import type { ILinkProvider } from '@xterm/xterm'
import type { TerminalSearchOptions } from '@/lib/terminal-search'

export {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  SESSION_TERMINAL_FONT_DESKTOP,
  SESSION_TERMINAL_FONT_MOBILE,
}

export type TerminalEngineName = 'xterm' | 'ghostty'
export type TerminalLinkProvider = ILinkProvider

export type FarmingTerminal = GhosttyTerminal & {
  __farmingTerminalEngine?: TerminalEngineName
  getRendererType?: () => 'pending' | 'webgl' | 'failed'
  onRendererFailure?: (handler: (error: Error) => void) => { dispose: () => void }
  getVisibleBufferBase?: () => number
  getCellMetrics?: () => { width: number; height: number } | undefined
  getScreenElement?: () => HTMLElement | null
  getTerminalElement?: () => HTMLElement | null
  syncAppearanceTheme?: () => void
  reattach?: () => void
  forceRedraw?: () => void
  clearTerminalSelection?: () => void
  clearBuffer?: () => void
  selectAll?: () => void
  search?: (
    term: string,
    direction?: 'next' | 'previous',
    options?: TerminalSearchOptions
  ) => { found: boolean; resultIndex?: number; resultCount?: number }
  clearSearch?: () => void
  refresh?: (start: number, end: number) => void
  resize?: (cols: number, rows: number) => void
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void
  onRender?: (handler: () => void) => { dispose: () => void }
  registerLinkProvider?: (linkProvider: TerminalLinkProvider) => { dispose: () => void }
}

export type FarmingFitAddon = GhosttyFitAddon

export function isXtermTerminal(terminal: FarmingTerminal) {
  return terminal.__farmingTerminalEngine === 'xterm'
}

function readPreferredTerminalEngine(): TerminalEngineName {
  if (typeof window === 'undefined') return 'xterm'
  return window.localStorage.getItem('farmingTerminalEngine') === 'ghostty'
    ? 'ghostty'
    : 'xterm'
}

export async function createTerminalInstance(options?: {
  fontSize?: number
}): Promise<{
  terminal: FarmingTerminal
  fitAddon: FarmingFitAddon
} | null> {
  const preferredEngine = readPreferredTerminalEngine()

  if (preferredEngine === 'ghostty') {
    const ghosttyResult = await createGhosttyTerminalInstance(options)
    return ghosttyResult
      ? { terminal: ghosttyResult.terminal, fitAddon: ghosttyResult.fitAddon }
      : null
  }

  return await createXtermTerminalInstance(options)
}
