import {
  normalizeBrowserComputerSettings,
  type BrowserComputerSettings,
} from './browser-computer-settings.cjs';
import { SettingsMutationResponseError, responseError } from './settings-mutation-error.cjs';

export interface BrowserComputerRuntimePorts {
  probeBrowser(settings: BrowserComputerSettings): Promise<{
    runtimeCapability?: { error?: unknown; kind?: unknown } | null;
  }>;
  probeComputer(settings: BrowserComputerSettings): Promise<{
    dockerAvailable?: boolean;
    error?: unknown;
    imageReady?: boolean;
  }>;
  refreshBrowserCapability(): Promise<unknown>;
  refreshComputerCapability(): Promise<unknown>;
  resetAllComputerContainers(): Promise<unknown>;
  stopAllBrowsers(): Promise<unknown>;
  stopAllComputers(): Promise<unknown>;
}

// The caller commits the original patch once, merged with the latest Config.
// Only effective changes to these two plugins can operate on their resources.
export class BrowserComputerSettingsLifecycle {
  private busy = false;
  private readonly ports: BrowserComputerRuntimePorts;

  constructor(ports: BrowserComputerRuntimePorts) {
    this.ports = ports;
  }

  async apply(current: Record<string, unknown>, patch: Record<string, unknown>, commit: () => Promise<void>) {
    if (this.busy) {
      throw new SettingsMutationResponseError(
        'Browser or Computer settings are changing. Refresh plugin settings and try again.',
        'PLUGIN_SETTINGS_BUSY', 409,
      );
    }
    const before = normalizeBrowserComputerSettings(current);
    const after = normalizeBrowserComputerSettings({ ...current, ...patch });
    if (patch.computerExtensionEnabled === false && after.computerExtensionEnabled) {
      throw new SettingsMutationResponseError(
        'Disable the isolated Browser or select another Browser source before disabling Computer.',
        'COMPUTER_REQUIRED_BY_BROWSER', 409,
      );
    }
    const browserSelectionChanged = before.browserSource !== after.browserSource
      || before.browserExecutablePath !== after.browserExecutablePath;
    const browserChanged = browserSelectionChanged || before.browserExtensionEnabled !== after.browserExtensionEnabled;
    const computerRuntimeChanged = before.computerImage !== after.computerImage
      || before.computerCompatibilityMode !== after.computerCompatibilityMode;
    const computerChanged = computerRuntimeChanged || before.computerExtensionEnabled !== after.computerExtensionEnabled;

    this.busy = true;
    try {
      if (browserSelectionChanged || (browserChanged && after.browserExtensionEnabled)) {
        const { runtimeCapability } = await this.ports.probeBrowser(after);
        if (!runtimeCapability || runtimeCapability.error) {
          throw new SettingsMutationResponseError(
            String(runtimeCapability?.error || 'Choose a local Chromium browser or prepare the isolated Browser runtime'),
            'BROWSER_EXECUTABLE_NOT_FOUND', 400,
          );
        }
      }
      if (computerRuntimeChanged || (computerChanged && after.computerExtensionEnabled)) {
        await this.validateComputer(after);
      }
      if (browserChanged && before.browserExtensionEnabled) {
        try {
          await this.ports.stopAllBrowsers();
        } catch (caught) {
          throw responseError(caught, 'Browser extension could not be disabled', 'BROWSER_DISABLE_FAILED', 500);
        }
      }
      if (computerChanged && before.computerExtensionEnabled) {
        try {
          if (computerRuntimeChanged) await this.ports.resetAllComputerContainers();
          else await this.ports.stopAllComputers();
        } catch (caught) {
          throw responseError(caught, 'Computer extension could not be disabled', 'COMPUTER_DISABLE_FAILED', 500);
        }
      }
      await commit();
      if (browserChanged) await this.ports.refreshBrowserCapability();
      if (computerChanged) await this.ports.refreshComputerCapability();
    } finally {
      this.busy = false;
    }
  }

  private async validateComputer(settings: BrowserComputerSettings) {
    let probe;
    try {
      probe = await this.ports.probeComputer(settings);
    } catch (caught) {
      throw responseError(caught, 'Computer configuration is invalid', 'COMPUTER_CONFIGURATION_INVALID', 400);
    }
    if (settings.computerExtensionEnabled && !probe.imageReady) {
      throw new SettingsMutationResponseError(
        String(probe.error || 'Prepare the pinned Computer runtime before enabling this plugin'),
        probe.dockerAvailable ? 'COMPUTER_IMAGE_NOT_READY' : 'COMPUTER_DOCKER_NOT_AVAILABLE', 400,
      );
    }
  }
}
