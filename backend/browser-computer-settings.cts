import { COMPUTER_IMAGE } from '../extensions/computer/backend/computer-constants.cjs';

export const defaultBrowserComputerSettings = {
  browserExtensionEnabled: true,
  browserSource: 'system',
  browserExecutablePath: '',
  computerExtensionEnabled: false,
  computerCompatibilityMode: false,
  computerImage: COMPUTER_IMAGE,
};

export type BrowserComputerSettings = typeof defaultBrowserComputerSettings;

// Used both when opening an existing Config and when projecting a proposed change.
export function normalizeBrowserComputerSettings(settings: Record<string, unknown>): BrowserComputerSettings {
  const browserExtensionEnabled = settings.browserExtensionEnabled !== false;
  const browserSource = settings.browserSource === 'isolated' || settings.browserSource === 'extension'
    || settings.browserSource === 'desktop'
    ? settings.browserSource : 'system';
  return {
    browserExtensionEnabled,
    browserSource,
    browserExecutablePath: String(settings.browserExecutablePath || '').trim().slice(0, 2000),
    computerExtensionEnabled: settings.computerExtensionEnabled === true
      || (browserExtensionEnabled && browserSource === 'isolated'),
    computerCompatibilityMode: settings.computerCompatibilityMode === true,
    computerImage: String(settings.computerImage || '').trim().slice(0, 2000) || COMPUTER_IMAGE,
  };
}
