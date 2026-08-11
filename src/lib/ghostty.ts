import { appPath } from '@/lib/base-path'
import type { TerminalSearchOptions } from '@/lib/terminal-search'
import { APPEARANCE_THEMES } from '../../shared/appearance-themes'

/**
 * Ghostty-web terminal loader and instance factory.
 * Ported from frontend/ghostty-loader.js + frontend/terminal-bridge.js.
 */

export interface GhosttyTerminal {
  open(container: HTMLElement): void
  input?: (data: string, wasUserInput?: boolean) => void
  paste?: (data: string) => void
  search?: (
    term: string,
    direction?: 'next' | 'previous',
    options?: TerminalSearchOptions
  ) => { found: boolean; resultIndex?: number; resultCount?: number }
  clearSearch?: () => void
  write(data: string, callback?: () => void): void
  reset(): void
  dispose(): void
  focus(): void
  select?(col: number, row: number, length: number): void
  cols?: number
  rows?: number
  options?: {
    fontSize?: number
  }
  viewportY?: number
  getScrollbackLength?: () => number
  scrollToLine?: (line: number) => void
  scrollToBottom?: () => void
  getSelection(): string
  getSelectionPosition?: () => {
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | undefined
  buffer?: {
    active?: {
      length: number
      getLine: (row: number) =>
        | {
            isWrapped?: boolean
            length?: number
            getCell?: (col: number) =>
              | {
                  getChars?: () => string
                  getCode?: () => number
                }
              | undefined
          }
        | undefined
    }
  }
  renderer?: {
    cursorVisible?: boolean
    getMetrics?: () => { width: number; height: number; baseline?: number }
    render?: (
      wasmTerm: NonNullable<GhosttyTerminal['wasmTerm']>,
      forceFullRedraw?: boolean,
      viewportY?: number,
      terminal?: GhosttyTerminal,
      scrollbarOpacity?: number,
    ) => void
    getCanvas?: () => HTMLCanvasElement
  }
  wasmTerm?: {
    getCursor?: () => { x: number; y: number; visible?: boolean }
  }
  loadAddon(addon: GhosttyFitAddon): void
  onData: (handler: (data: string) => void) => { dispose: () => void }
  onResize: (handler: (size: { cols: number; rows: number }) => void) => { dispose: () => void }
  onTitleChange?: (handler: (title: string) => void) => { dispose: () => void }
  onSelectionChange?: (handler: () => void) => { dispose: () => void }
  onCursorMove?: (handler: () => void) => { dispose: () => void }
  onKey?: (handler: () => void) => { dispose: () => void }
  onScroll?: (handler: (viewportY: number) => void) => { dispose: () => void }
}

export interface GhosttyFitAddon {
  fit(): void
  proposeDimensions(): { cols: number; rows: number } | undefined
  dispose(): void
}

interface GhosttyModule {
  Terminal: new (opts: Record<string, unknown>) => GhosttyTerminal
  FitAddon: new () => GhosttyFitAddon
}

export const DEFAULT_THEME = APPEARANCE_THEMES.light.terminal

export const DEFAULT_FONT_FAMILY = [
  '"JetBrains Mono"',
  '"SF Mono"',
  'Menlo',
  'Monaco',
  '"Cascadia Mono"',
  '"Segoe UI Mono"',
  '"Sarasa Mono SC"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Noto Sans Mono CJK SC"',
  '"Microsoft YaHei UI"',
  'monospace',
].join(', ')

export const DEFAULT_FONT_SIZE = 12
export const SESSION_TERMINAL_FONT_DESKTOP = DEFAULT_FONT_SIZE
export const SESSION_TERMINAL_FONT_MOBILE = 11

let ghosttyModule: GhosttyModule | null = null
let loadPromise: Promise<GhosttyModule | null> | null = null

export async function initGhostty(): Promise<GhosttyModule | null> {
  if (ghosttyModule) return ghosttyModule

  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      // Use variable to prevent Vite static import analysis
      const base = appPath('/vendor/ghostty-web')
      const modPath = `${base}/ghostty-web.js`
      const wasmPath = `${base}/ghostty-vt.wasm`
      const mod = await import(/* @vite-ignore */ modPath)
      await mod.init(wasmPath)
      ghosttyModule = {
        Terminal: mod.Terminal,
        FitAddon: mod.FitAddon,
      }
      return ghosttyModule
    } catch (error) {
      console.error('Failed to initialize Ghostty terminal:', error)
      return null
    }
  })()

  return loadPromise
}

export async function createTerminalInstance(options?: {
  fontSize?: number
}): Promise<{
  terminal: GhosttyTerminal
  fitAddon: GhosttyFitAddon
} | null> {
  const mod = await initGhostty()
  if (!mod) return null

  const fontSize = options?.fontSize ?? DEFAULT_FONT_SIZE

  const terminal = new mod.Terminal({
    theme: DEFAULT_THEME,
    fontSize,
    fontFamily: DEFAULT_FONT_FAMILY,
    cursorBlink: false,
    smoothScrollDuration: 120,
    scrollback: 5000,
  })

  const fitAddon = new mod.FitAddon()
  return { terminal, fitAddon }
}
