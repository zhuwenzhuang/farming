(function attachTerminalBridge(global) {
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

  async function ensureLibrary() {
    if (global.GhosttyWeb && global.GhosttyWeb.Terminal) {
      return global.GhosttyWeb;
    }

    if (global.__ghosttyReadyPromise) {
      try {
        const ghostty = await Promise.race([
          global.__ghosttyReadyPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
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

  async function createInstance(options = {}) {
    const theme = options.theme || DEFAULT_THEME;
    const baseOptions = {
      fontSize: options.fontSize || 14,
      fontFamily: options.fontFamily || DEFAULT_FONT_FAMILY,
      cursorBlink: options.cursorBlink || false,
      scrollback: options.scrollback || 20000,
    };

    const ghostty = await ensureLibrary();
    if (ghostty && ghostty.Terminal) {
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
    console.error('Ghostty terminal is unavailable; renderer hard-cut does not allow fallback.');
    return null;
  }

  global.FarmingTerminalBridge = {
    DEFAULT_THEME,
    DEFAULT_FONT_FAMILY,
    ensureLibrary,
    createInstance,
  };
})(window);
