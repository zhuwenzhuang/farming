interface FarmingTerminalBridge {
  DEFAULT_THEME: unknown;
}

interface FarmingSessionSkin {
  id: string;
  titleCase: 'lowercase';
  crtEffectsEnabled: boolean;
  sessionClassName: string;
  terminalTheme: unknown;
}

interface FarmingSkinBridge {
  getSessionSkin(themeId?: string | null, themeSettings?: { crtEffects?: boolean } | null): FarmingSessionSkin;
  applySessionSkin(documentRef: Document | null | undefined, skin: FarmingSessionSkin | null): void;
}

interface Window {
  FarmingTerminalBridge?: FarmingTerminalBridge;
  FarmingSkinBridge: FarmingSkinBridge;
}

(function attachSkinBridge(global: Window) {
  function getSessionSkin(
    themeId?: string | null,
    themeSettings?: { crtEffects?: boolean } | null,
  ): FarmingSessionSkin {
    const isTerminalTheme = !themeId || themeId === 'terminal';

    return {
      id: isTerminalTheme ? 'terminal-shell' : `${themeId}-shell`,
      titleCase: 'lowercase',
      crtEffectsEnabled: Boolean(themeSettings?.crtEffects),
      sessionClassName: isTerminalTheme ? 'skin-terminal-shell' : `skin-${themeId}-shell`,
      terminalTheme: global.FarmingTerminalBridge
        ? global.FarmingTerminalBridge.DEFAULT_THEME
        : null,
    };
  }

  function applySessionSkin(documentRef: Document | null | undefined, skin: FarmingSessionSkin | null) {
    if (!documentRef?.body) return;
    documentRef.body.dataset.sessionSkin = skin ? skin.id : '';
  }

  global.FarmingSkinBridge = { getSessionSkin, applySessionSkin };
})(window);
