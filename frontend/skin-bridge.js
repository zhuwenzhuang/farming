// Generated from TypeScript. Do not edit.
"use strict";
(function attachSkinBridge(global) {
    function getSessionSkin(themeId, themeSettings) {
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
    function applySessionSkin(documentRef, skin) {
        if (!documentRef?.body)
            return;
        documentRef.body.dataset.sessionSkin = skin ? skin.id : '';
    }
    global.FarmingSkinBridge = { getSessionSkin, applySessionSkin };
})(window);
