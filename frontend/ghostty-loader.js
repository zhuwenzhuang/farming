// Generated from TypeScript. Do not edit.
"use strict";
const ghosttyWindow = window;
let shouldLoadGhostty = false;
try {
    shouldLoadGhostty = ghosttyWindow.localStorage.getItem('farmingTerminalEngine') === 'ghostty';
}
catch {
    shouldLoadGhostty = false;
}
ghosttyWindow.__ghosttyReadyPromise = shouldLoadGhostty ? (async () => {
    try {
        const runtimePaths = ghosttyWindow.FarmingRuntimePaths;
        if (!runtimePaths)
            throw new Error('FarmingRuntimePaths must load before the Ghostty loader');
        const vendorPath = runtimePaths.path('/vendor/ghostty-web');
        const { init, Terminal, FitAddon } = await import(`${vendorPath}/ghostty-web.js`);
        await init(`${vendorPath}/ghostty-vt.wasm`);
        ghosttyWindow.GhosttyWeb = {
            Terminal,
            FitAddon
        };
        return ghosttyWindow.GhosttyWeb;
    }
    catch (error) {
        console.error('Failed to initialize Ghostty terminal:', error);
        return null;
    }
})() : Promise.resolve(null);
