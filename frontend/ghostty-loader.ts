type GhosttyTerminalConstructor = new (options?: Record<string, unknown>) => unknown;
type GhosttyFitAddonConstructor = new () => unknown;
type LoadedGhosttyLibrary = {
  Terminal: GhosttyTerminalConstructor;
  FitAddon: GhosttyFitAddonConstructor;
};
type GhosttyVendorModule = LoadedGhosttyLibrary & {
  init: (wasmPath: string) => Promise<unknown>;
};
type GhosttyLoaderWindow = Window & typeof globalThis & {
  FarmingRuntimePaths?: { path: (path: string) => string };
  GhosttyWeb?: LoadedGhosttyLibrary;
  __ghosttyReadyPromise?: Promise<LoadedGhosttyLibrary | null>;
};

const ghosttyWindow = window as GhosttyLoaderWindow;
let shouldLoadGhostty = false;
try {
  shouldLoadGhostty = ghosttyWindow.localStorage.getItem('farmingTerminalEngine') === 'ghostty';
} catch {
  shouldLoadGhostty = false;
}

ghosttyWindow.__ghosttyReadyPromise = shouldLoadGhostty ? (async () => {
  try {
    const runtimePaths = ghosttyWindow.FarmingRuntimePaths;
    if (!runtimePaths) throw new Error('FarmingRuntimePaths must load before the Ghostty loader');
    const vendorPath = runtimePaths.path('/vendor/ghostty-web');
    const { init, Terminal, FitAddon } = await import(`${vendorPath}/ghostty-web.js`) as GhosttyVendorModule;
    await init(`${vendorPath}/ghostty-vt.wasm`);
    ghosttyWindow.GhosttyWeb = {
      Terminal,
      FitAddon
    };
    return ghosttyWindow.GhosttyWeb;
  } catch (error) {
    console.error('Failed to initialize Ghostty terminal:', error);
    return null;
  }
})() : Promise.resolve(null);
