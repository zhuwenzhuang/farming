let shouldLoadGhostty = false;
try {
  shouldLoadGhostty = window.localStorage.getItem('farmingTerminalEngine') === 'ghostty';
} catch {
  shouldLoadGhostty = false;
}

window.__ghosttyReadyPromise = shouldLoadGhostty ? (async () => {
  try {
    const vendorPath = window.FarmingRuntimePaths
      ? window.FarmingRuntimePaths.path('/vendor/ghostty-web')
      : '/vendor/ghostty-web';
    const { init, Terminal, FitAddon } = await import(`${vendorPath}/ghostty-web.js`);
    await init(`${vendorPath}/ghostty-vt.wasm`);
    window.GhosttyWeb = {
      Terminal,
      FitAddon
    };
    return window.GhosttyWeb;
  } catch (error) {
    console.error('Failed to initialize Ghostty terminal:', error);
    return null;
  }
})() : Promise.resolve(null);
