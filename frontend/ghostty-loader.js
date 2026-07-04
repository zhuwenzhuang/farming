import { init, Terminal, FitAddon } from '/vendor/ghostty-web/ghostty-web.js';

window.__ghosttyReadyPromise = (async () => {
  try {
    await init('/vendor/ghostty-web/ghostty-vt.wasm');
    window.GhosttyWeb = {
      Terminal,
      FitAddon
    };
    return window.GhosttyWeb;
  } catch (error) {
    console.error('Failed to initialize Ghostty terminal:', error);
    return null;
  }
})();
