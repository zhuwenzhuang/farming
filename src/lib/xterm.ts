import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

import { createTerminalClipboardProvider } from '@/lib/terminal-clipboard'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
} from '@/lib/ghostty'
import type { GhosttyFitAddon, GhosttyTerminal } from '@/lib/ghostty'

export type XtermBackedTerminal = GhosttyTerminal & {
  __farmingTerminalEngine: 'xterm'
  getVisibleBufferBase: () => number
  getCellMetrics: () => { width: number; height: number } | undefined
  getScreenElement: () => HTMLElement | null
  getTerminalElement: () => HTMLElement | null
  syncAppearanceTheme: () => void
  reattach: () => void
  forceRedraw: () => void
  clearTerminalSelection: () => void
  search: (
    term: string,
    direction?: 'next' | 'previous',
    options?: { incremental?: boolean }
  ) => { found: boolean; resultIndex?: number; resultCount?: number }
  clearSearch: () => void
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void
  onRender: (handler: () => void) => { dispose: () => void }
  registerLinkProvider: Terminal['registerLinkProvider']
  refresh?: (start: number, end: number) => void
}

const DARK_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88, 166, 255, 0.32)',
  selectionInactiveBackground: 'rgba(88, 166, 255, 0.22)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
  scrollbarSliderBackground: 'rgba(139, 148, 158, 0.32)',
  scrollbarSliderHoverBackground: 'rgba(139, 148, 158, 0.44)',
  scrollbarSliderActiveBackground: 'rgba(139, 148, 158, 0.56)',
}

function xtermThemeForCurrentAppearance() {
  if (typeof document !== 'undefined' && document.body?.dataset.appearance === 'dark') {
    return DARK_THEME
  }
  return {
    ...DEFAULT_THEME,
    selectionInactiveBackground: DEFAULT_THEME.selectionBackground,
    scrollbarSliderBackground: 'rgba(87, 96, 106, 0.24)',
    scrollbarSliderHoverBackground: 'rgba(87, 96, 106, 0.34)',
    scrollbarSliderActiveBackground: 'rgba(87, 96, 106, 0.44)',
  }
}

function applyXtermAppearance(terminal: Terminal) {
  const theme = xtermThemeForCurrentAppearance()
  terminal.options.theme = theme
  applyXtermElementAppearance(terminal, theme)
  terminal.refresh?.(0, Math.max(0, terminal.rows - 1))
}

function applyXtermElementAppearance(terminal: Terminal, theme = xtermThemeForCurrentAppearance()) {
  const element = getXtermElement(terminal)
  if (!element) return

  const background = theme.background
  const foreground = theme.foreground
  element.style.backgroundColor = background
  element.style.color = foreground
  element.querySelectorAll<HTMLElement>('.xterm-screen, .xterm-viewport, .xterm-rows, .xterm-helper-textarea').forEach(child => {
    child.style.backgroundColor = background
    if (child.classList.contains('xterm-helper-textarea')) child.style.color = foreground
  })
}

function scheduleXtermAppearanceRefresh(terminal: Terminal) {
  if (typeof window === 'undefined') return () => {}

  const refresh = () => {
    applyXtermElementAppearance(terminal)
    terminal.refresh?.(0, Math.max(0, terminal.rows - 1))
  }
  const frame = window.requestAnimationFrame(refresh)
  const timer = window.setTimeout(refresh, 80)
  return () => {
    window.cancelAnimationFrame(frame)
    window.clearTimeout(timer)
  }
}

function watchXtermAppearance(terminal: Terminal) {
  if (typeof document === 'undefined') return
  const cancelScheduledRefreshes: Array<() => void> = []
  applyXtermAppearance(terminal)
  const observer = new MutationObserver(() => {
    applyXtermAppearance(terminal)
    cancelScheduledRefreshes.push(scheduleXtermAppearanceRefresh(terminal))
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-appearance'] })
  const disposeTerminal = terminal.dispose.bind(terminal)
  terminal.dispose = () => {
    observer.disconnect()
    cancelScheduledRefreshes.forEach(cancel => cancel())
    cancelScheduledRefreshes.length = 0
    disposeTerminal()
  }
}

function getXtermElement(terminal: Terminal) {
  return terminal.element instanceof HTMLElement ? terminal.element : null
}

function getXtermScreenElement(terminal: Terminal) {
  const element = getXtermElement(terminal)
  const screen = element?.querySelector('.xterm-screen')
  return screen instanceof HTMLElement ? screen : element
}

function getXtermCellMetrics(terminal: Terminal) {
  const screen = getXtermScreenElement(terminal)
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return undefined

  const rect = screen.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined

  return {
    width: rect.width / terminal.cols,
    height: rect.height / terminal.rows,
  }
}

function getXtermViewportTopLine(terminal: Terminal) {
  return Math.max(0, terminal.buffer.active.viewportY)
}

function syncXtermViewportTopLine(terminal: Terminal, line: number) {
  void terminal
  void line
}

function xtermSearchDecorations() {
  if (typeof document !== 'undefined' && document.body?.dataset.appearance === 'dark') {
    return {
      matchBackground: '#3b3f1c',
      matchBorder: '#8a7b24',
      matchOverviewRuler: '#8a7b24',
      activeMatchBackground: '#8a5a12',
      activeMatchBorder: '#d29922',
      activeMatchColorOverviewRuler: '#d29922',
    }
  }

  return {
    matchBackground: '#fff4a3',
    matchBorder: '#d4a72c',
    matchOverviewRuler: '#d4a72c',
    activeMatchBackground: '#ffd33d',
    activeMatchBorder: '#9a6700',
    activeMatchColorOverviewRuler: '#9a6700',
  }
}

function decorateXtermTerminal(terminal: Terminal, searchAddon: SearchAddon): XtermBackedTerminal {
  const adapted = terminal as unknown as XtermBackedTerminal
  const nativeScrollToLine = terminal.scrollToLine.bind(terminal)
  let lastSearchResult: ISearchResultChangeEvent | null = null

  searchAddon.onDidChangeResults(result => {
    lastSearchResult = result
  })

  adapted.__farmingTerminalEngine = 'xterm'
  adapted.getScrollbackLength = () => Math.max(0, terminal.buffer.active.baseY)
  adapted.getVisibleBufferBase = () => getXtermViewportTopLine(terminal)
  adapted.getCellMetrics = () => getXtermCellMetrics(terminal)
  adapted.getScreenElement = () => getXtermScreenElement(terminal)
  adapted.getTerminalElement = () => getXtermElement(terminal)
  adapted.syncAppearanceTheme = () => applyXtermAppearance(terminal)
  adapted.reattach = () => {
    const element = getXtermElement(terminal)
    if (!element) return
    applyXtermElementAppearance(terminal)
    terminal.refresh?.(0, Math.max(0, terminal.rows - 1))
  }
  adapted.forceRedraw = () => {
    terminal.clearTextureAtlas()
    applyXtermElementAppearance(terminal)
    terminal.refresh?.(0, Math.max(0, terminal.rows - 1))
  }
  adapted.clearTerminalSelection = () => terminal.clearSelection()
  adapted.search = (term, direction = 'next', options = {}) => {
    const normalizedTerm = term.trim()
    if (!normalizedTerm) {
      searchAddon.clearDecorations()
      terminal.clearSelection()
      lastSearchResult = null
      return { found: false, resultIndex: 0, resultCount: 0 }
    }

    const searchOptions = {
      caseSensitive: false,
      incremental: options.incremental === true,
      decorations: xtermSearchDecorations(),
    }
    const found = direction === 'previous'
      ? searchAddon.findPrevious(normalizedTerm, searchOptions)
      : searchAddon.findNext(normalizedTerm, searchOptions)
    return {
      found,
      resultIndex: lastSearchResult?.resultIndex,
      resultCount: lastSearchResult?.resultCount,
    }
  }
  adapted.clearSearch = () => {
    searchAddon.clearDecorations()
    terminal.clearSelection()
    lastSearchResult = null
  }
  adapted.scrollToLine = (line: number) => {
    const bottomRelativeLine = Number.isFinite(line) ? Math.max(0, line) : 0
    const topLine = Math.max(0, terminal.buffer.active.baseY - bottomRelativeLine)
    nativeScrollToLine(topLine)
    syncXtermViewportTopLine(terminal, topLine)
  }
  adapted.scrollToBottom = () => {
    const topLine = Math.max(0, terminal.buffer.active.baseY)
    nativeScrollToLine(topLine)
    syncXtermViewportTopLine(terminal, topLine)
  }
  adapted.wasmTerm = {
    getCursor: () => ({
      x: terminal.buffer.active.cursorX,
      y: terminal.buffer.active.cursorY,
      visible: true,
    }),
  }

  Object.defineProperty(adapted, 'viewportY', {
    configurable: true,
    get: () => Math.max(0, terminal.buffer.active.baseY - getXtermViewportTopLine(terminal)),
    set: value => {
      const bottomRelativeLine = Number.isFinite(value) ? Math.max(0, Number(value)) : 0
      const topLine = Math.max(0, terminal.buffer.active.baseY - bottomRelativeLine)
      nativeScrollToLine(topLine)
      syncXtermViewportTopLine(terminal, topLine)
    },
  })

  return adapted
}

export async function createXtermTerminalInstance(options?: {
  fontSize?: number
}): Promise<{
  terminal: XtermBackedTerminal
  fitAddon: GhosttyFitAddon
}> {
  const fontSize = options?.fontSize ?? DEFAULT_FONT_SIZE
  const terminal = new Terminal({
    allowProposedApi: true,
    altClickMovesCursor: false,
    cols: 80,
    convertEol: true,
    cursorBlink: false,
    cursorStyle: 'block',
    drawBoldTextInBrightColors: false,
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize,
    lineHeight: 1.25,
    linkHandler: {
      allowNonHttpProtocols: false,
      activate: (_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer')
      },
    },
    macOptionClickForcesSelection: true,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: false,
    rows: 30,
    scrollback: 5000,
    scrollOnEraseInDisplay: true,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    theme: xtermThemeForCurrentAppearance(),
    wordSeparator: ' ()[]{}\'"`\u2500',
    windowOptions: {
      getCellSizePixels: true,
      getWinSizeChars: true,
      getWinSizePixels: true,
    },
  })
  const searchAddon = new SearchAddon({ highlightLimit: 2000 })
  terminal.loadAddon(new ClipboardAddon(undefined, createTerminalClipboardProvider()))
  terminal.loadAddon(searchAddon)
  watchXtermAppearance(terminal)

  return {
    terminal: decorateXtermTerminal(terminal, searchAddon),
    fitAddon: new FitAddon() as unknown as GhosttyFitAddon,
  }
}
