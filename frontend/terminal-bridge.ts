type TerminalTheme = Record<string, string>;
type TerminalOptions = Record<string, unknown>;
type TerminalDisposable = { dispose?: () => void };
type TerminalInstance = {
  loadAddon: (addon: unknown) => void;
};
type TerminalConstructor = new (options: TerminalOptions) => TerminalInstance;
type FitAddonInstance = TerminalDisposable & { fit?: () => void };
type FitAddonConstructor = new () => FitAddonInstance;
type WebglAddonInstance = TerminalDisposable & {
  onContextLoss?: (listener: () => void) => void;
};
type WebglAddonConstructor = new () => WebglAddonInstance;
type GhosttyLibrary = {
  Terminal: TerminalConstructor;
  FitAddon: FitAddonConstructor;
};
type TerminalBridgeOptions = {
  theme?: TerminalTheme;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  disableStdin?: boolean;
  scrollback?: number;
  smoothScrollDuration?: number;
  requireWebgl?: boolean;
  onWebglContextLoss?: () => void;
};
type XtermLibrary = {
  Terminal: TerminalConstructor;
  FitAddon: FitAddonConstructor;
};
type TerminalBundle = {
  kind: 'ghostty' | 'xterm' | 'xterm-webgl';
  terminal: TerminalInstance;
  fitAddon: FitAddonInstance;
  webglAddon?: WebglAddonInstance;
};
type FarmingTerminalBridgeApi = {
  DEFAULT_THEME: TerminalTheme;
  DEFAULT_FONT_FAMILY: string;
  preferredEngine: () => 'ghostty' | 'xterm';
  ensureLibrary: () => Promise<GhosttyLibrary | null>;
  ensureGhosttyLibrary: () => Promise<GhosttyLibrary | null>;
  ensureXtermLibrary: () => XtermLibrary | null;
  ensureXtermWebglLibrary: () => WebglAddonConstructor | null;
  supportsWebgl2: () => boolean;
  createInstance: (options?: TerminalBridgeOptions) => Promise<TerminalBundle | null>;
};
type TerminalBridgeGlobal = Window & typeof globalThis & {
  Terminal?: TerminalConstructor;
  FitAddon?: { FitAddon?: FitAddonConstructor };
  WebglAddon?: { WebglAddon?: WebglAddonConstructor };
  GhosttyWeb?: GhosttyLibrary;
  __ghosttyReadyPromise?: Promise<GhosttyLibrary | null>;
  FarmingTerminalBridge?: FarmingTerminalBridgeApi;
};

(function attachTerminalBridge(global: TerminalBridgeGlobal) {

  const DEFAULT_THEME = {
    background: '#050505',
    foreground: '#00ff41',
    cursor: '#00ff41',
    cursorAccent: '#050505',
    selectionBackground: 'rgba(0, 255, 65, 0.28)',
    black: '#0b160d',
    red: '#ff4d4d',
    green: '#39ff88',
    yellow: '#f2ff66',
    blue: '#59c3ff',
    magenta: '#ff5fd2',
    cyan: '#7dfff6',
    white: '#d4ffe7',
    brightBlack: '#24512d',
    brightRed: '#ff7a7a',
    brightGreen: '#69ffb2',
    brightYellow: '#f7ff8f',
    brightBlue: '#8ed6ff',
    brightMagenta: '#ff8de1',
    brightCyan: '#a9fff9',
    brightWhite: '#f3fff8',
  };
  const DEFAULT_FONT_FAMILY = [
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
  ].join(', ');

  function preferredEngine(): 'ghostty' | 'xterm' {
    try {
      return global.localStorage.getItem('farmingTerminalEngine') === 'ghostty'
        ? 'ghostty'
        : 'xterm';
    } catch {
      return 'xterm';
    }
  }

  function ensureXtermLibrary(): XtermLibrary | null {
    if (global.Terminal && global.FitAddon && global.FitAddon.FitAddon) {
      return {
        Terminal: global.Terminal,
        FitAddon: global.FitAddon.FitAddon,
      };
    }
    return null;
  }

  function ensureXtermWebglLibrary(): WebglAddonConstructor | null {
    if (global.WebglAddon && global.WebglAddon.WebglAddon) {
      return global.WebglAddon.WebglAddon;
    }
    return null;
  }

  function supportsWebgl2(): boolean {
    try {
      const canvas = global.document && global.document.createElement
        ? global.document.createElement('canvas')
        : null;
      const context = canvas && canvas.getContext('webgl2');
      if (!context) return false;
      context.getExtension?.('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  async function ensureGhosttyLibrary(): Promise<GhosttyLibrary | null> {
    if (global.GhosttyWeb && global.GhosttyWeb.Terminal) {
      return global.GhosttyWeb;
    }

    if (global.__ghosttyReadyPromise) {
      try {
        const ghostty = await Promise.race([
          global.__ghosttyReadyPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (ghostty && ghostty.Terminal) {
          return ghostty;
        }
      } catch (error) {
        console.error('Ghostty loader promise failed:', error);
      }
    }

    return null;
  }

  async function createInstance(options: TerminalBridgeOptions = {}): Promise<TerminalBundle | null> {
    const theme = options.theme || DEFAULT_THEME;
    const baseOptions = {
      fontSize: options.fontSize || 14,
      fontFamily: options.fontFamily || DEFAULT_FONT_FAMILY,
      cursorBlink: options.cursorBlink || false,
      disableStdin: options.disableStdin === true,
      scrollback: options.scrollback || 20000,
    };

    if (!options.requireWebgl && preferredEngine() === 'ghostty') {
      const ghostty = await ensureGhosttyLibrary();
      if (!ghostty || !ghostty.Terminal) {
        console.error('Ghostty terminal is unavailable.');
        return null;
      }
      return {
        kind: 'ghostty',
        terminal: new ghostty.Terminal({
          ...baseOptions,
          theme,
          smoothScrollDuration: options.smoothScrollDuration || 120,
          disableStdin: options.disableStdin !== undefined ? options.disableStdin : true,
        }),
        fitAddon: new ghostty.FitAddon(),
      };
    }

    const xterm = ensureXtermLibrary();
    if (!xterm) {
      console.error('xterm terminal is unavailable.');
      return null;
    }
    const terminal = new xterm.Terminal({
        ...baseOptions,
        allowProposedApi: true,
        altClickMovesCursor: false,
        cols: 80,
        convertEol: true,
        cursorStyle: 'block',
        drawBoldTextInBrightColors: false,
        lineHeight: 1.18,
        macOptionClickForcesSelection: true,
        minimumContrastRatio: 4.5,
        rows: 30,
        scrollOnEraseInDisplay: true,
        scrollOnUserInput: true,
        smoothScrollDuration: 0,
        theme,
      });
    const bundle: TerminalBundle = {
      kind: 'xterm',
      terminal,
      fitAddon: new xterm.FitAddon(),
    };

    if (options.requireWebgl) {
      const WebglAddon = ensureXtermWebglLibrary();
      if (!WebglAddon) {
        throw new Error('Farming CRT requires the xterm WebGL addon.');
      }
      if (!supportsWebgl2()) {
        throw new Error('Farming CRT requires WebGL2 hardware acceleration.');
      }
      // Keep xterm on its default disposable framebuffer. Preserving every frame
      // makes terminal input compete with CRT post-processing for GPU bandwidth.
      const webglAddon = new WebglAddon();
      if (webglAddon.onContextLoss && options.onWebglContextLoss) {
        webglAddon.onContextLoss(options.onWebglContextLoss);
      }
      terminal.loadAddon(webglAddon);
      bundle.kind = 'xterm-webgl';
      bundle.webglAddon = webglAddon;
    }

    return bundle;
  }

  global.FarmingTerminalBridge = {
    DEFAULT_THEME,
    DEFAULT_FONT_FAMILY,
    preferredEngine,
    ensureLibrary: ensureGhosttyLibrary,
    ensureGhosttyLibrary,
    ensureXtermLibrary,
    ensureXtermWebglLibrary,
    supportsWebgl2,
    createInstance,
  };
})(window as TerminalBridgeGlobal);
