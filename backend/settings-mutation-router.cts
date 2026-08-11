const express = require('express');

interface ExpressRequest {
  body?: unknown;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface SettingsRecord {
  [key: string]: unknown;
  agentHomes?: unknown;
  browserExecutablePath?: unknown;
  browserExtensionEnabled?: unknown;
  browserExternalCdpUrl?: unknown;
  browserSource?: unknown;
  computerCompatibilityMode?: unknown;
  computerExtensionEnabled?: unknown;
  computerImage?: unknown;
}

interface BrowserProbe {
  runtimeCapability?: { error?: unknown; kind?: unknown } | null;
}

interface ComputerProbe {
  dockerAvailable?: boolean;
  error?: unknown;
  imageReady?: boolean;
}

interface SettingsMutationPorts {
  getSettings(): SettingsRecord;
  invalidateAgentExtensionInventory(): void;
  invalidateAgentSessionInventory(): void;
  normalizeAgentHomes(value: unknown): SettingsRecord['agentHomes'];
  probeBrowser(settings: {
    browserExecutablePath?: string;
    browserExternalCdpUrl?: string;
    browserSource?: string;
  }): Promise<BrowserProbe>;
  probeComputer(settings: SettingsRecord): Promise<ComputerProbe>;
  publishSettingsMetadata(): void;
  refreshBrowserCapability(): Promise<unknown>;
  refreshComputerCapability(): Promise<unknown>;
  resetAllComputerContainers(): Promise<unknown>;
  stopAllBrowsers(): Promise<unknown>;
  stopAllComputers(): Promise<unknown>;
  updateSettings(patch: SettingsRecord): void;
}

interface SettingsMutationResult {
  settings: SettingsRecord;
  success: true;
}

interface ErrorRecord extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
}

class SettingsMutationResponseError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SettingsMutationResponseError';
    this.code = code;
    this.status = status;
  }
}

const expressFactory = express as ExpressFactory;
const BROWSER_CONFIGURATION_KEYS = [
  'browserSource',
  'browserExecutablePath',
  'browserExternalCdpUrl',
] as const;
const COMPUTER_CONFIGURATION_KEYS = [
  'computerImage',
  'computerCompatibilityMode',
] as const;
const PROTECTED_SETTINGS_KEYS = [
  'mainPageSessionKeys',
  'projectWorkspaces',
  'pinnedProjectWorkspaces',
] as const;

function caughtError(value: unknown): ErrorRecord {
  if (value instanceof Error) return value as ErrorRecord;
  const normalized = new Error(String(value)) as ErrorRecord;
  if (value && typeof value === 'object') Object.assign(normalized, value);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function owns(record: SettingsRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function responseError(
  caught: unknown,
  fallbackMessage: string,
  fallbackCode: string,
  fallbackStatus: number,
): SettingsMutationResponseError {
  const error = caughtError(caught);
  const status = Number(error.status || error.statusCode);
  return new SettingsMutationResponseError(
    error.message || fallbackMessage,
    error.code || fallbackCode,
    Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallbackStatus,
    { cause: caught },
  );
}

/**
 * Config settings remain authoritative. A request validates Agent Homes and
 * desired Browser/Computer capabilities, applies the existing Browser then
 * Computer cleanup order, commits settings once, and refreshes projections.
 *
 * This extraction deliberately adds no cross-request admission: independent
 * requests keep the Server's previous concurrency behavior, and an unbounded
 * owning port can stall only its own request. A failed or timed-out port is not
 * replayed or compensated here. A later request starts from freshly read
 * settings and the owning Resource manager reconciles its own external state.
 */
class SettingsMutationCoordinator {
  private readonly ports: SettingsMutationPorts;

  constructor(ports: SettingsMutationPorts) {
    this.ports = ports;
  }

  async mutate(rawPatch: unknown): Promise<SettingsMutationResult> {
    const settingsPatch: SettingsRecord = rawPatch && typeof rawPatch === 'object'
      ? { ...(rawPatch as Record<string, unknown>) }
      : {};
    PROTECTED_SETTINGS_KEYS.forEach(key => delete settingsPatch[key]);
    const currentSettings = this.ports.getSettings();
    const requestsIsolatedBrowser = (
      owns(settingsPatch, 'browserExtensionEnabled')
        ? settingsPatch.browserExtensionEnabled === true
        : currentSettings.browserExtensionEnabled === true
    ) && (
      optionalString(settingsPatch.browserSource) ?? currentSettings.browserSource
    ) === 'isolated';
    if (requestsIsolatedBrowser) settingsPatch.computerExtensionEnabled = true;

    const changesAgentHomes = owns(settingsPatch, 'agentHomes');
    if (changesAgentHomes) {
      try {
        settingsPatch.agentHomes = this.ports.normalizeAgentHomes(settingsPatch.agentHomes);
      } catch (caught) {
        throw responseError(
          caught,
          'Agent Home configuration is invalid',
          'AGENT_HOME_INVALID',
          400,
        );
      }
    }

    const changesBrowserExtension = owns(settingsPatch, 'browserExtensionEnabled');
    const changesBrowserConfiguration = BROWSER_CONFIGURATION_KEYS.some(key => owns(settingsPatch, key));
    let changesComputerExtension = owns(settingsPatch, 'computerExtensionEnabled');
    const changesComputerConfiguration = COMPUTER_CONFIGURATION_KEYS.some(key => owns(settingsPatch, key));
    const browserExtensionEnabled = settingsPatch.browserExtensionEnabled === true;
    const desiredBrowserEnabled = changesBrowserExtension
      ? browserExtensionEnabled
      : currentSettings.browserExtensionEnabled === true;
    let computerExtensionEnabled = settingsPatch.computerExtensionEnabled === true;
    let desiredComputerEnabled = changesComputerExtension
      ? computerExtensionEnabled
      : currentSettings.computerExtensionEnabled === true;

    if ((changesBrowserExtension && browserExtensionEnabled) || changesBrowserConfiguration) {
      const probe = await this.ports.probeBrowser({
        browserSource: optionalString(settingsPatch.browserSource)
          ?? optionalString(currentSettings.browserSource),
        browserExecutablePath: optionalString(settingsPatch.browserExecutablePath)
          ?? optionalString(currentSettings.browserExecutablePath),
        browserExternalCdpUrl: optionalString(settingsPatch.browserExternalCdpUrl)
          ?? optionalString(currentSettings.browserExternalCdpUrl),
      });
      if (
        (changesBrowserConfiguration || desiredBrowserEnabled)
        && (!probe.runtimeCapability || probe.runtimeCapability.error)
      ) {
        throw new SettingsMutationResponseError(
          String(probe.runtimeCapability?.error
            || 'Choose a local Chromium browser or prepare the isolated Browser runtime'),
          'BROWSER_EXECUTABLE_NOT_FOUND',
          400,
        );
      }
      if (desiredBrowserEnabled && probe.runtimeCapability?.kind === 'isolated-computer') {
        settingsPatch.computerExtensionEnabled = true;
        changesComputerExtension = true;
        computerExtensionEnabled = true;
        desiredComputerEnabled = true;
      }
    }

    if (
      currentSettings.browserExtensionEnabled === true
      && ((changesBrowserExtension && !browserExtensionEnabled) || changesBrowserConfiguration)
    ) {
      try {
        await this.ports.stopAllBrowsers();
      } catch (caught) {
        throw responseError(caught, 'Browser extension could not be disabled', 'BROWSER_DISABLE_FAILED', 500);
      }
    }

    if ((changesComputerExtension && computerExtensionEnabled) || changesComputerConfiguration) {
      try {
        const probe = await this.ports.probeComputer({ ...currentSettings, ...settingsPatch });
        if (desiredComputerEnabled && !probe.imageReady) {
          throw Object.assign(new Error(
            String(probe.error || 'Prepare the pinned Computer runtime before enabling this plugin'),
          ), {
            code: probe.dockerAvailable ? 'COMPUTER_IMAGE_NOT_READY' : 'COMPUTER_DOCKER_NOT_AVAILABLE',
            status: 400,
          });
        }
      } catch (caught) {
        throw responseError(caught, 'Computer configuration is invalid', 'COMPUTER_CONFIGURATION_INVALID', 400);
      }
    }

    if (
      currentSettings.computerExtensionEnabled === true
      && ((changesComputerExtension && !computerExtensionEnabled) || changesComputerConfiguration)
    ) {
      try {
        if (changesComputerConfiguration) await this.ports.resetAllComputerContainers();
        else await this.ports.stopAllComputers();
      } catch (caught) {
        throw responseError(caught, 'Computer extension could not be disabled', 'COMPUTER_DISABLE_FAILED', 500);
      }
    }

    try {
      this.ports.updateSettings(settingsPatch);
    } catch (caught) {
      const error = caughtError(caught);
      if (error.code?.startsWith('AGENT_HOME_')) {
        throw responseError(
          caught,
          'Agent Home configuration conflicts with persisted Agent metadata',
          error.code,
          409,
        );
      }
      throw caught;
    }

    if (changesBrowserExtension || changesBrowserConfiguration) {
      await this.ports.refreshBrowserCapability();
    }
    if (changesComputerExtension || changesComputerConfiguration) {
      await this.ports.refreshComputerCapability();
    }
    if (changesAgentHomes) {
      this.ports.invalidateAgentSessionInventory();
      this.ports.invalidateAgentExtensionInventory();
    }
    return { success: true, settings: this.ports.getSettings() };
  }
}

function createSettingsMutationRouter(ports: SettingsMutationPorts): ExpressRouter {
  const router = expressFactory.Router();
  const coordinator = new SettingsMutationCoordinator(ports);
  router.post('/', expressFactory.json(), async (req, res) => {
    try {
      res.json(await coordinator.mutate(req.body));
      ports.publishSettingsMetadata();
    } catch (caught) {
      if (!(caught instanceof SettingsMutationResponseError)) throw caught;
      res.status(caught.status).json({ error: caught.message, code: caught.code });
    }
  });
  return router;
}

export {
  SettingsMutationCoordinator,
  SettingsMutationResponseError,
  createSettingsMutationRouter,
  type SettingsMutationPorts,
  type SettingsMutationResult,
};
